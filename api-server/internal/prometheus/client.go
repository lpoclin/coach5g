package prometheus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	base string
	http *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		base: baseURL,
		http: &http.Client{Timeout: 15 * time.Second},
	}
}

// ─── Response types ────────────────────────────────────────────────────────────

type promResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string        `json:"resultType"`
		Result     []promResult  `json:"result"`
	} `json:"data"`
}

type promResult struct {
	Metric map[string]string `json:"metric"`
	Value  []interface{}     `json:"value"`  // [timestamp, value string]
	Values [][]interface{}   `json:"values"` // [[timestamp, value], ...]
}

// ─── Cluster metrics ──────────────────────────────────────────────────────────

type ClusterMetrics struct {
	CPUPercent    float64 `json:"cpuPercent"`
	MemoryPercent float64 `json:"memoryPercent"`
	PodsRunning   int     `json:"podsRunning"`
	PodsTotal     int     `json:"podsTotal"`
	NodesReady    int     `json:"nodesReady"`
	NodesTotal    int     `json:"nodesTotal"`
	PVCsTotal     int     `json:"pvcsTotal"`
	PVCsBound     int     `json:"pvcsBound"`
}

func (c *Client) ClusterMetrics(ctx context.Context) (*ClusterMetrics, error) {
	cpuPct,    _ := c.queryScalar(ctx, `(1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100`)
	memPct,    _ := c.queryScalar(ctx, `(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100`)
	podsRun,   _ := c.queryScalar(ctx, `count(kube_pod_status_phase{phase="Running"})`)
	podsTot,   _ := c.queryScalar(ctx, `count(kube_pod_info)`)
	nodesRdy,  _ := c.queryScalar(ctx, `count(kube_node_status_condition{condition="Ready",status="true"})`)
	nodesTot,  _ := c.queryScalar(ctx, `count(kube_node_info)`)
	pvcsBound, _ := c.queryScalar(ctx, `count(kube_persistentvolumeclaim_status_phase{phase="Bound"})`)
	pvcsTot,   _ := c.queryScalar(ctx, `count(kube_persistentvolumeclaim_info)`)

	return &ClusterMetrics{
		CPUPercent:    round1(cpuPct),
		MemoryPercent: round1(memPct),
		PodsRunning:   int(podsRun),
		PodsTotal:     int(podsTot),
		NodesReady:    int(nodesRdy),
		NodesTotal:    int(nodesTot),
		PVCsBound:     int(pvcsBound),
		PVCsTotal:     int(pvcsTot),
	}, nil
}

// ─── Time-series ──────────────────────────────────────────────────────────────

type TimePoint struct {
	Timestamp int64   `json:"timestamp"`
	Value     float64 `json:"value"`
}

type TimeSeries struct {
	CPUPercent    []TimePoint `json:"cpuPercent"`
	MemoryPercent []TimePoint `json:"memoryPercent"`
}

func (c *Client) TimeSeries(ctx context.Context, rangeStr string) (*TimeSeries, error) {
	step := "60s"
	dur := "1h"
	switch rangeStr {
	case "6h":
		dur = "6h"
		step = "300s"
	case "24h":
		dur = "24h"
		step = "900s"
	}

	cpuQ := `sum(rate(node_cpu_seconds_total{mode!="idle"}[5m]))`
	memQ := `1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)`

	cpuPts, _ := c.queryRange(ctx, cpuQ, dur, step)
	memPts, _ := c.queryRange(ctx, memQ, dur, step)

	return &TimeSeries{CPUPercent: cpuPts, MemoryPercent: memPts}, nil
}

// ─── Pod metrics ──────────────────────────────────────────────────────────────

