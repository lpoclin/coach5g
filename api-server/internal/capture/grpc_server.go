// Package capture implements the gRPC server that receives packet streams
// from capture-agent DaemonSets and fans them out to WebSocket subscribers.
package capture

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/lpoclin/coach5g/api-server/internal/pb"
)

// Packet is a decoded network packet forwarded to WebSocket subscribers.
type Packet struct {
	TimestampNs   int64
	SrcIP         string
	DstIP         string
	SrcPort       uint32
	DstPort       uint32
	Protocol      string
	Length        uint32
	Info          string
	Raw           []byte
	InterfaceName string
	PodName       string
	Namespace     string
	Node          string
}

// SessionKey uniquely identifies a capture session.
type SessionKey struct {
	Node    string
	PodName string
	Iface   string
}

// wildcardKey matches packets for any node for a given pod+interface.
type wildcardKey struct {
	PodName string
	Iface   string
}

// Subscriber receives packets for a session.
type Subscriber chan []Packet

// statEntry records one batch of packets received at a point in time.
type statEntry struct {
	ts    time.Time
	pkts  int
	bytes int64
}

// PktEntry stores the raw bytes and timestamp for a single captured packet.
type PktEntry struct {
	TsNs int64
	Raw  []byte
}

// pktRingBuf is a fixed-capacity circular buffer of PktEntry, one per pod+interface.
type pktRingBuf struct {
	mu       sync.RWMutex
	entries  []PktEntry
	head     int
	size     int
	capacity int
	linkType uint32 // pcap link-layer type (1 = Ethernet, default)
}

func newPktRingBuf(cap int) *pktRingBuf {
	return &pktRingBuf{entries: make([]PktEntry, cap), capacity: cap, linkType: 1}
}

func (r *pktRingBuf) push(e PktEntry) {
	r.mu.Lock()
	r.entries[r.head] = e
	r.head = (r.head + 1) % r.capacity
	if r.size < r.capacity {
		r.size++
	}
	r.mu.Unlock()
}

// getByTs returns the raw bytes for the packet with the given nanosecond timestamp.
func (r *pktRingBuf) getByTs(tsNs int64) ([]byte, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for i := 0; i < r.size; i++ {
		idx := (r.head - 1 - i + r.capacity) % r.capacity
		if r.entries[idx].TsNs == tsNs {
			out := make([]byte, len(r.entries[idx].Raw))
			copy(out, r.entries[idx].Raw)
			return out, true
		}
	}
	return nil, false
}

// getAfterTs returns all packets with tsNs >= cutoffNs, in insertion order.
func (r *pktRingBuf) getAfterTs(cutoffNs int64) []PktEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []PktEntry
	for i := r.size - 1; i >= 0; i-- {
		idx := (r.head - 1 - i + r.capacity) % r.capacity
		if r.entries[idx].TsNs >= cutoffNs {
			e := r.entries[idx]
			cp := make([]byte, len(e.Raw))
			copy(cp, e.Raw)
			out = append(out, PktEntry{TsNs: e.TsNs, Raw: cp})
		}
	}
	return out
}

// getInRange returns all packets with startNs <= tsNs <= endNs, in insertion order.
func (r *pktRingBuf) getInRange(startNs, endNs int64) []PktEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []PktEntry
	for i := r.size - 1; i >= 0; i-- {
		idx := (r.head - 1 - i + r.capacity) % r.capacity
		ts := r.entries[idx].TsNs
		if ts >= startNs && ts <= endNs {
			e := r.entries[idx]
			cp := make([]byte, len(e.Raw))
			copy(cp, e.Raw)
			out = append(out, PktEntry{TsNs: e.TsNs, Raw: cp})
		}
	}
	return out
}

