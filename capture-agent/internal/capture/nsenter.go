package capture

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/rs/zerolog/log"
)

// findPodPID returns a PID inside the pod's network namespace.
//
// cgroupv2 + containerd: pod UIDs use hyphens but cgroup paths use underscores,
// e.g. UID a9f01084-6257-... → cgroup path kubepods-burstable-poda9f01084_6257_...
// containerID is the full container ID (containerd://SHA256); we use the first 12 chars
// to match the specific container cgroup and skip pause/sandbox containers.
func findPodPID(podUID, containerID string) (int, error) {
	// cgroupv2 encodes the pod UID with underscores instead of hyphens
	cgroupPodID := "pod" + strings.ReplaceAll(podUID, "-", "_")

	// Extract short container ID (first 12 chars after stripping scheme)
	containerIDFull := strings.TrimPrefix(containerID, "containerd://")
	containerIDFull  = strings.TrimPrefix(containerIDFull, "docker://")
	containerIDShort := ""
	if len(containerIDFull) >= 12 {
		containerIDShort = containerIDFull[:12]
	}

	procs, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	for _, entry := range procs {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		cgroup, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
		if err != nil {
			continue
		}
		cgroupStr := string(cgroup)

		// Match cgroupv2 (underscore UID) or cgroupv1 (hyphen UID)
		matchesPod := strings.Contains(cgroupStr, cgroupPodID) ||
			strings.Contains(cgroupStr, podUID)
		if !matchesPod {
			continue
		}
		// If we have a container ID, also verify it matches (skips pause containers)
		if containerIDShort != "" && !strings.Contains(cgroupStr, containerIDShort) {
			continue
		}
		// Skip kernel threads (no cmdline)
		cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
		if len(cmdline) > 0 {
			return pid, nil
		}
	}
	return 0, fmt.Errorf("no PID found for pod UID %s", podUID)
}

// CaptureResult is a decoded packet line from tshark with raw frame bytes.
// When tshark is disabled, Line is "" and the parsed L3/L4 fields are populated
// from extractPacketFields; TimestampNs carries the pcap record timestamp.
type CaptureResult struct {
	Line        string
	RawBytes    []byte // raw Ethernet/IP frame bytes for sharkd decode; nil if unavailable
	TimestampNs int64  // set in tshark-off mode; zero in tshark-on mode (tshark provides ts)
	SrcIP       string
	DstIP       string
	SrcPort     uint16
	DstPort     uint16
	Protocol    string
	Info        string
}

