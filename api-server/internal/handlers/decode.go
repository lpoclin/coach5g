package handlers

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"github.com/lpoclin/coach5g/api-server/internal/capture"
)

// sharkdBin is resolved once at package init.
var sharkdBin string

func init() {
	for _, candidate := range []string{"/usr/bin/sharkd", "/usr/local/bin/sharkd"} {
		if _, err := os.Stat(candidate); err == nil {
			sharkdBin = candidate
			break
		}
	}
	if sharkdBin == "" {
		if p, err := exec.LookPath("sharkd"); err == nil {
			sharkdBin = p
		}
	}
	if sharkdBin == "" {
		log.Warn().Msg("sharkd not found — packet decode will use basic fallback")
	} else {
		log.Info().Str("path", sharkdBin).Msg("sharkd found")
	}
}

// DecodePacketHandler — GET /api/packet/decode?pod=X&interface=Y&ts=N
//
// Returns the sharkd dissection tree + hex bytes for frame N, or a fallback
// JSON object when sharkd is unavailable.
func DecodePacketHandler(cap *capture.Server) gin.HandlerFunc {
	return func(c *gin.Context) {
		pod   := c.Query("pod")
		iface := c.Query("interface")
		tsStr := c.Query("ts")

		if pod == "" || iface == "" || tsStr == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "pod, interface, ts required"})
			return
		}
		tsNs, err := strconv.ParseInt(tsStr, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ts must be an integer (nanoseconds)"})
			return
		}

		log.Debug().
			Str("pod", pod).
			Str("iface", iface).
			Int64("ts", tsNs).
			Msg("decode request received")

		rawBytes, linkType, ok := cap.GetRawByTs(pod, iface, tsNs)

		log.Debug().
			Str("pod", pod).
			Str("iface", iface).
			Bool("found", ok).
			Int("raw_len", len(rawBytes)).
			Msg("ring buffer lookup result")

		if !ok || len(rawBytes) == 0 {
			// Dump known ring keys to help diagnose pod-name or interface mismatches
			keys := cap.GetRingKeys()
			log.Warn().
				Str("pod", pod).
				Str("iface", iface).
				Int64("ts", tsNs).
				Interface("known_ring_keys", keys).
				Msg("decode miss: packet not in ring buffer")

			c.JSON(http.StatusNotFound, gin.H{
				"sharkd":    false,
				"error":     "packet not found in ring buffer (too old or raw bytes not yet populated)",
				"ring_keys": keys,
			})
			return
		}

		if sharkdBin == "" {
			// Fallback: return raw hex so frontend can still show the hex dump
			c.JSON(http.StatusOK, gin.H{
				"sharkd": false,
				"bytes":  hex.EncodeToString(rawBytes),
				"error":  "sharkd not available — upgrade api-server image to include tshark",
			})
			return
		}

		// Write a single-packet pcap temp file
		tmpPath := fmt.Sprintf("/tmp/coach5g-decode-%d.pcap", time.Now().UnixNano())
		defer os.Remove(tmpPath)

		if err := writeSinglePacketPcap(tmpPath, rawBytes, tsNs, linkType); err != nil {
			log.Error().Err(err).Msg("write decode pcap")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write temp pcap"})
			return
		}

		result, sharkdErr := runSharkd(tmpPath)
		if sharkdErr != nil {
			log.Warn().Err(sharkdErr).Msg("sharkd decode failed")
			c.JSON(http.StatusOK, gin.H{
				"sharkd": false,
				"bytes":  hex.EncodeToString(rawBytes),
				"error":  "sharkd decode failed: " + sharkdErr.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"sharkd": true,
			"result": result,
		})
	}
}

// ExportPacketsHandler — GET /api/packets/export?pod=X&interface=Y&duration=30s|5m|1h
//
// Streams a pcap file containing all packets in the rolling ring buffer for
// the given duration window.  The downloaded file opens directly in Wireshark.
func ExportPacketsHandler(cap *capture.Server) gin.HandlerFunc {
	return func(c *gin.Context) {
		pod      := c.Query("pod")
		iface    := c.Query("interface")
		startStr := c.Query("start")
		endStr   := c.Query("end")
		duration := c.Query("duration")

		if pod == "" || iface == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "pod and interface required"})
			return
		}

		var pkts []capture.PktEntry
		var linkType uint32

		if startStr != "" && endStr != "" {
			startNs, err1 := strconv.ParseInt(startStr, 10, 64)
			endNs,   err2 := strconv.ParseInt(endStr,   10, 64)
			if err1 != nil || err2 != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid start/end params"})
				return
			}
			pkts, linkType = cap.GetPacketsInRange(pod, iface, startNs, endNs)
		} else {
			var cutoff time.Time
			switch duration {
			case "5m":
				cutoff = time.Now().Add(-5 * time.Minute)
			case "1h":
				cutoff = time.Now().Add(-time.Hour)
			default: // "30s" or empty
				cutoff = time.Now().Add(-30 * time.Second)
			}
			pkts, linkType = cap.GetPacketsAfterTs(pod, iface, cutoff.UnixNano())
		}

		if len(pkts) == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "no packets in requested time range"})
			return
		}

		ts    := time.Now().UTC().Format("20060102-150405")
		fname := fmt.Sprintf("%s-%s-%s.pcap", sanitize(pod), sanitize(iface), ts)
		c.Header("Content-Type", "application/vnd.tcpdump.pcap")
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fname))

		if err := writePcapToWriter(c.Writer, pkts, linkType); err != nil {
			log.Error().Err(err).Msg("write export pcap")
		}
	}
}