// Server implements pb.CaptureServiceServer and fans packets to subscribers.
type Server struct {
	pb.UnimplementedCaptureServiceServer
	mu           sync.RWMutex
	subs         map[SessionKey][]Subscriber
	wildcardSubs map[wildcardKey][]Subscriber

	// Rolling traffic stats — 3-second sliding window, keyed by pod+interface
	statsMu  sync.Mutex
	statsMap map[wildcardKey][]statEntry

	// Packet ring buffer for decode queries (stores raw bytes, keyed by pod+interface)
	pktRingMu sync.RWMutex
	pktRings  map[wildcardKey]*pktRingBuf

	// Index maps populated from incoming PacketBatch metadata.
	// nodeIndex:    {pod,iface} → node name
	// agentIPIndex: node name  → capture-agent control address (podIP:9998)
	indexMu      sync.RWMutex
	nodeIndex    map[wildcardKey]string
	agentIPIndex map[string]string

	// Lazy gRPC clients to capture-agent control servers, keyed by addr.
	agentClientsMu sync.Mutex
	agentClients   map[string]*grpc.ClientConn
}

const PktRingCap = 10_000

func NewServer() *Server {
	return &Server{
		subs:         make(map[SessionKey][]Subscriber),
		wildcardSubs: make(map[wildcardKey][]Subscriber),
		statsMap:     make(map[wildcardKey][]statEntry),
		pktRings:     make(map[wildcardKey]*pktRingBuf),
		nodeIndex:    make(map[wildcardKey]string),
		agentIPIndex: make(map[string]string),
		agentClients: make(map[string]*grpc.ClientConn),
	}
}

// recordStats appends a stat entry and prunes entries older than 3 seconds.
func (s *Server) recordStats(key wildcardKey, pkts []Packet) {
	var totalBytes int64
	for _, p := range pkts {
		totalBytes += int64(p.Length)
	}
	entry := statEntry{ts: time.Now(), pkts: len(pkts), bytes: totalBytes}
	cutoff := entry.ts.Add(-3 * time.Second)

	s.statsMu.Lock()
	prev := s.statsMap[key]
	// prune in-place then append
	keep := prev[:0]
	for _, e := range prev {
		if e.ts.After(cutoff) {
			keep = append(keep, e)
		}
	}
	s.statsMap[key] = append(keep, entry)
	s.statsMu.Unlock()
}

// TrafficStats returns the per-second packet rate and throughput (Mbps) for
// a given pod+interface averaged over a 300ms sliding window.
// Returns (0, 0) when no data has been received yet.
func (s *Server) TrafficStats(pod, iface string) (pps, throughputMbps float64) {
	const window = 0.3
	key := wildcardKey{PodName: pod, Iface: iface}
	cutoff := time.Now().Add(-time.Duration(window * float64(time.Second)))

	s.statsMu.Lock()
	entries := s.statsMap[key]
	var totalPkts int
	var totalBytes int64
	for _, e := range entries {
		if e.ts.After(cutoff) {
			totalPkts += e.pkts
			totalBytes += e.bytes
		}
	}
	s.statsMu.Unlock()

	if totalPkts == 0 {
		return 0, 0
	}
	pps = float64(totalPkts) / window
	throughputMbps = float64(totalBytes) * 8 / 1e6 / window
	return
}

// ActivePair is an exported pod+interface pair that has live traffic.
type ActivePair struct {
	PodName string
	Iface   string
}

// ActivePairs returns all pod+interface pairs that received at least one packet
// in the last 300 ms.
func (s *Server) ActivePairs() []ActivePair {
	cutoff := time.Now().Add(-300 * time.Millisecond)
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	var active []ActivePair
	for key, entries := range s.statsMap {
		for _, e := range entries {
			if e.ts.After(cutoff) {
				active = append(active, ActivePair{PodName: key.PodName, Iface: key.Iface})
				break
			}
		}
	}
	return active
}

// RegisterWildcardSubscriber subscribes to all packets for pod+iface, any node.
func (s *Server) RegisterWildcardSubscriber(pod, iface string) (Subscriber, func()) {
	key := wildcardKey{PodName: pod, Iface: iface}
	ch := make(Subscriber, 512)
	s.mu.Lock()
	s.wildcardSubs[key] = append(s.wildcardSubs[key], ch)
	s.mu.Unlock()

	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		list := s.wildcardSubs[key]
		for i, sub := range list {
			if sub == ch {
				s.wildcardSubs[key] = append(list[:i], list[i+1:]...)
				break
			}
		}
		close(ch)
	}
}