// RunCapture starts capture in the pod network namespace.
// When tsharkEnabled is true: runs tcpdump | tshark, sends parsed field lines.
// When tsharkEnabled is false: runs tcpdump only, sends raw frames with pcap timestamps.
// The flag is read once at startup; call again (via restart loop) to change mode.
func RunCapture(ctx context.Context, podUID, containerID, iface string, tsharkEnabled *atomic.Bool) (<-chan CaptureResult, error) {
	pid, err := findPodPID(podUID, containerID)
	if err != nil {
		return nil, fmt.Errorf("find pod PID: %w", err)
	}

	netNS := fmt.Sprintf("/proc/%d/ns/net", pid)

	// Check netns file exists
	if _, err := os.Stat(netNS); err != nil {
		return nil, fmt.Errorf("netns %s not accessible: %w", netNS, err)
	}

	ch := make(chan CaptureResult, 512)

	tcpdumpArgs := []string{
		fmt.Sprintf("--net=%s", netNS),
		"--",
		"tcpdump",
		"-i", iface,
		"-w", "-",
		"--immediate-mode",
		"-s", "0",
	}

	nsenterBin, _ := exec.LookPath("nsenter")
	if nsenterBin == "" {
		nsenterBin = "/usr/bin/nsenter"
	}

	if !tsharkEnabled.Load() {
		// tshark-off: tcpdump only; send raw frames with pcap timestamps
		go func() {
			defer close(ch)
			tcpdump := exec.CommandContext(ctx, nsenterBin, tcpdumpArgs...)
			tcpdump.Env = append(os.Environ())
			tcpdumpStdout, err := tcpdump.StdoutPipe()
			if err != nil {
				log.Error().Err(err).Str("iface", iface).Msg("tcpdump stdout pipe (no-tshark)")
				return
			}
			if err := tcpdump.Start(); err != nil {
				log.Error().Err(err).Str("iface", iface).Msg("tcpdump start (no-tshark)")
				return
			}
			log.Info().Str("uid", podUID).Str("iface", iface).Msg("capture running (tshark-off)")
			defer func() {
				tcpdump.Process.Kill()
				tcpdump.Wait()
				log.Debug().Str("uid", podUID).Str("iface", iface).Msg("tcpdump (no-tshark) exited")
			}()
			parsePcapFramesDirect(ctx, tcpdumpStdout, ch)
		}()
		return ch, nil
	}

	// tshark-on: tcpdump | tshark pipeline
	tsharkArgs := []string{
		"-r", "-",
		"-l",
		"-T", "fields",
		"-e", "frame.time_epoch",
		"-e", "ip.src",
		"-e", "ip.dst",
		"-e", "tcp.srcport",
		"-e", "udp.srcport",
		"-e", "tcp.dstport",
		"-e", "udp.dstport",
		"-e", "_ws.col.Protocol",
		"-e", "frame.len",
		"-e", "_ws.col.Info",
		"-E", "separator=|",
	}

	tsharkBin, _ := exec.LookPath("tshark")
	if tsharkBin == "" {
		tsharkBin = filepath.Join("/usr/bin", "tshark")
	}

	go func() {
		defer close(ch)

		tcpdump := exec.CommandContext(ctx, nsenterBin, tcpdumpArgs...)
		tcpdump.Env = append(os.Environ())

		tshark := exec.CommandContext(ctx, tsharkBin, tsharkArgs...)
		tshark.Env = append(os.Environ())

		// tcpdump stdout → TeeReader → tshark stdin (fields text)
		//                            └→ pcapPipeW → pcapPipeR → parsePcapFrames (raw bytes)
		tcpdumpStdout, err := tcpdump.StdoutPipe()
		if err != nil {
			log.Error().Err(err).Msg("tcpdump stdout pipe")
			return
		}

		tsharkOut, err := tshark.StdoutPipe()
		if err != nil {
			log.Error().Err(err).Msg("tshark stdout pipe")
			return
		}

		pcapPipeR, pcapPipeW := io.Pipe()
		teeR := io.TeeReader(tcpdumpStdout, pcapPipeW)
		tshark.Stdin = teeR

		rawCh := make(chan []byte, 512)
		var rawChOnce sync.Once
		closeRawCh := func() { rawChOnce.Do(func() { close(rawCh) }) }

		go func() {
			defer closeRawCh()
			defer pcapPipeR.Close()
			parsePcapFrames(ctx, pcapPipeR, rawCh)
		}()

		if err := tcpdump.Start(); err != nil {
			log.Error().Err(err).Str("iface", iface).Msg("tcpdump start")
			pcapPipeW.Close()
			return
		}
		if err := tshark.Start(); err != nil {
			log.Error().Err(err).Str("iface", iface).Msg("tshark start")
			tcpdump.Process.Kill()
			pcapPipeW.Close()
			return
		}
		log.Info().Str("uid", podUID).Str("iface", iface).Msg("capture running (tshark-on)")

		defer func() {
			log.Debug().Str("uid", podUID).Str("iface", iface).Int("goroutines", runtime.NumGoroutine()).Msg("runcapture exiting, cleanup starting")
			tcpdump.Process.Kill()
			tshark.Process.Kill()
			pcapPipeW.Close()
			closeRawCh()
			tcpdump.Wait()
			tshark.Wait()
			log.Debug().Str("uid", podUID).Str("iface", iface).Int("goroutines", runtime.NumGoroutine()).Msg("runcapture exited")
		}()

		scanner := bufio.NewScanner(tsharkOut)
		scanner.Buffer(make([]byte, 64*1024), 64*1024)
		for scanner.Scan() {
			var rawBytes []byte
			select {
			case <-ctx.Done():
				return
			case rb, ok := <-rawCh:
				if ok {
					rawBytes = rb
				}
			}
			select {
			case <-ctx.Done():
				return
			case ch <- CaptureResult{Line: scanner.Text(), RawBytes: rawBytes}:
			}
		}
	}()

	return ch, nil
}

