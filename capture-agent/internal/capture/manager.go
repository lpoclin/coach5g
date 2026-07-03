package capture

import (
	"context"
	"fmt"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog/log"

	"github.com/lpoclin/coach5g/capture-agent/internal/discovery"
	agentgrpc "github.com/lpoclin/coach5g/capture-agent/internal/grpc"
	"github.com/lpoclin/coach5g/capture-agent/internal/pb"
)

const ringCapacity = 5_000

// sessionKey uniquely identifies one capture session.
type sessionKey struct {
	podUID string
	iface  string
}

// sessionEntry links a string session ID to the session and its key.
type sessionEntry struct {
	sess *session
	key  sessionKey
}

type session struct {
	cancel        context.CancelFunc
	ring          *RingBuffer
	podName       string
	ns            string
	node          string
	tsharkEnabled *atomic.Bool
	tsharkCancel  context.CancelFunc // cancels the current run ctx; triggers restart
	mu            sync.Mutex         // protects tsharkCancel
}

// Manager manages one capture goroutine per (pod, interface).
type Manager struct {
	mu           sync.Mutex
	sessions     map[sessionKey]*session
	sessionIndex map[string]*sessionEntry // "ns/pod/iface" → entry
	grpc         *agentgrpc.Client
}

func NewManager(g *agentgrpc.Client) *Manager {
	m := &Manager{
		sessions:     make(map[sessionKey]*session),
		sessionIndex: make(map[string]*sessionEntry),
		grpc:         g,
	}
	go func() {
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for range t.C {
			var ms runtime.MemStats
			runtime.ReadMemStats(&ms)
			log.Info().
				Uint64("heap_alloc_mb", ms.HeapAlloc/1024/1024).
				Uint64("heap_sys_mb", ms.HeapSys/1024/1024).
				Uint64("heap_inuse_mb", ms.HeapInuse/1024/1024).
				Int("goroutines", runtime.NumGoroutine()).
				Msg("memory stats")
		}
	}()
	return m
}