// RegisterSubscriber registers a channel to receive packets for a session key.
// Returns an unsubscribe function.
func (s *Server) RegisterSubscriber(key SessionKey) (Subscriber, func()) {
	ch := make(Subscriber, 256)
	s.mu.Lock()
	s.subs[key] = append(s.subs[key], ch)
	s.mu.Unlock()

	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		list := s.subs[key]
		for i, sub := range list {
			if sub == ch {
				s.subs[key] = append(list[:i], list[i+1:]...)
				break
			}
		}
		close(ch)
	}
}

// publish sends a packet batch to exact-key subscribers AND wildcard (pod+iface) subscribers.
// Also records traffic stats for the interface metrics endpoint.
func (s *Server) publish(key SessionKey, pkts []Packet) {
	wKey := wildcardKey{PodName: key.PodName, Iface: key.Iface}
	s.mu.RLock()
	subs  := s.subs[key]
	wSubs := s.wildcardSubs[wKey]
	s.mu.RUnlock()

	for _, sub := range subs {
		select { case sub <- pkts: default: }
	}
	for _, sub := range wSubs {
		select { case sub <- pkts: default: }
	}

	// Record in sliding-window stats for TrafficStats queries
	s.recordStats(wKey, pkts)

	// Store raw bytes in the per-pod ring buffer for decode queries
	if len(pkts) > 0 {
		s.pktRingMu.Lock()
		ring, ok := s.pktRings[wKey]
		if !ok {
			ring = newPktRingBuf(PktRingCap)
			s.pktRings[wKey] = ring
		}
		s.pktRingMu.Unlock()

		stored := 0
		for _, p := range pkts {
			if len(p.Raw) > 0 {
				ring.push(PktEntry{TsNs: p.TimestampNs, Raw: p.Raw})
				stored++
			}
		}
		if stored > 0 {
			log.Debug().
				Str("pod", wKey.PodName).
				Str("iface", wKey.Iface).
				Int("stored", stored).
				Int("skipped_no_raw", len(pkts)-stored).
				Int("ring_size", ring.size).
				Msg("pkt ring stored")
		} else {
			log.Debug().
				Str("pod", wKey.PodName).
				Str("iface", wKey.Iface).
				Int("batch", len(pkts)).
				Msg("pkt ring: batch skipped (no raw bytes in any packet)")
		}
	}
}

// GetRawByTs returns the raw packet bytes and pcap linktype for the packet
// with the given nanosecond timestamp for the specified pod+interface.
func (s *Server) GetRawByTs(pod, iface string, tsNs int64) (raw []byte, linkType uint32, ok bool) {
	key := wildcardKey{PodName: pod, Iface: iface}
	s.pktRingMu.RLock()
	ring, exists := s.pktRings[key]
	s.pktRingMu.RUnlock()
	if !exists {
		return nil, 1, false
	}
	raw, ok = ring.getByTs(tsNs)
	return raw, ring.linkType, ok
}

// GetRingKeys returns all (pod, iface) pairs currently in the ring buffer.
// Used for diagnostic logging when a decode lookup misses.
func (s *Server) GetRingKeys() [][2]string {
	s.pktRingMu.RLock()
	defer s.pktRingMu.RUnlock()
	out := make([][2]string, 0, len(s.pktRings))
	for k, r := range s.pktRings {
		r.mu.RLock()
		sz := r.size
		r.mu.RUnlock()
		out = append(out, [2]string{k.PodName + "/" + k.Iface, fmt.Sprintf("size=%d", sz)})
	}
	return out
}

// GetPacketsAfterTs returns all raw packets with tsNs >= cutoffNs for export.
func (s *Server) GetPacketsAfterTs(pod, iface string, cutoffNs int64) ([]PktEntry, uint32) {
	key := wildcardKey{PodName: pod, Iface: iface}
	s.pktRingMu.RLock()
	ring, exists := s.pktRings[key]
	s.pktRingMu.RUnlock()
	if !exists {
		return nil, 1
	}
	return ring.getAfterTs(cutoffNs), ring.linkType
}