// ParseTsharkLine parses a tshark -T fields line with | separator.
// Fields order: time_epoch|src_ip|dst_ip|tcp_sport|udp_sport|tcp_dport|udp_dport|protocol|length|info
func ParseTsharkLine(line string) (map[string]string, bool) {
	parts := strings.Split(line, "|")
	if len(parts) < 9 {
		return nil, false
	}
	sport := parts[3]
	if sport == "" {
		sport = parts[4]
	}
	dport := parts[5]
	if dport == "" {
		dport = parts[6]
	}
	return map[string]string{
		"ts":       parts[0],
		"src_ip":   parts[1],
		"dst_ip":   parts[2],
		"src_port": sport,
		"dst_port": dport,
		"protocol": normalizeProtocol(parts[7]),
		"length":   parts[8],
		"info":     strings.Join(parts[9:], "|"),
	}, true
}

// epochStringToNs converts a tshark frame.time_epoch string such as
// "1779484323.482605934" to nanoseconds using pure integer arithmetic.
// No float64 conversion is used, so nanosecond precision is preserved exactly.
func epochStringToNs(epochStr string) int64 {
	parts := strings.SplitN(epochStr, ".", 2)
	sec, _ := strconv.ParseInt(parts[0], 10, 64)
	tsNs := sec * 1_000_000_000
	if len(parts) == 2 {
		frac := parts[1]
		for len(frac) < 9 {
			frac += "0"
		}
		frac = frac[:9] // truncate to exactly 9 digits (nanoseconds)
		nsec, _ := strconv.ParseInt(frac, 10, 64)
		tsNs += nsec
	}
	return tsNs
}

func formatIPv6(b []byte) string {
	return net.IP(b).String()
}

