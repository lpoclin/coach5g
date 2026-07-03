package handlers

import (
	"math"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
	"k8s.io/client-go/kubernetes"

	"github.com/lpoclin/coach5g/api-server/internal/capture"
	"github.com/lpoclin/coach5g/api-server/internal/k8s"
	"github.com/lpoclin/coach5g/api-server/internal/prometheus"
)

type MetricsHandler struct {
	prom *prometheus.Client
	cap  *capture.Server
	cs   *kubernetes.Clientset
}

func NewMetricsHandler(p *prometheus.Client, cap *capture.Server, cs *kubernetes.Clientset) *MetricsHandler {
	return &MetricsHandler{prom: p, cap: cap, cs: cs}
}

// GET /api/metrics/cluster
func (h *MetricsHandler) GetClusterMetrics(c *gin.Context) {
	m, err := h.prom.ClusterMetrics(c.Request.Context())
	if err != nil {
		log.Warn().Err(err).Msg("cluster metrics")
		c.JSON(http.StatusOK, defaultClusterMetrics())
		return
	}
	c.JSON(http.StatusOK, m)
}

// GET /api/metrics/timeseries?range=1h
func (h *MetricsHandler) GetTimeSeries(c *gin.Context) {
	r := c.Query("range")
	if r == "" {
		r = "1h"
	}
	ts, err := h.prom.TimeSeries(c.Request.Context(), r)
	if err != nil {
		log.Warn().Err(err).Msg("timeseries")
		c.JSON(http.StatusOK, map[string]interface{}{
			"cpuPercent":    []interface{}{},
			"memoryPercent": []interface{}{},
		})
		return
	}
	c.JSON(http.StatusOK, ts)
}

// GET /api/metrics/pod/:namespace/:pod
func (h *MetricsHandler) GetPodMetrics(c *gin.Context) {
	ns := c.Param("namespace")
	pod := c.Param("pod")
	m, err := h.prom.PodMetrics(c.Request.Context(), ns, pod)
	if err != nil {
		log.Warn().Err(err).Msg("pod metrics")
		c.JSON(http.StatusOK, map[string]interface{}{"cpuPercent": 0, "memoryMi": 0})
		return
	}
	c.JSON(http.StatusOK, m)
}

// GET /api/metrics/interface?pod=PODNAME&interface=IFACE
//
// Source 1 — capture ring buffer (pps + throughput):
//
//	Real per-interface data from tcpdump flowing through the api-server gRPC fan-out.
//	Returns live values when the capture-agent is running; 0 otherwise.
//
// Source 2 — Hubble/Cilium Prometheus (drop rate):
//
//	Pod-level drop rate from hubble_drop_total / hubble_flows_processed_total.
//	Returns 0 when Hubble metrics are unavailable.
func (h *MetricsHandler) GetInterfaceMetrics(c *gin.Context) {
	pod   := c.Query("pod")
	iface := c.Query("interface")
	if iface == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "interface param required"})
		return
	}

	// Source 1: ring-buffer pps and throughput
	pps, throughputMbps := h.cap.TrafficStats(pod, iface)

	// Source 2: Hubble drop rate — only meaningful on the primary Cilium interface (eth0).
	// Multus secondary interfaces and non-Cilium clusters have no Hubble telemetry.
	primaryCNI := k8s.DetectPrimaryCNI(c.Request.Context(), h.cs)
	isCilium := primaryCNI == "Cilium" && iface == "eth0"

	var dropRate float64
	if isCilium {
		dropRate = h.prom.InterfaceDropRate(c.Request.Context(), pod)
	}

	log.Debug().
		Str("pod", pod).Str("iface", iface).
		Float64("pps", pps).Float64("mbps", throughputMbps).Float64("drop%", dropRate).
		Bool("isCilium", isCilium).
		Msg("interface metrics")

	c.JSON(http.StatusOK, map[string]interface{}{
		"throughputMbps": r2(throughputMbps),
		"packetsPerSec":  r1(pps),
		"dropRate":       dropRate,
		"isCilium":       isCilium,
	})
}

// GET /api/metrics/active
// Returns all pod+interface pairs that have received packets in the last 300ms.
func (h *MetricsHandler) GetActiveTraffic(c *gin.Context) {
	pairs := h.cap.ActivePairs()
	type item struct {
		Pod   string `json:"pod"`
		Iface string `json:"iface"`
	}
	out := make([]item, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, item{Pod: p.PodName, Iface: p.Iface})
	}
	c.JSON(http.StatusOK, gin.H{"active": out})
}

// GET /api/metrics/pods
func (h *MetricsHandler) GetPodsUtilization(c *gin.Context) {
	pods, err := h.prom.PodUtilization(c.Request.Context())
	if err != nil {
		log.Warn().Err(err).Msg("pod utilization")
		c.JSON(http.StatusOK, []interface{}{})
		return
	}
	c.JSON(http.StatusOK, pods)
}

func r1(v float64) float64 { return math.Round(v*10) / 10 }
func r2(v float64) float64 { return math.Round(v*100) / 100 }

func defaultClusterMetrics() map[string]interface{} {
	return map[string]interface{}{
		"cpuPercent": 0, "memoryPercent": 0,
		"podsRunning": 0, "podsTotal": 0,
		"nodesReady": 0, "nodesTotal": 0,
		"pvcsTotal": 0, "pvcsBound": 0,
	}
}
