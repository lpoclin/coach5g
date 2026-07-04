package handlers

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	k8stopo "github.com/lpoclin/coach5g/api-server/internal/k8s"
	"github.com/lpoclin/coach5g/api-server/internal/k8s/coreprofile"
)

// allowedOrigins mirrors cmd/server/main.go's own ALLOWED_ORIGINS parsing
// (duplicated rather than shared across packages, consistent with how this
// codebase already parses TARGET_NAMESPACES independently in more than one
// place). Read once at package init so every /ws/* handler sharing upgrader
// gets the same check with no per-handler changes.
var allowedOrigins = parseAllowedOrigins(os.Getenv("ALLOWED_ORIGINS"))

// parseAllowedOrigins splits a comma-separated origin list, trimming
// whitespace and dropping empty entries.
func parseAllowedOrigins(raw string) []string {
	var out []string
	for _, o := range strings.Split(raw, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out = append(out, o)
		}
	}
	return out
}

// originAllowed reports whether origin is an exact match for one of the
// configured allowed origins.
func originAllowed(origin string, allowed []string) bool {
	for _, a := range allowed {
		if origin == a {
			return true
		}
	}
	return false
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Non-browser clients don't send an Origin header at all; that's not
		// the cross-site-WebSocket-hijacking vector this check defends
		// against, so absence of Origin is allowed, matching gorilla/
		// websocket's own built-in default behavior.
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		return originAllowed(origin, allowedOrigins)
	},
	ReadBufferSize:  1024,
	WriteBufferSize: 32 * 1024,
}

type TopologyHandler struct {
	cs               *kubernetes.Clientset
	targetNamespaces []string
	profile          coreprofile.CoreProfile
}

func NewTopologyHandler(cs *kubernetes.Clientset, targetNamespaces []string, profile coreprofile.CoreProfile) *TopologyHandler {
	return &TopologyHandler{cs: cs, targetNamespaces: targetNamespaces, profile: profile}
}

var systemNamespaces = map[string]bool{
	"kube-system": true, "kube-public": true, "kube-node-lease": true,
	"monitoring": true, "longhorn-system": true, "cert-manager": true,
	"loki": true, "observer": true,
}

var nfKeywords = []string{
	"amf", "smf", "upf", "nrf", "ausf", "udm", "udr",
	"pcf", "nssf", "chf", "nef", "gnb", "n3iwf", "nwdaf", "scp", "sepp",
}

var infraKeywords = []string{"mongodb", "mysql", "postgres", "redis", "etcd"}

func isPodNF(pod *corev1.Pod) bool {
	if nfVal, ok := pod.Labels["nf"]; ok {
		return strings.ToLower(nfVal) != "webui"
	}
	if comp, ok := pod.Labels["component"]; ok {
		c := strings.ToLower(comp)
		if c == "gnb" || c == "ue" {
			return true
		}
	}
	name := strings.ToLower(pod.Name)
	for _, kw := range infraKeywords {
		if strings.Contains(name, kw) {
			return false
		}
	}
	for _, kw := range nfKeywords {
		if strings.Contains(name, kw) {
			return true
		}
	}
	return false
}

// resolveNamespaces returns the namespaces to query for topology.
// Priority 1: TARGET_NAMESPACES env var (already parsed into h.targetNamespaces).
// Priority 2: auto-detect by scanning non-system namespaces for 5G NF pods.
// Last resort: ["free5gc"].
func (h *TopologyHandler) resolveNamespaces(ctx context.Context) []string {
	if len(h.targetNamespaces) > 0 {
		return h.targetNamespaces
	}

	nsList, err := h.cs.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		log.Warn().Err(err).Msg("resolveNamespaces: cannot list namespaces, using fallback")
		return []string{"free5gc"}
	}

	var result []string
	for _, ns := range nsList.Items {
		if systemNamespaces[ns.Name] {
			continue
		}
		pods, err := h.cs.CoreV1().Pods(ns.Name).List(ctx, metav1.ListOptions{})
		if err != nil {
			continue
		}
		for i := range pods.Items {
			if isPodNF(&pods.Items[i]) {
				result = append(result, ns.Name)
				break
			}
		}
	}

	if len(result) == 0 {
		return []string{"free5gc"}
	}
	return result
}

// namespaceFromQuery resolves the namespace list for a request.
// If ?namespace=X is provided it takes priority (backward compatibility).
// Otherwise resolveNamespaces() is used.
func (h *TopologyHandler) namespaceFromQuery(c *gin.Context) []string {
	if ns := c.Query("namespace"); ns != "" {
		return strings.Split(ns, ",")
	}
	return h.resolveNamespaces(c.Request.Context())
}

// GET /api/topology?namespace=free5gc[,other]
func (h *TopologyHandler) GetTopology(c *gin.Context) {
	namespaces := h.namespaceFromQuery(c)

	graph, err := k8stopo.BuildTopology(c.Request.Context(), h.cs, namespaces, h.profile)
	if err != nil {
		log.Error().Err(err).Msg("build topology")
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, graph)
}

// GET /api/namespaces
func (h *TopologyHandler) GetNamespaces(c *gin.Context) {
	nsList, err := h.cs.CoreV1().Namespaces().List(c.Request.Context(), listOpts())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	names := make([]string, 0, len(nsList.Items))
	for _, ns := range nsList.Items {
		names = append(names, ns.Name)
	}
	c.JSON(http.StatusOK, names)
}

// GET /api/pods/:namespace
func (h *TopologyHandler) GetPods(c *gin.Context) {
	ns := c.Param("namespace")
	graph, err := k8stopo.BuildTopology(c.Request.Context(), h.cs, []string{ns}, h.profile)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, graph.Nodes)
}

// GET /api/pod/:namespace/:pod/interfaces
func (h *TopologyHandler) GetPodInterfaces(c *gin.Context) {
	ns := c.Param("namespace")
	podName := c.Param("pod")

	pod, err := h.cs.CoreV1().Pods(ns).Get(c.Request.Context(), podName, getOpts())
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	node := k8stopo.PodToNodeExported(pod, h.profile)
	if node == nil {
		c.JSON(http.StatusOK, []interface{}{})
		return
	}
	c.JSON(http.StatusOK, node.Interfaces)
}

// GET /ws/topology?namespace=free5gc  — push updates every 5s
func (h *TopologyHandler) WatchTopology(c *gin.Context) {
	namespaces := h.namespaceFromQuery(c)

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("ws upgrade")
		return
	}
	defer conn.Close()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	// Send immediately on connect
	sendTopology(conn, h.cs, namespaces, h.profile)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			sendTopology(conn, h.cs, namespaces, h.profile)
		}
	}
}

func sendTopology(conn *websocket.Conn, cs *kubernetes.Clientset, namespaces []string, profile coreprofile.CoreProfile) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	graph, err := k8stopo.BuildTopology(ctx, cs, namespaces, profile)
	if err != nil {
		log.Error().Err(err).Msg("topology watch")
		return
	}

	type envelope struct {
		Type string      `json:"type"`
		Data interface{} `json:"data"`
	}
	if err := conn.WriteJSON(envelope{Type: "topology", Data: graph}); err != nil {
		log.Debug().Err(err).Msg("topology ws write")
	}
}