// extractPacketFields parses an Ethernet frame and returns L3/L4 fields.
// Handles IPv4, IPv6, ARP, 802.1Q VLAN tags, and unknown EtherTypes.
func extractPacketFields(data []byte) (srcIP, dstIP string, srcPort, dstPort uint16, proto, info string) {
	if len(data) < 14 {
		return
	}

	etherType := binary.BigEndian.Uint16(data[12:14])
	offset := 14 // start of layer-3 payload

	// 802.1Q VLAN tag — shifts everything by 4 bytes
	if etherType == 0x8100 {
		if len(data) < 18 {
			return
		}
		etherType = binary.BigEndian.Uint16(data[16:18])
		offset = 18
	}

	switch etherType {
	case 0x0800: // IPv4
		if len(data) < offset+20 {
			return
		}
		if data[offset]>>4 != 4 {
			return
		}
		ihl := int(data[offset]&0x0F) * 4
		if offset+ihl > len(data) {
			return
		}
		protocol := data[offset+9]
		srcIP = fmt.Sprintf("%d.%d.%d.%d", data[offset+12], data[offset+13], data[offset+14], data[offset+15])
		dstIP = fmt.Sprintf("%d.%d.%d.%d", data[offset+16], data[offset+17], data[offset+18], data[offset+19])
		portOff := offset + ihl
		switch protocol {
		case 0x06: // TCP
			proto = "TCP"
			if portOff+4 <= len(data) {
				srcPort = binary.BigEndian.Uint16(data[portOff:])
				dstPort = binary.BigEndian.Uint16(data[portOff+2:])
				info = fmt.Sprintf("%d → %d", srcPort, dstPort)
			}
		case 0x11: // UDP
			proto = "UDP"
			if portOff+4 <= len(data) {
				srcPort = binary.BigEndian.Uint16(data[portOff:])
				dstPort = binary.BigEndian.Uint16(data[portOff+2:])
				info = fmt.Sprintf("%d → %d", srcPort, dstPort)
				if srcPort == 8805 || dstPort == 8805 {
					proto = "PFCP"
					info = "PFCP (raw)"
				} else if srcPort == 2152 || dstPort == 2152 {
					proto = "GTP-U"
					info = "GTP-U (raw)"
				}
			}
		case 0x84: // SCTP
			proto = "SCTP"
			if portOff+4 <= len(data) {
				srcPort = binary.BigEndian.Uint16(data[portOff:])
				dstPort = binary.BigEndian.Uint16(data[portOff+2:])
				info = fmt.Sprintf("SCTP %d → %d", srcPort, dstPort)
			}
		case 0x01: // ICMP
			proto = "ICMP"
			info = "ICMP"
		default:
			proto = fmt.Sprintf("IPv4(0x%02x)", protocol)
		}

	case 0x86DD: // IPv6
		if len(data) < offset+40 {
			return
		}
		if data[offset]>>4 != 6 {
			return
		}
		nextHeader := data[offset+6]
		srcIP = formatIPv6(data[offset+8 : offset+24])
		dstIP = formatIPv6(data[offset+24 : offset+40])
		portOff := offset + 40
		switch nextHeader {
		case 0x06: // TCP
			proto = "TCP"
			if portOff+4 <= len(data) {
				srcPort = binary.BigEndian.Uint16(data[portOff:])
				dstPort = binary.BigEndian.Uint16(data[portOff+2:])
				info = fmt.Sprintf("%d → %d", srcPort, dstPort)
			}
		case 0x11: // UDP
			proto = "UDP"
			if portOff+4 <= len(data) {
				srcPort = binary.BigEndian.Uint16(data[portOff:])
				dstPort = binary.BigEndian.Uint16(data[portOff+2:])
				info = fmt.Sprintf("%d → %d", srcPort, dstPort)
				if srcPort == 8805 || dstPort == 8805 {
					proto = "PFCP"
					info = "PFCP (raw)"
				} else if srcPort == 2152 || dstPort == 2152 {
					proto = "GTP-U"
					info = "GTP-U (raw)"
				}
			}
		case 0x3A: // ICMPv6
			proto = "ICMPv6"
			info = "ICMPv6"
		default:
			proto = fmt.Sprintf("IPv6(0x%02x)", nextHeader)
		}

	case 0x0806: // ARP
		proto = "ARP"
		if offset+28 <= len(data) {
			oper := binary.BigEndian.Uint16(data[offset+6 : offset+8])
			senderIP := fmt.Sprintf("%d.%d.%d.%d", data[offset+14], data[offset+15], data[offset+16], data[offset+17])
			targetIP := fmt.Sprintf("%d.%d.%d.%d", data[offset+24], data[offset+25], data[offset+26], data[offset+27])
			srcIP = senderIP
			dstIP = targetIP
			switch oper {
			case 1:
				info = fmt.Sprintf("Who has %s? Tell %s", targetIP, senderIP)
			case 2:
				senderMAC := fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x",
					data[offset+8], data[offset+9], data[offset+10],
					data[offset+11], data[offset+12], data[offset+13])
				info = fmt.Sprintf("%s is at %s", senderIP, senderMAC)
			default:
				info = fmt.Sprintf("ARP op=%d", oper)
			}
		}

	default:
		if len(data) >= 14 {
			dstMAC := fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x",
				data[0], data[1], data[2], data[3], data[4], data[5])
			srcMAC := fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x",
				data[6], data[7], data[8], data[9], data[10], data[11])
			srcIP = srcMAC
			dstIP = dstMAC
			proto = fmt.Sprintf("0x%04X", etherType)
			info = "Ethernet II"
		}
	}
	return
}

// parsePcapFramesDirect reads a libpcap byte stream and sends CaptureResult
// (with TimestampNs and RawBytes, empty Line) for each frame. Used in tshark-off mode.
func parsePcapFramesDirect(ctx context.Context, r io.Reader, ch chan<- CaptureResult) {
	var magic [4]byte
	if _, err := io.ReadFull(r, magic[:]); err != nil {
		return
	}
	magicNum := binary.LittleEndian.Uint32(magic[:])
	bigEndian := magicNum == 0xd4c3b2a1 || magicNum == 0x4d3cb2a1
	isNsec := magicNum == 0xa1b23c4d || magicNum == 0x4d3cb2a1
	if magicNum != 0xa1b2c3d4 && magicNum != 0xa1b23c4d && !bigEndian {
		log.Warn().Uint32("magic", magicNum).Msg("parsePcapFramesDirect: unrecognized magic")
		return
	}
	var rest [20]byte
	if _, err := io.ReadFull(r, rest[:]); err != nil {
		return
	}
	var hdr [16]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return
		}
		var tsSec, tsSubSec, inclLen uint32
		if bigEndian {
			tsSec    = binary.BigEndian.Uint32(hdr[0:4])
			tsSubSec = binary.BigEndian.Uint32(hdr[4:8])
			inclLen  = binary.BigEndian.Uint32(hdr[8:12])
		} else {
			tsSec    = binary.LittleEndian.Uint32(hdr[0:4])
			tsSubSec = binary.LittleEndian.Uint32(hdr[4:8])
			inclLen  = binary.LittleEndian.Uint32(hdr[8:12])
		}
		var tsNs int64
		if isNsec {
			tsNs = int64(tsSec)*1_000_000_000 + int64(tsSubSec)
		} else {
			tsNs = int64(tsSec)*1_000_000_000 + int64(tsSubSec)*1_000
		}
		data := make([]byte, inclLen)
		if _, err := io.ReadFull(r, data); err != nil {
			return
		}
		srcIP, dstIP, srcPort, dstPort, proto, info := extractPacketFields(data)
		select {
		case ch <- CaptureResult{
			TimestampNs: tsNs,
			RawBytes:    data,
			SrcIP:       srcIP,
			DstIP:       dstIP,
			SrcPort:     srcPort,
			DstPort:     dstPort,
			Protocol:    proto,
			Info:        info,
		}:
		case <-ctx.Done():
			return
		}
	}
}

