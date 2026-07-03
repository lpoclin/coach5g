package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"github.com/lpoclin/coach5g/api-server/internal/capture"
)

// getDefaultNamespace returns the first namespace from TARGET_NAMESPACES env, or "free5gc".
func getDefaultNamespace() string {
	ns := os.Getenv("TARGET_NAMESPACES")
	if idx := strings.Index(ns, ","); idx >= 0 {
		return ns[:idx]
	}
	if ns != "" {
		return ns
	}
	return "free5gc"
}

// PacketsHandler streams decoded packets from the gRPC fan-out server to WebSocket.
type PacketsHandler struct {
	srv *capture.Server
}

func NewPacketsHandler(srv *capture.Server) *PacketsHandler {
	return &PacketsHandler{srv: srv}
}

// StreamPackets — GET /ws/packets/:node/:pod/:interface
func (h *PacketsHandler) StreamPackets(c *gin.Context) {
	node  := c.Param("node")
	pod   := c.Param("pod")
	iface := c.Param("interface")

	log.Debug().Str("node", node).Str("pod", pod).Str("iface", iface).Msg("packet ws: upgrading")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Str("pod", pod).Str("iface", iface).Msg("packet ws: upgrade failed")
		return
	}
	defer conn.Close()

	key := capture.SessionKey{Node: node, PodName: pod, Iface: iface}
	log.Debug().Str("node", node).Str("pod", pod).Str("iface", iface).
		Msg("packet ws: subscribing to capture session")

	ch, unsub := h.srv.RegisterSubscriber(key)

	sessionID := fmt.Sprintf("%s/%s/%s", getDefaultNamespace(), pod, iface)

	if h.srv.GetSubCount(key) == 1 {
		log.Info().Str("session", sessionID).Msg("first subscriber: enabling tshark")
		go h.srv.CallEnableTshark(pod, iface, sessionID)
	}

	defer func() {
		unsub()
		if h.srv.GetSubCount(key) == 0 {
			log.Info().Str("session", sessionID).Msg("last subscriber gone: disabling tshark")
			go h.srv.CallDisableTshark(pod, iface, sessionID)
		}
	}()

	log.Info().Str("node", node).Str("pod", pod).Str("iface", iface).Msg("packet ws stream started")

	// Drain client pings / close frames in a separate goroutine
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	type wirePacket struct {
		Timestamp     string `json:"ts"` // sent as string to preserve int64 precision in JS
		SrcIP         string `json:"src_ip"`
		DstIP         string `json:"dst_ip"`
		SrcPort       uint32 `json:"src_port"`
		DstPort       uint32 `json:"dst_port"`
		Protocol      string `json:"protocol"`
		Length        uint32 `json:"length"`
		Info          string `json:"info"`
		Raw           []byte `json:"raw,omitempty"`
		InterfaceName string `json:"iface"`
		PodName       string `json:"pod"`
		Namespace     string `json:"ns"`
		Node          string `json:"node"`
	}

	for {
		select {
		case <-done:
			return
		case pkts, ok := <-ch:
			if !ok {
				log.Debug().Str("pod", pod).Str("iface", iface).Msg("packet ws: channel closed")
				return
			}
			log.Debug().Str("pod", pod).Str("iface", iface).Int("count", len(pkts)).Msg("packet ws: forwarding batch")
			wire := make([]wirePacket, len(pkts))
			for i, p := range pkts {
				wire[i] = wirePacket{
					Timestamp: strconv.FormatInt(p.TimestampNs, 10),
					SrcIP: p.SrcIP, DstIP: p.DstIP,
					SrcPort: p.SrcPort, DstPort: p.DstPort, Protocol: p.Protocol,
					Length: p.Length, Info: p.Info, Raw: p.Raw,
					InterfaceName: p.InterfaceName, PodName: p.PodName,
					Namespace: p.Namespace, Node: p.Node,
				}
			}
			if err := conn.WriteJSON(map[string]interface{}{
				"type": "packets",
				"data": wire,
			}); err != nil {
				return
			}
		}
	}
}

// StreamPacketsQuery — GET /ws/packets?pod=PODNAME&interface=IFACE
// Always-live capture: connects immediately, no Start/Stop.
// Subscribes via wildcard (any node) for the given pod+interface.
// Sends batches as {"type":"packets","data":[...]} for WS protocol compatibility.
// Accepts {"type":"clear"} from client — handled client-side only; logged here.
func (h *PacketsHandler) StreamPacketsQuery(c *gin.Context) {
	pod   := c.Query("pod")
	iface := c.Query("interface")

	if pod == "" || iface == "" {
		c.String(http.StatusBadRequest, "pod and interface query params required")
		return
	}

	log.Debug().Str("pod", pod).Str("iface", iface).Msg("packet ws query: upgrading")

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Str("pod", pod).Str("iface", iface).Msg("packet ws query: upgrade failed")
		return
	}
	defer conn.Close()

	ch, unsub := h.srv.RegisterWildcardSubscriber(pod, iface)

	ns := getDefaultNamespace()
	sessionID := fmt.Sprintf("%s/%s/%s", ns, pod, iface)

	// 0→1: first viewer — enable tshark on capture-agent
	if h.srv.GetWildcardSubCount(pod, iface) == 1 {
		log.Info().Str("session", sessionID).Msg("first subscriber: enabling tshark")
		go h.srv.CallEnableTshark(pod, iface, sessionID)
	}

	defer func() {
		unsub()
		// N→0: last viewer left — disable tshark
		if h.srv.GetWildcardSubCount(pod, iface) == 0 {
			log.Info().Str("session", sessionID).Msg("last subscriber gone: disabling tshark")
			go h.srv.CallDisableTshark(pod, iface, sessionID)
		}
	}()

	log.Info().Str("pod", pod).Str("iface", iface).Msg("packet ws query stream started")

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var cmd struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(msg, &cmd) == nil && cmd.Type == "clear" {
				log.Debug().Str("pod", pod).Str("iface", iface).Msg("packet ws query: client clear")
			}
		}
	}()

	type wirePacket struct {
		Timestamp     string `json:"ts"` // sent as string to preserve int64 precision in JS
		SrcIP         string `json:"src_ip"`
		DstIP         string `json:"dst_ip"`
		SrcPort       uint32 `json:"src_port"`
		DstPort       uint32 `json:"dst_port"`
		Protocol      string `json:"protocol"`
		Length        uint32 `json:"length"`
		Info          string `json:"info"`
		Raw           []byte `json:"raw,omitempty"`
		InterfaceName string `json:"iface"`
		PodName       string `json:"pod"`
		Namespace     string `json:"ns"`
		Node          string `json:"node"`
	}

	for {
		select {
		case <-done:
			return
		case pkts, ok := <-ch:
			if !ok {
				return
			}
			log.Debug().Str("pod", pod).Str("iface", iface).Int("count", len(pkts)).Msg("packet ws query: forwarding")
			wire := make([]wirePacket, len(pkts))
			for i, p := range pkts {
				wire[i] = wirePacket{
					Timestamp: strconv.FormatInt(p.TimestampNs, 10),
					SrcIP: p.SrcIP, DstIP: p.DstIP,
					SrcPort: p.SrcPort, DstPort: p.DstPort, Protocol: p.Protocol,
					Length: p.Length, Info: p.Info, Raw: p.Raw,
					InterfaceName: p.InterfaceName, PodName: p.PodName,
					Namespace: p.Namespace, Node: p.Node,
				}
			}
			if err := conn.WriteJSON(map[string]interface{}{
				"type": "packets",
				"data": wire,
			}); err != nil {
				return
			}
		}
	}
}