// ─── pcap writer helpers ──────────────────────────────────────────────────────

// writeSinglePacketPcap writes a minimal pcap file containing exactly one packet.
func writeSinglePacketPcap(path string, raw []byte, tsNs int64, linkType uint32) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	if err := writePcapGlobalHeader(w, linkType); err != nil {
		return err
	}
	if err := writePcapPacket(w, raw, tsNs); err != nil {
		return err
	}
	return w.Flush()
}

func writePcapToWriter(w http.ResponseWriter, pkts []capture.PktEntry, linkType uint32) error {
	bw := bufio.NewWriter(w)
	if err := writePcapGlobalHeader(bw, linkType); err != nil {
		return err
	}
	for _, p := range pkts {
		if err := writePcapPacket(bw, p.Raw, p.TsNs); err != nil {
			return err
		}
	}
	return bw.Flush()
}

func writePcapGlobalHeader(w *bufio.Writer, linkType uint32) error {
	fields := []interface{}{
		uint32(0xa1b2c3d4), // magic
		uint16(2),          // version major
		uint16(4),          // version minor
		int32(0),           // thiszone
		uint32(0),          // sigfigs
		uint32(65535),      // snaplen
		linkType,           // network / link type
	}
	for _, v := range fields {
		if err := binary.Write(w, binary.LittleEndian, v); err != nil {
			return err
		}
	}
	return nil
}

func writePcapPacket(w *bufio.Writer, raw []byte, tsNs int64) error {
	tsSec  := uint32(tsNs / 1_000_000_000)
	tsUsec := uint32((tsNs % 1_000_000_000) / 1_000)
	incl   := uint32(len(raw))
	for _, v := range []interface{}{tsSec, tsUsec, incl, incl} {
		if err := binary.Write(w, binary.LittleEndian, v); err != nil {
			return err
		}
	}
	_, err := w.Write(raw)
	return err
}

// ─── sharkd JSON-RPC ──────────────────────────────────────────────────────────

// runSharkd spawns sharkd -, sends load+frame commands, returns the raw "result"
// JSON from the frame response.
func runSharkd(pcapPath string) (json.RawMessage, error) {
	cmd := exec.Command(sharkdBin, "-") // stdin/stdout mode
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("sharkd stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("sharkd stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("sharkd start: %w", err)
	}
	defer func() {
		stdin.Close()
		cmd.Wait()
	}()

	reader := bufio.NewReader(stdout)

	// Skip any greeting line sharkd might output before accepting commands
	// (sharkd typically outputs nothing until it receives a command)

	// 1. Load the pcap file
	loadCmd := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"load","params":{"file":%q}}`, pcapPath)
	if _, err := fmt.Fprintln(stdin, loadCmd); err != nil {
		return nil, fmt.Errorf("sharkd load send: %w", err)
	}
	loadLine, err := readJSON(reader)
	if err != nil {
		return nil, fmt.Errorf("sharkd load response: %w", err)
	}
	var loadResp struct {
		Result struct {
			Status string `json:"status"`
			Err    string `json:"err"`
		} `json:"result"`
		Error *struct{ Message string `json:"message"` } `json:"error"`
	}
	if err := json.Unmarshal(loadLine, &loadResp); err != nil {
		return nil, fmt.Errorf("sharkd load parse: %w", err)
	}
	if loadResp.Error != nil {
		return nil, fmt.Errorf("sharkd load error: %s", loadResp.Error.Message)
	}
	if loadResp.Result.Status != "OK" && loadResp.Result.Status != "" {
		return nil, fmt.Errorf("sharkd load status: %s %s", loadResp.Result.Status, loadResp.Result.Err)
	}

	// 2. Decode frame 1
	frameCmd := `{"jsonrpc":"2.0","id":2,"method":"frame","params":{"frame":1,"proto":true,"bytes":true}}`
	if _, err := fmt.Fprintln(stdin, frameCmd); err != nil {
		return nil, fmt.Errorf("sharkd frame send: %w", err)
	}
	frameLine, err := readJSON(reader)
	if err != nil {
		return nil, fmt.Errorf("sharkd frame response: %w", err)
	}
	var frameResp struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(frameLine, &frameResp); err != nil {
		return nil, fmt.Errorf("sharkd frame parse: %w", err)
	}
	if frameResp.Error != nil {
		return nil, fmt.Errorf("sharkd frame error: %s", frameResp.Error.Message)
	}
	return frameResp.Result, nil
}

// readJSON reads lines from r until it finds one that appears to be a JSON object.
func readJSON(r *bufio.Reader) ([]byte, error) {
	for {
		line, err := r.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" && (strings.HasPrefix(line, "{") || strings.HasPrefix(line, "[")) {
			return []byte(line), nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return b.String()
}