func (c *Client) PodMetrics(ctx context.Context, namespace, pod string) (map[string]interface{}, error) {
	cpuQ := fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{namespace="%s",pod="%s",container!=""}[5m])) * 100`, namespace, pod)
	memQ := fmt.Sprintf(`sum(container_memory_working_set_bytes{namespace="%s",pod="%s",container!=""}) / 1048576`, namespace, pod)

	cpu, _ := c.queryScalar(ctx, cpuQ)
	mem, _ := c.queryScalar(ctx, memQ)

	return map[string]interface{}{
		"cpuPercent": round1(cpu),
		"memoryMi":   int(mem),
	}, nil
}

// ─── Node metrics ──────────────────────────────────────────────────────────────

type NodeMetric struct {
	CPUPercent  float64
	MemPercent  float64
	DiskPercent float64
	PodCount    int
}

// NodeMetrics returns metrics keyed by node internal IP (stripped of port).
// Callers match this against node.Status.Addresses[InternalIP].
func (c *Client) NodeMetrics(ctx context.Context) (map[string]NodeMetric, error) {
	// Proper per-instance aggregation (avg across all CPUs per node)
	cpuQ  := `(1 - avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100`
	memQ  := `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100`
	diskQ := `(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100`

	result := make(map[string]NodeMetric)

	// instance label is "IP:port" — find node IP by checking HasPrefix(instance, nodeIP+":")
	// Key result by the raw IP (stripped of port) so the handler can match by node InternalIP.
	nodeIPFromInstance := func(instance string) string {
		if i := strings.LastIndex(instance, ":"); i > 0 {
			return instance[:i]
		}
		return instance
	}

	addByInstance := func(q string, setter func(*NodeMetric, float64)) {
		resp, err := c.queryRaw(ctx, q)
		if err != nil {
			return
		}
		for _, r := range resp.Data.Result {
			ip := nodeIPFromInstance(r.Metric["instance"])
			if ip == "" {
				continue
			}
			val := parseValue(r.Value)
			m := result[ip]
			setter(&m, val)
			result[ip] = m
		}
	}

	addByInstance(cpuQ,  func(m *NodeMetric, v float64) { m.CPUPercent = round1(v) })
	addByInstance(memQ,  func(m *NodeMetric, v float64) { m.MemPercent = round1(v) })
	addByInstance(diskQ, func(m *NodeMetric, v float64) { m.DiskPercent = round1(v) })

	return result, nil
}

// ─── Interface drop rate (Hubble/Cilium) ──────────────────────────────────────

// InterfaceDropRate returns the Cilium/Hubble drop rate (%) for a given pod.
// Uses hubble_drop_total / hubble_flows_processed_total from Prometheus.
// Returns 0.0 when Hubble metrics are unavailable or the pod has no drops.
func (c *Client) InterfaceDropRate(ctx context.Context, pod string) float64 {
	if pod == "" {
		return 0
	}
	podPattern := ".*" + pod + ".*"
	// Hubble labels source/destination as "namespace/podname" — broad regex match
	dropQ := fmt.Sprintf(
		`sum(rate(hubble_drop_total{source=~%q}[30s])) /`+
			` clamp_min(sum(rate(hubble_flows_processed_total{source=~%q}[30s])), 0.001) * 100`,
		podPattern, podPattern,
	)
	drop, _ := c.queryScalar(ctx, dropQ)
	if drop < 0 {
		drop = 0
	}
	return round2(drop)
}

// NodePodCounts returns pod counts keyed by k8s node name.
func (c *Client) NodePodCounts(ctx context.Context) (map[string]int, error) {
	resp, err := c.queryRaw(ctx, `count by(node) (kube_pod_info)`)
	if err != nil {
		return nil, err
	}
	result := make(map[string]int)
	for _, r := range resp.Data.Result {
		node := r.Metric["node"]
		if node == "" {
			continue
		}
		result[node] = int(parseValue(r.Value))
	}
	return result, nil
}

// ─── Pod utilization ─────────────────────────────────────────────────────────

type PodMetricEntry struct {
	Namespace  string  `json:"namespace"`
	Pod        string  `json:"pod"`
	CPUUsedM   float64 `json:"cpuUsedM"`
	CPULimitM  float64 `json:"cpuLimitM"`
	RAMUsedMi  float64 `json:"ramUsedMi"`
	RAMLimitMi float64 `json:"ramLimitMi"`
}

func (c *Client) PodUtilization(ctx context.Context) ([]PodMetricEntry, error) {
	cpuUsedQ := `sum by(namespace, pod) (rate(container_cpu_usage_seconds_total{namespace!="",container!="",container!="POD"}[1m])) * 1000`
	cpuLimQ  := `sum by(namespace, pod) (kube_pod_container_resource_limits{resource="cpu",container!=""}) * 1000`
	ramUsedQ := `sum by(namespace, pod) (container_memory_working_set_bytes{namespace!="",container!="",container!="POD"}) / 1048576`
	ramLimQ  := `sum by(namespace, pod) (kube_pod_container_resource_limits{resource="memory",container!=""}) / 1048576`

	type podKey struct{ ns, pod string }
	pods := make(map[podKey]*PodMetricEntry)

	ensure := func(ns, pod string) *PodMetricEntry {
		k := podKey{ns, pod}
		if e, ok := pods[k]; ok {
			return e
		}
		e := &PodMetricEntry{Namespace: ns, Pod: pod}
		pods[k] = e
		return e
	}

	fill := func(q string, setter func(*PodMetricEntry, float64)) {
		resp, err := c.queryRaw(ctx, q)
		if err != nil {
			return
		}
		for _, r := range resp.Data.Result {
			ns  := r.Metric["namespace"]
			pod := r.Metric["pod"]
			if ns == "" || pod == "" {
				continue
			}
			setter(ensure(ns, pod), parseValue(r.Value))
		}
	}

	fill(cpuUsedQ, func(e *PodMetricEntry, v float64) { e.CPUUsedM  = round1(v) })
	fill(cpuLimQ,  func(e *PodMetricEntry, v float64) { e.CPULimitM = round1(v) })
	fill(ramUsedQ, func(e *PodMetricEntry, v float64) { e.RAMUsedMi  = round1(v) })
	fill(ramLimQ,  func(e *PodMetricEntry, v float64) { e.RAMLimitMi = round1(v) })

	result := make([]PodMetricEntry, 0, len(pods))
	for _, e := range pods {
		result = append(result, *e)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Namespace != result[j].Namespace {
			return result[i].Namespace < result[j].Namespace
		}
		return result[i].Pod < result[j].Pod
	})
	return result, nil
}

// ─── Internal query helpers ───────────────────────────────────────────────────

func (c *Client) queryScalar(ctx context.Context, query string) (float64, error) {
	resp, err := c.queryRaw(ctx, query)
	if err != nil || len(resp.Data.Result) == 0 {
		return 0, err
	}
	return parseValue(resp.Data.Result[0].Value), nil
}

func (c *Client) queryRange(ctx context.Context, query, dur, step string) ([]TimePoint, error) {
	now := time.Now()
	startTime, _ := parseDuration(dur)
	start := now.Add(-startTime)

	params := url.Values{}
	params.Set("query", query)
	params.Set("start", fmt.Sprintf("%d", start.Unix()))
	params.Set("end",   fmt.Sprintf("%d", now.Unix()))
	params.Set("step",  step)

	reqURL := strings.TrimRight(c.base, "/") + "/api/v1/query_range?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result promResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	if len(result.Data.Result) == 0 {
		return []TimePoint{}, nil
	}

	pts := make([]TimePoint, 0)
	for _, v := range result.Data.Result[0].Values {
		if len(v) < 2 {
			continue
		}
		ts, _ := v[0].(float64)
		valStr, _ := v[1].(string)
		val, _ := strconv.ParseFloat(valStr, 64)
		pts = append(pts, TimePoint{
			Timestamp: int64(ts) * 1000, // ms
			Value:     round1(val),
		})
	}
	return pts, nil
}

func (c *Client) queryRaw(ctx context.Context, query string) (*promResponse, error) {
	params := url.Values{}
	params.Set("query", query)

	reqURL := strings.TrimRight(c.base, "/") + "/api/v1/query?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("prometheus request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("prometheus %d: %s", resp.StatusCode, string(body))
	}

	var result promResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func parseValue(v []interface{}) float64 {
	if len(v) < 2 {
		return 0
	}
	s, _ := v[1].(string)
	val, _ := strconv.ParseFloat(s, 64)
	return val
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round2(v float64) float64 { return math.Round(v*100) / 100 }

func parseDuration(s string) (time.Duration, error) {
	switch s {
	case "1h":
		return time.Hour, nil
	case "6h":
		return 6 * time.Hour, nil
	case "24h":
		return 24 * time.Hour, nil
	}
	return time.Hour, nil
}
