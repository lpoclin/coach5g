package handlers

import (
	"math"
	"net/http"
	"os"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/lpoclin/coach5g/api-server/internal/prometheus"
)

type InfraHandler struct {
	cs   *kubernetes.Clientset
	prom *prometheus.Client
}

func NewInfraHandler(cs *kubernetes.Clientset, prom *prometheus.Client) *InfraHandler {
	return &InfraHandler{cs: cs, prom: prom}
}

// GET /api/nodes
func (h *InfraHandler) GetNodes(c *gin.Context) {
	ctx := c.Request.Context()
	nodes, err := h.cs.CoreV1().Nodes().List(ctx, listOpts())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Prometheus metrics keyed by node IP (NodeMetrics) and by node name (pod counts)
	promMetrics, _ := h.prom.NodeMetrics(ctx)
	podCounts,   _ := h.prom.NodePodCounts(ctx)

	result := make([]map[string]interface{}, 0, len(nodes.Items))
	for _, node := range nodes.Items {
		role := "worker"
		for label := range node.Labels {
			if label == "node-role.kubernetes.io/control-plane" || label == "node-role.kubernetes.io/master" {
				role = "control-plane"
			}
		}
		if r, ok := node.Labels["role"]; ok {
			role = r
		}

		isReady := false
		for _, cond := range node.Status.Conditions {
			if cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue {
				isReady = true
			}
		}

		allocCPU := node.Status.Allocatable.Cpu().MilliValue()
		allocMem := node.Status.Allocatable.Memory().Value()
		capMem   := node.Status.Capacity.Memory().Value()
		capDisk  := node.Status.Capacity.StorageEphemeral().Value()

		nodeName := node.Name

		// Collect internal IP for prometheus metric lookup (keyed by IP, not name)
		ip := ""
		for _, addr := range node.Status.Addresses {
			if addr.Type == corev1.NodeInternalIP {
				ip = addr.Address
				break
			}
		}

		cpuPct, memPct, diskPct := 0.0, 0.0, 0.0
		if m, ok := promMetrics[ip]; ok {
			cpuPct  = m.CPUPercent
			memPct  = m.MemPercent
			diskPct = m.DiskPercent
		}

		podCount := podCounts[nodeName]

		ni := node.Status.NodeInfo
		cpuCores     := node.Status.Capacity.Cpu().Value()
		totalMemBytes := node.Status.Capacity.Memory().Value()

		statusStr := "NotReady"
		if isReady {
			statusStr = "Ready"
		}

		podAlloc := node.Status.Allocatable.Pods()
		podCap := int64(110)
		if podAlloc != nil {
			podCap = podAlloc.Value()
		}

		result = append(result, map[string]interface{}{
			"name":   nodeName,
			"role":   role,
			"status": statusStr,
			"ip":     ip,
			"cpu": map[string]interface{}{
				"capacity":    float64(allocCPU) / 1000,
				"allocatable": float64(allocCPU) / 1000,
				"used":        float64(allocCPU) / 1000 * cpuPct / 100,
				"percent":     math.Round(cpuPct*10) / 10,
			},
			"memory": map[string]interface{}{
				"capacityBytes":    capMem,
				"allocatableBytes": allocMem,
				"usedBytes":        int64(float64(allocMem) * memPct / 100),
				"percent":          math.Round(memPct*10) / 10,
			},
			"disk": map[string]interface{}{
				"capacityBytes": capDisk,
				"usedBytes":     int64(float64(capDisk) * diskPct / 100),
				"percent":       math.Round(diskPct*10) / 10,
			},
			// Stack info
			"kubeletVersion":    ni.KubeletVersion,
			"osImage":           ni.OSImage,
			"kernelVersion":     ni.KernelVersion,
			"containerRuntime":  ni.ContainerRuntimeVersion,
			"architecture":      ni.Architecture,
			"cpuCores":          cpuCores,
			"totalMemoryGiB":    math.Round(float64(totalMemBytes)/1073741824*10) / 10,
			"podCount":          podCount,
			"podCapacity":       podCap,
			"createdAt":         node.CreationTimestamp.UTC().Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, result)
}

// GET /api/events[/:namespace]
func (h *InfraHandler) GetEvents(c *gin.Context) {
	ns := c.Param("namespace") // may be empty → all namespaces

	events, err := h.cs.CoreV1().Events(ns).List(c.Request.Context(), listOpts())
	if err != nil {
		log.Warn().Err(err).Msg("list events")
		c.JSON(http.StatusOK, []interface{}{})
		return
	}

	// Sort by lastTimestamp desc
	items := events.Items
	sort.Slice(items, func(i, j int) bool {
		return items[i].LastTimestamp.After(items[j].LastTimestamp.Time)
	})

	result := make([]map[string]interface{}, 0, len(items))
	for _, ev := range items {
		result = append(result, map[string]interface{}{
			"name":      ev.Name,
			"namespace": ev.Namespace,
			"type":      ev.Type,
			"reason":    ev.Reason,
			"message":   ev.Message,
			"involvedObject": map[string]interface{}{
				"kind":      ev.InvolvedObject.Kind,
				"name":      ev.InvolvedObject.Name,
				"namespace": ev.InvolvedObject.Namespace,
			},
			"count":     ev.Count,
			"firstTime": ev.FirstTimestamp.Format(time.RFC3339),
			"lastTime":  ev.LastTimestamp.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, result)
}

// GET /api/pvcs
func (h *InfraHandler) GetPVCs(c *gin.Context) {
	pvcs, err := h.cs.CoreV1().PersistentVolumeClaims("").List(c.Request.Context(), listOpts())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	result := make([]map[string]interface{}, 0, len(pvcs.Items))
	for _, pvc := range pvcs.Items {
		cap := ""
		if storage, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
			cap = storage.String()
		}
		result = append(result, map[string]interface{}{
			"name":        pvc.Name,
			"namespace":   pvc.Namespace,
			"status":      string(pvc.Status.Phase),
			"capacity":    cap,
			"storageClass": pvc.Spec.StorageClassName,
			"volumeName":  pvc.Spec.VolumeName,
			"accessModes": pvc.Spec.AccessModes,
		})
	}
	c.JSON(http.StatusOK, result)
}

// GET /api/cluster-info — returns cluster-level stack facts from env vars + oldest node timestamp
func (h *InfraHandler) GetClusterInfo(c *gin.Context) {
	clusterCreatedAt := ""
	if nodes, err := h.cs.CoreV1().Nodes().List(c.Request.Context(), listOpts()); err == nil && len(nodes.Items) > 0 {
		oldest := nodes.Items[0].CreationTimestamp.Time
		for _, n := range nodes.Items[1:] {
			if n.CreationTimestamp.Time.Before(oldest) {
				oldest = n.CreationTimestamp.Time
			}
		}
		clusterCreatedAt = oldest.UTC().Format(time.RFC3339)
	}

	c.JSON(http.StatusOK, map[string]interface{}{
		"hypervisor":       envStr("CLUSTER_HYPERVISOR", ""),
		"cniPrimary":       envStr("CLUSTER_CNI_PRIMARY", "Cilium"),
		"cniSecondary":     envStr("CLUSTER_CNI_SECONDARY", ""),
		"clusterCreatedAt": clusterCreatedAt,
	})
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// GET /api/namespace-stats
func (h *InfraHandler) GetNamespaceStats(c *gin.Context) {
	pods, err := h.cs.CoreV1().Pods("").List(c.Request.Context(), listOpts())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	type stat struct {
		running, pending, failed, restarting int
	}
	stats := make(map[string]*stat)

	for _, pod := range pods.Items {
		ns := pod.Namespace
		if _, ok := stats[ns]; !ok {
			stats[ns] = &stat{}
		}
		s := stats[ns]
		switch pod.Status.Phase {
		case corev1.PodRunning:
			s.running++
		case corev1.PodPending:
			s.pending++
		case corev1.PodFailed:
			s.failed++
		}
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.RestartCount > 3 {
				s.restarting++
				break
			}
		}
	}

	result := make([]map[string]interface{}, 0, len(stats))
	for ns, s := range stats {
		result = append(result, map[string]interface{}{
			"namespace":  ns,
			"running":    s.running,
			"pending":    s.pending,
			"failed":     s.failed,
			"restarting": s.restarting,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i]["namespace"].(string) < result[j]["namespace"].(string)
	})
	c.JSON(http.StatusOK, result)
}