// parsePcapFrames reads a libpcap byte stream and sends raw packet bytes for
// each frame on rawCh.  Called in a goroutine alongside the tshark text parser;
// frames appear in the same sequential order as tshark output lines.
func parsePcapFrames(ctx context.Context, r io.Reader, rawCh chan<- []byte) {
	log.Debug().Msg("parsePcapFrames: starting")

	// pcap global header: 24 bytes
	// magic(4) versionMajor(2) versionMinor(2) thiszone(4) sigfigs(4) snaplen(4) network(4)
	var magic [4]byte
	if _, err := io.ReadFull(r, magic[:]); err != nil {
		log.Error().Err(err).Msg("parsePcapFrames: failed to read magic bytes")
		return
	}
	magicNum := binary.LittleEndian.Uint32(magic[:])
	log.Debug().Uint32("magic", magicNum).Msg("parsePcapFrames: read magic")

	bigEndian := magicNum == 0xd4c3b2a1 || magicNum == 0x4d3cb2a1
	if magicNum != 0xa1b2c3d4 && magicNum != 0xa1b23c4d && !bigEndian {
		log.Warn().Uint32("magic", magicNum).Msg("parsePcapFrames: unrecognized magic, raw bytes unavailable")
		return
	}

	// Discard remaining 20 bytes of global header
	var rest [20]byte
	if _, err := io.ReadFull(r, rest[:]); err != nil {
		log.Error().Err(err).Msg("parsePcapFrames: failed to read global header")
		return
	}

	// Per-packet record: ts_sec(4) ts_usec(4) incl_len(4) orig_len(4) + data
	var hdr [16]byte
	frameCount := 0
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			log.Debug().Int("frames_read", frameCount).Msg("parsePcapFrames: done")
			return
		}
		var inclLen uint32
		if bigEndian {
			inclLen = binary.BigEndian.Uint32(hdr[8:12])
		} else {
			inclLen = binary.LittleEndian.Uint32(hdr[8:12])
		}
		data := make([]byte, inclLen)
		if _, err := io.ReadFull(r, data); err != nil {
			log.Error().Err(err).Uint32("expected_len", inclLen).Int("frame", frameCount+1).
				Msg("parsePcapFrames: failed to read frame data")
			return
		}
		frameCount++
		if frameCount <= 3 || frameCount%1000 == 0 {
			log.Debug().Int("frame", frameCount).Int("len", len(data)).Msg("parsePcapFrames: frame read")
		}
		select {
		case rawCh <- data:
		case <-ctx.Done():
			return
		}
	}
}

func normalizeProtocol(p string) string {
	upper := strings.ToUpper(strings.TrimSpace(p))
	switch {
	case strings.Contains(upper, "GTP"):
		return "GTP-U"
	case strings.Contains(upper, "PFCP"):
		return "PFCP"
	case strings.Contains(upper, "HTTP/2"), strings.Contains(upper, "HTTP2"):
		return "HTTP/2"
	case strings.Contains(upper, "NGAP"):
		return "NGAP"
	case strings.Contains(upper, "SCTP"):
		return "SCTP"
	case strings.Contains(upper, "NAS"):
		return "NAS"
	case strings.Contains(upper, "DNS"):
		return "DNS"
	case strings.Contains(upper, "TCP"):
		return "TCP"
	case strings.Contains(upper, "UDP"):
		return "UDP"
	default:
		return upper
	}
}