// GetPacketsInRange returns all raw packets with startNs <= tsNs <= endNs for export.
func (s *Server) GetPacketsInRange(pod, iface string, startNs, endNs int64) ([]PktEntry, uint32) {
	key := wildcardKey{PodName: pod, Iface: iface}
	s.pktRingMu.RLock()
	ring, exists := s.pktRings[key]
	s.pktRingMu.RUnlock()
	if !exists {
		return nil, 1
	}
	return ring.getInRange(startNs, endNs), ring.linkType
}

// StreamPackets receives packet batches from a capture-agent (client-streaming).
func (s *Server) StreamPackets(stream grpc.ClientStreamingServer[pb.PacketBatch, pb.Ack]) error {
	for {
		batch, err := stream.Recv()
		if err == io.EOF {
			return stream.SendAndClose(&pb.Ack{Ok: true})
		}
		if err != nil {
			return err
		}
		if len(batch.Packets) == 0 {
			continue
		}

		p0 := batch.Packets[0]
		key := SessionKey{Node: p0.Node, PodName: p0.PodName, Iface: p0.InterfaceName}

		// Register capture-agent address when pod_ip is provided in the batch.
		if batch.PodIp != "" {
			wk := wildcardKey{PodName: p0.PodName, Iface: p0.InterfaceName}
			addr := batch.PodIp + ":9998"
			s.indexMu.Lock()
			s.nodeIndex[wk] = p0.Node
			if s.agentIPIndex[p0.Node] != addr {
				s.agentIPIndex[p0.Node] = addr
				log.Info().Str("node", p0.Node).Str("addr", addr).Msg("registered capture-agent")
			}
			s.indexMu.Unlock()
		}

		log.Debug().
			Str("pod", p0.PodName).
			Str("iface", p0.InterfaceName).
			Int("raw_len", len(p0.Raw)).
			Int("batch_size", len(batch.Packets)).
			Msg("pkt ring received")

		pkts := make([]Packet, len(batch.Packets))
		for i, p := range batch.Packets {
			pkts[i] = Packet{
				TimestampNs:   p.TimestampNs,
				SrcIP:         p.SrcIp,
				DstIP:         p.DstIp,
				SrcPort:       p.SrcPort,
				DstPort:       p.DstPort,
				Protocol:      p.Protocol,
				Length:        p.Length,
				Info:          p.Info,
				Raw:           p.Raw,
				InterfaceName: p.InterfaceName,
				PodName:       p.PodName,
				Namespace:     p.Namespace,
				Node:          p.Node,
			}
		}
		s.publish(key, pkts)
	}
}

// Subscribe implements the server-streaming RPC used for external subscribers.
func (s *Server) Subscribe(req *pb.SubscribeRequest, stream grpc.ServerStreamingServer[pb.PacketBatch]) error {
	key := SessionKey{Node: req.Node, PodName: req.PodName, Iface: req.InterfaceName}
	ch, unsub := s.RegisterSubscriber(key)
	defer unsub()

	for {
		select {
		case <-stream.Context().Done():
			return nil
		case pkts, ok := <-ch:
			if !ok {
				return nil
			}
			pbPkts := make([]*pb.Packet, len(pkts))
			for i, p := range pkts {
				pbPkts[i] = &pb.Packet{
					TimestampNs:   p.TimestampNs,
					SrcIp:         p.SrcIP,
					DstIp:         p.DstIP,
					SrcPort:       p.SrcPort,
					DstPort:       p.DstPort,
					Protocol:      p.Protocol,
					Length:        p.Length,
					Info:          p.Info,
					Raw:           p.Raw,
					InterfaceName: p.InterfaceName,
					PodName:       p.PodName,
					Namespace:     p.Namespace,
					Node:          p.Node,
				}
			}
			if err := stream.Send(&pb.PacketBatch{Packets: pbPkts}); err != nil {
				return err
			}
		}
	}
}