// Reconcile starts missing captures and stops stale ones based on current pod list.
func (m *Manager) Reconcile(ctx context.Context, pods []discovery.PodInfo) {
	desired := make(map[sessionKey]discovery.PodInfo)
	for _, pod := range pods {
		for _, iface := range pod.Interfaces {
			desired[sessionKey{podUID: pod.UID, iface: iface}] = pod
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Stop stale sessions
	for key, sess := range m.sessions {
		if _, ok := desired[key]; !ok {
			log.Info().Str("uid", key.podUID[:8]).Str("iface", key.iface).Msg("stopping capture")
			log.Debug().Str("pod", sess.podName).Str("iface", key.iface).Int("goroutines", runtime.NumGoroutine()).Msg("session cancelled")
			sess.cancel()
			sid := SessionID(sess.ns, sess.podName, key.iface)
			delete(m.sessionIndex, sid)
			delete(m.sessions, key)
		}
	}

	// Start new sessions
	for key, pod := range desired {
		if _, ok := m.sessions[key]; ok {
			continue
		}
		sessCtx, cancel := context.WithCancel(ctx)
		ring := NewRingBuffer(ringCapacity)
		sess := &session{
			cancel:        cancel,
			ring:          ring,
			podName:       pod.Name,
			ns:            pod.Namespace,
			node:          pod.NodeName,
			tsharkEnabled: new(atomic.Bool), // false by default — tshark starts on demand
		}
		m.sessions[key] = sess
		sid := SessionID(pod.Namespace, pod.Name, key.iface)
		m.sessionIndex[sid] = &sessionEntry{sess: sess, key: key}

		go m.runCapture(sessCtx, key, pod, sess)
		log.Debug().Str("pod", pod.Name).Str("iface", key.iface).Int("goroutines", runtime.NumGoroutine()).Msg("session started")
	}

	log.Debug().
		Int("active_sessions", len(m.sessions)).
		Int("goroutines", runtime.NumGoroutine()).
		Msg("reconcile tick")
}

// runCapture restarts doCapture whenever tsharkEnabled changes (via tsharkCancel).
func (m *Manager) runCapture(sessCtx context.Context, key sessionKey, pod discovery.PodInfo, sess *session) {
	for {
		runCtx, runCancel := context.WithCancel(sessCtx)
		sess.mu.Lock()
		sess.tsharkCancel = runCancel
		sess.mu.Unlock()

		m.doCapture(runCtx, key, pod, sess)
		runCancel()

		select {
		case <-sessCtx.Done():
			return
		default:
		}
		// Debounce rapid toggles; also prevents tight loop if tcpdump fails immediately.
		select {
		case <-sessCtx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (m *Manager) doCapture(ctx context.Context, key sessionKey, pod discovery.PodInfo, sess *session) {
	log.Info().
		Str("pod", pod.Name).
		Str("ns", pod.Namespace).
		Str("iface", key.iface).
		Bool("tshark", sess.tsharkEnabled.Load()).
		Msg("capture session starting")

	ch, err := RunCapture(ctx, key.podUID, pod.ContainerID, key.iface, sess.tsharkEnabled)
	if err != nil {
		log.Error().Err(err).Str("pod", pod.Name).Str("iface", key.iface).Msg("capture start failed")
		return
	}

	sessionID := SessionID(pod.Namespace, pod.Name, key.iface)
	var batch []*pb.Packet
	flushTicker := time.NewTicker(100 * time.Millisecond)
	defer flushTicker.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		m.grpc.BackoffRetry(ctx, sessionID, batch)
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case <-flushTicker.C:
			flush()
		case result, ok := <-ch:
			if !ok {
				flush()
				return
			}

			if result.Line == "" {
				// tshark-off: raw frame with pcap timestamp + fields from extractPacketFields
				if result.TimestampNs == 0 {
					continue
				}
				raw := RawPacket{
					TimestampNs: result.TimestampNs,
					SrcIP:       result.SrcIP,
					DstIP:       result.DstIP,
					SrcPort:     uint32(result.SrcPort),
					DstPort:     uint32(result.DstPort),
					Protocol:    result.Protocol,
					Length:      uint32(len(result.RawBytes)),
					Info:        result.Info,
					Raw:         result.RawBytes,
				}
				sess.ring.Push(raw)
				batch = append(batch, &pb.Packet{
					TimestampNs:   raw.TimestampNs,
					SrcIp:         raw.SrcIP,
					DstIp:         raw.DstIP,
					SrcPort:       raw.SrcPort,
					DstPort:       raw.DstPort,
					Protocol:      raw.Protocol,
					Length:        raw.Length,
					Info:          raw.Info,
					Raw:           raw.Raw,
					InterfaceName: key.iface,
					PodName:       pod.Name,
					Namespace:     pod.Namespace,
					Node:          pod.NodeName,
				})
				if len(batch) >= 50 {
					flush()
				}
				continue
			}

			// tshark-on: parse decoded fields
			fields, ok := ParseTsharkLine(result.Line)
			if !ok {
				continue
			}
			// Use integer arithmetic to preserve nanosecond precision — no float64 conversion.
			tsNs := epochStringToNs(fields["ts"])
			length, _ := strconv.ParseUint(fields["length"], 10, 32)
			sport, _ := strconv.ParseUint(fields["src_port"], 10, 32)
			dport, _ := strconv.ParseUint(fields["dst_port"], 10, 32)

			// Fallback: fill empty tshark fields from raw frame parser
			rawSrcIP, rawDstIP, rawSrcPort, rawDstPort, rawProto, rawInfo := extractPacketFields(result.RawBytes)
			finalSrcIP := fields["src_ip"]
			if finalSrcIP == "" {
				finalSrcIP = rawSrcIP
			}
			finalDstIP := fields["dst_ip"]
			if finalDstIP == "" {
				finalDstIP = rawDstIP
			}
			finalProto := fields["protocol"]
			if finalProto == "" {
				finalProto = rawProto
			}
			finalInfo := fields["info"]
			if finalInfo == "" {
				finalInfo = rawInfo
			}
			finalSrcPort := uint32(sport)
			if finalSrcPort == 0 {
				finalSrcPort = uint32(rawSrcPort)
			}
			finalDstPort := uint32(dport)
			if finalDstPort == 0 {
				finalDstPort = uint32(rawDstPort)
			}

			raw := RawPacket{
				TimestampNs: tsNs,
				SrcIP:       finalSrcIP,
				DstIP:       finalDstIP,
				SrcPort:     finalSrcPort,
				DstPort:     finalDstPort,
				Protocol:    finalProto,
				Length:      uint32(length),
				Info:        finalInfo,
				Raw:         result.RawBytes,
			}
			sess.ring.Push(raw)

			batch = append(batch, &pb.Packet{
				TimestampNs:   raw.TimestampNs,
				SrcIp:         raw.SrcIP,
				DstIp:         raw.DstIP,
				SrcPort:       raw.SrcPort,
				DstPort:       raw.DstPort,
				Protocol:      raw.Protocol,
				Length:        raw.Length,
				Info:          raw.Info,
				Raw:           raw.Raw,
				InterfaceName: key.iface,
				PodName:       pod.Name,
				Namespace:     pod.Namespace,
				Node:          pod.NodeName,
			})

			if len(batch) >= 50 {
				flush()
			}
		}
	}
}

// StopAll cancels all active sessions.
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, sess := range m.sessions {
		sess.cancel()
	}
}

// EnableTshark starts tshark for the given session (identified by "ns/pod/iface").
// If tshark was already enabled this is a no-op.
func (m *Manager) EnableTshark(sessionID string) error {
	m.mu.Lock()
	entry := m.sessionIndex[sessionID]
	m.mu.Unlock()
	if entry == nil {
		return fmt.Errorf("session %q not found", sessionID)
	}
	if !entry.sess.tsharkEnabled.Swap(true) {
		// was false → trigger restart with tshark-on
		entry.sess.mu.Lock()
		cancel := entry.sess.tsharkCancel
		entry.sess.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		log.Info().Str("session", sessionID).Msg("tshark enable: restart triggered")
	}
	return nil
}

// DisableTshark stops tshark for the given session.
// If tshark was already disabled this is a no-op.
func (m *Manager) DisableTshark(sessionID string) error {
	m.mu.Lock()
	entry := m.sessionIndex[sessionID]
	m.mu.Unlock()
	if entry == nil {
		return fmt.Errorf("session %q not found", sessionID)
	}
	if entry.sess.tsharkEnabled.Swap(false) {
		// was true → trigger restart with tshark-off
		entry.sess.mu.Lock()
		cancel := entry.sess.tsharkCancel
		entry.sess.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		log.Info().Str("session", sessionID).Msg("tshark disable: restart triggered")
	}
	return nil
}

// SessionID builds a stable session ID string.
func SessionID(ns, pod, iface string) string {
	return fmt.Sprintf("%s/%s/%s", ns, pod, iface)
}