// getCaptureAgentAddr returns the control address for the capture-agent
// responsible for the given pod+interface, or "" if not yet registered.
func (s *Server) getCaptureAgentAddr(pod, iface string) string {
	s.indexMu.RLock()
	defer s.indexMu.RUnlock()
	node := s.nodeIndex[wildcardKey{PodName: pod, Iface: iface}]
	return s.agentIPIndex[node]
}

// getAgentClient returns (creating if necessary) a gRPC client to the
// capture-agent control server at addr.
func (s *Server) getAgentClient(addr string) (pb.CaptureAgentControlClient, error) {
	s.agentClientsMu.Lock()
	defer s.agentClientsMu.Unlock()
	if conn, ok := s.agentClients[addr]; ok {
		return pb.NewCaptureAgentControlClient(conn), nil
	}
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	s.agentClients[addr] = conn
	return pb.NewCaptureAgentControlClient(conn), nil
}

// GetWildcardSubCount returns the number of active wildcard subscribers for pod+iface.
func (s *Server) GetWildcardSubCount(pod, iface string) int {
	key := wildcardKey{PodName: pod, Iface: iface}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.wildcardSubs[key])
}

// GetSubCount returns the number of active exact-key subscribers for a session.
func (s *Server) GetSubCount(key SessionKey) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.subs[key])
}

// CallEnableTshark signals the capture-agent for pod+iface to start tshark.
// Must be called in its own goroutine — makes a blocking gRPC call.
// Retries addr lookup up to 10×200ms in case the viewer opens before the
// capture-agent has sent its first PacketBatch (addr not yet registered).
func (s *Server) CallEnableTshark(pod, iface, sessionID string) {
	var addr string
	for i := 0; i < 10; i++ {
		addr = s.getCaptureAgentAddr(pod, iface)
		if addr != "" {
			break
		}
		log.Debug().Str("pod", pod).Str("iface", iface).
			Int("attempt", i+1).
			Msg("callEnableTshark: agent addr not yet registered, retrying")
		time.Sleep(200 * time.Millisecond)
	}
	if addr == "" {
		log.Warn().Str("pod", pod).Str("iface", iface).
			Msg("callEnableTshark: no agent addr after 2s, giving up")
		return
	}
	client, err := s.getAgentClient(addr)
	if err != nil {
		log.Warn().Err(err).Str("pod", pod).Msg("callEnableTshark: getAgentClient failed")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	resp, err := client.EnableTshark(ctx, &pb.TsharkRequest{SessionId: sessionID})
	if err != nil {
		log.Warn().Err(err).Str("session", sessionID).Msg("callEnableTshark: RPC failed")
		return
	}
	log.Info().Str("session", sessionID).Bool("ok", resp.Ok).Msg("tshark enabled on agent")
}

// CallDisableTshark signals the capture-agent for pod+iface to stop tshark.
// Must be called in its own goroutine — makes a blocking gRPC call.
func (s *Server) CallDisableTshark(pod, iface, sessionID string) {
	addr := s.getCaptureAgentAddr(pod, iface)
	if addr == "" {
		log.Warn().Str("pod", pod).Str("iface", iface).Msg("callDisableTshark: no agent addr registered")
		return
	}
	client, err := s.getAgentClient(addr)
	if err != nil {
		log.Error().Err(err).Str("addr", addr).Msg("callDisableTshark: client error")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := client.DisableTshark(ctx, &pb.TsharkRequest{SessionId: sessionID})
	if err != nil {
		log.Error().Err(err).Str("session", sessionID).Msg("callDisableTshark: rpc failed")
		return
	}
	log.Info().Str("session", sessionID).Bool("ok", resp.Ok).Msg("tshark disabled on agent")
}

// PingCaptureAgent checks connectivity to the capture-agent at addr.
func (s *Server) PingCaptureAgent(addr string) error {
	client, err := s.getAgentClient(addr)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err = client.Ping(ctx, &pb.PingRequest{})
	return err
}

// ListenAndServe starts the gRPC listener on addr.
func (s *Server) ListenAndServe(addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := grpc.NewServer()
	pb.RegisterCaptureServiceServer(srv, s)
	log.Info().Str("addr", addr).Msg("capture gRPC server listening")
	return srv.Serve(lis)
}
