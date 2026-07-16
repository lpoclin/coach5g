package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/lpoclin/coach5g/api-server/internal/k8s/coreprofile"
)

// ─── Model types ──────────────────────────────────────────────────────────────
// Canonical definitions now live in package coreprofile (shared with
// CoreProfile implementations); these are type/const aliases so the rest of
// this file's existing code keeps working unqualified. See
// docs/NF_CLASSIFICATION_REFACTOR_ASSESSMENT.md for why.

type (
	NFType           = coreprofile.NFType
	Plane            = coreprofile.Plane
	PodPhase         = coreprofile.PodPhase
	PodCondition     = coreprofile.PodCondition
	PodStatus        = coreprofile.PodStatus
	NetworkInterface = coreprofile.NetworkInterface
	TopologyNode     = coreprofile.TopologyNode
	TopologyEdge     = coreprofile.TopologyEdge
	TopologyGraph    = coreprofile.TopologyGraph
)

const (
	NFTypeNRF     = coreprofile.NFTypeNRF
	NFTypeAMF     = coreprofile.NFTypeAMF
	NFTypeSMF     = coreprofile.NFTypeSMF
	NFTypeAUSF    = coreprofile.NFTypeAUSF
	NFTypeUDM     = coreprofile.NFTypeUDM
	NFTypeUDR     = coreprofile.NFTypeUDR
	NFTypePCF     = coreprofile.NFTypePCF
	NFTypeNSSF    = coreprofile.NFTypeNSSF
	NFTypeCHF     = coreprofile.NFTypeCHF
	NFTypeNEF     = coreprofile.NFTypeNEF
	NFTypeSCP     = coreprofile.NFTypeSCP
	NFTypeBSF     = coreprofile.NFTypeBSF
	NFTypeUPF     = coreprofile.NFTypeUPF
	NFTypeIUPF    = coreprofile.NFTypeIUPF
	NFTypeGNB     = coreprofile.NFTypeGNB
	NFTypeUE      = coreprofile.NFTypeUE
	NFTypeDN      = coreprofile.NFTypeDN
	NFTypeUnknown = coreprofile.NFTypeUnknown

	PlaneSBI        = coreprofile.PlaneSBI
	PlaneUserPlane  = coreprofile.PlaneUserPlane
	PlaneRAN        = coreprofile.PlaneRAN
	PlanePFCP       = coreprofile.PlanePFCP
	PlaneManagement = coreprofile.PlaneManagement

	PodPhaseRunning = coreprofile.PodPhaseRunning
	PodPhasePending = coreprofile.PodPhasePending
	PodPhaseFailed  = coreprofile.PodPhaseFailed
	PodPhaseUnknown = coreprofile.PodPhaseUnknown

	CondRunning          = coreprofile.CondRunning
	CondCrashLoopBackOff = coreprofile.CondCrashLoopBackOff
	CondOOMKilled        = coreprofile.CondOOMKilled
	CondError            = coreprofile.CondError
	CondPending          = coreprofile.CondPending
	CondUnknown          = coreprofile.CondUnknown
)

// ─── Network-status annotation types ─────────────────────────────────────────

type netStatus struct {
	Name      string   `json:"name"`
	Interface string   `json:"interface"`
	IPs       []string `json:"ips"`
	MAC       string   `json:"mac"`
	Default   bool     `json:"default"`
}

// ─── NF classification ────────────────────────────────────────────────────────
// Moved to package coreprofile (Free5GCProfile.ClassifyNF for the
// free5GC-specific steps, coreprofile.ClassifyNF for the dispatcher and
// shared generic fallback). See docs/NF_CLASSIFICATION_REFACTOR_ASSESSMENT.md.

// dedupVendorPrefixes are pod-name segments that carry no distinguishing information.
var dedupVendorPrefixes = map[string]bool{
	"free5gc": true, "open5gs": true, "oai": true, "towards5gs": true,
}

// dedupNFKeywords are NF-type segments that are already encoded in DisplayName.
var dedupNFKeywords = map[string]bool{
	"amf": true, "smf": true, "upf": true, "nrf": true, "ausf": true,
	"udm": true, "udr": true, "nssf": true, "pcf": true, "chf": true,
	"nef": true, "gnb": true, "ue": true, "webui": true, "iupf": true, "psaupf": true,
	"scp": true, "bsf": true,
}

func isHexHash(s string) bool {
	if len(s) < 5 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func isK8sRandomSuffix(s string) bool {
	if len(s) > 5 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	return true
}

// deduplicateDisplayNames assigns distinguishing suffixes to nodes that share a
// displayName within the same namespace. Pods that carry an explicit "nf" or
// "component" label are skipped (their displayName is already authoritative).
//
// Three strategies tried in order:
//   A – integer segment extracted from pod name (e.g. upf-0, upf-1)
//   B – unique meaningful segment from pod name (e.g. "slice1", "edge")
//   C – creation-time rank (oldest = 1)
func deduplicateDisplayNames(nodes []TopologyNode, created map[string]time.Time) {
	type groupKey struct{ ns, name string }

	groups := make(map[groupKey][]int)
	for i, n := range nodes {
		if n.NFType == NFTypeDN {
			continue
		}
		if _, hasNF := n.Labels["nf"]; hasNF {
			continue
		}
		if _, hasComp := n.Labels["component"]; hasComp {
			continue
		}
		k := groupKey{n.Namespace, n.DisplayName}
		groups[k] = append(groups[k], i)
	}

	for _, idxs := range groups {
		if len(idxs) < 2 {
			continue
		}

		// ── Step A: single integer segment ───────────────────────────────────
		allInts := true
		intVals := make([]int, len(idxs))
		for j, idx := range idxs {
			segs := strings.Split(nodes[idx].PodName, "-")
			found, count := 0, 0
			for _, seg := range segs {
				if v, err := strconv.Atoi(seg); err == nil {
					found = v
					count++
				}
			}
			if count != 1 {
				allInts = false
				break
			}
			intVals[j] = found
		}
		if allInts {
			minV := intVals[0]
			for _, v := range intVals[1:] {
				if v < minV {
					minV = v
				}
			}
			if minV == 0 {
				for j := range intVals {
					intVals[j]++
				}
			}
			uniq := make(map[int]bool, len(intVals))
			unique := true
			for _, v := range intVals {
				if uniq[v] {
					unique = false
					break
				}
				uniq[v] = true
			}
			if unique {
				for j, idx := range idxs {
					nodes[idx].DisplayName = fmt.Sprintf("%s-%d", nodes[idx].DisplayName, intVals[j])
				}
				continue
			}
		}

		// ── Step B: single meaningful pod-name segment ────────────────────────
		allOne := true
		meaningfulSegs := make([]string, len(idxs))
		for j, idx := range idxs {
			segs := strings.Split(nodes[idx].PodName, "-")
			var meaningful []string
			for _, seg := range segs {
				lower := strings.ToLower(seg)
				if dedupVendorPrefixes[lower] {
					continue
				}
				if dedupNFKeywords[lower] {
					continue
				}
				if isHexHash(lower) {
					continue
				}
				if isK8sRandomSuffix(seg) {
					continue
				}
				if _, err := strconv.Atoi(seg); err == nil {
					continue
				}
				meaningful = append(meaningful, seg)
			}
			if len(meaningful) != 1 {
				allOne = false
				break
			}
			meaningfulSegs[j] = meaningful[0]
		}
		if allOne {
			uniq := make(map[string]bool, len(meaningfulSegs))
			unique := true
			for _, s := range meaningfulSegs {
				if uniq[s] {
					unique = false
					break
				}
				uniq[s] = true
			}
			if unique {
				for j, idx := range idxs {
					nodes[idx].DisplayName = fmt.Sprintf("%s-%s", nodes[idx].DisplayName, meaningfulSegs[j])
				}
				continue
			}
		}

		// ── Step C: creation-time rank ────────────────────────────────────────
		type podRank struct {
			idx int
			t   time.Time
		}
		ranks := make([]podRank, len(idxs))
		for j, idx := range idxs {
			ranks[j] = podRank{idx: idx, t: created[nodes[idx].PodName]}
		}
		sort.Slice(ranks, func(a, b int) bool {
			return ranks[a].t.Before(ranks[b].t)
		})
		for rank, pr := range ranks {
			nodes[pr.idx].DisplayName = fmt.Sprintf("%s-%d", nodes[pr.idx].DisplayName, rank+1)
		}
	}
}

// ─── UPF configmap / DNN detection ───────────────────────────────────────────
// ParseUPFConfig moved to package coreprofile (Free5GCProfile.ParseUPFConfig);
// buildDNNodes below stays here since it operates on already-classified
// nodes generically and isn't core-specific itself.

// buildDNNodes returns virtual DN nodes and two lookup maps:
//   - upfNodeDNNs: UPF node ID → []dnn (which DNNs each UPF serves)
//   - dnByDNN: dnn string → DN TopologyNode
func buildDNNodes(nodes []TopologyNode, entries []coreprofile.UPFDNNEntry) ([]TopologyNode, map[string][]string, map[string]TopologyNode) {
	upfNodeDNNs := make(map[string][]string)

	// Index UPF nodes by their nf label for matching
	upfByNFLabel := make(map[string][]string)
	var hasUPF bool
	for _, n := range nodes {
		if n.NFType == NFTypeUPF || n.NFType == NFTypeIUPF {
			if n.NFType == NFTypeUPF {
				hasUPF = true
			}
			if nfLabel, ok := n.Labels["nf"]; ok && nfLabel != "" {
				upfByNFLabel[nfLabel] = append(upfByNFLabel[nfLabel], n.ID)
			}
		}
	}

	for _, entry := range entries {
		if entry.NFLabel != "" {
			for _, nodeID := range upfByNFLabel[entry.NFLabel] {
				upfNodeDNNs[nodeID] = append(upfNodeDNNs[nodeID], entry.DNNs...)
			}
		} else {
			for _, n := range nodes {
				if n.NFType == NFTypeUPF {
					upfNodeDNNs[n.ID] = append(upfNodeDNNs[n.ID], entry.DNNs...)
				}
			}
		}
	}

	// Collect all unique DNNs across all UPFs
	allDNNs := make(map[string]struct{})
	for _, dnns := range upfNodeDNNs {
		for _, d := range dnns {
			allDNNs[d] = struct{}{}
		}
	}

	// Default if no configmaps found
	if len(allDNNs) == 0 && hasUPF {
		log.Warn().Msg("no DNN entries discovered or overridden for any UPF; every UPF's N6 edge will default to \"internet\" -- set targets[].dnnMap in values.yaml to override per UPF")
		allDNNs["internet"] = struct{}{}
	}

	// UPFs with no DNN mapping → connect to all DN nodes
	for _, n := range nodes {
		if n.NFType == NFTypeUPF && len(upfNodeDNNs[n.ID]) == 0 && len(allDNNs) > 0 {
			var all []string
			for dnn := range allDNNs {
				all = append(all, dnn)
			}
			sort.Strings(all)
			upfNodeDNNs[n.ID] = all
			log.Warn().
				Str("pod", n.PodName).
				Str("namespace", n.Namespace).
				Strs("defaultDNNs", all).
				Msg("UPF has no discovered or overridden DNN mapping; falling back to default -- set targets[].dnnMap in values.yaml to override this UPF's nf label")
		}
	}

	// Deduplicate per-UPF DNN lists
	for id, dnns := range upfNodeDNNs {
		seen := make(map[string]bool)
		var deduped []string
		for _, d := range dnns {
			if !seen[d] {
				seen[d] = true
				deduped = append(deduped, d)
			}
		}
		upfNodeDNNs[id] = deduped
	}

	// Build sorted list of DNNs for deterministic node ordering
	var sortedDNNs []string
	for dnn := range allDNNs {
		sortedDNNs = append(sortedDNNs, dnn)
	}
	sort.Strings(sortedDNNs)

	dnByDNN := make(map[string]TopologyNode)
	var dnNodes []TopologyNode
	for _, dnn := range sortedDNNs {
		id := "dn-" + strings.ToLower(strings.NewReplacer(" ", "-", "/", "-").Replace(dnn))
		dn := TopologyNode{
			ID:          id,
			PodName:     "dn-" + dnn,
			DisplayName: dnn,
			Namespace:   "virtual",
			NFType:      NFTypeDN,
			NodeName:    "",
			Status:      PodStatus{Phase: PodPhaseRunning, Ready: true, Condition: CondRunning},
			Interfaces:  []NetworkInterface{},
			Age:         "∞",
			Image:       "",
			Labels:      map[string]string{"dnn": dnn},
		}
		dnByDNN[dnn] = dn
		dnNodes = append(dnNodes, dn)
	}

	return dnNodes, upfNodeDNNs, dnByDNN
}

// ─── Primary CNI detection ────────────────────────────────────────────────────

var cniCache struct {
	mu        sync.Mutex
	value     string
	fetchedAt time.Time
}

const cniCacheTTL = 60 * time.Second

func DetectPrimaryCNI(ctx context.Context, cs *kubernetes.Clientset) string {
	cniCache.mu.Lock()
	if cniCache.value != "" && time.Since(cniCache.fetchedAt) < cniCacheTTL {
		v := cniCache.value
		cniCache.mu.Unlock()
		return v
	}
	cniCache.mu.Unlock()

	pods, err := cs.CoreV1().Pods("kube-system").List(ctx, metav1.ListOptions{})
	if err != nil {
		return "CNI"
	}

	result := "CNI"
	for _, pod := range pods.Items {
		labels := pod.Labels
		name := strings.ToLower(pod.Name)
		if labels["k8s-app"] == "cilium" || strings.Contains(name, "cilium") {
			result = "Cilium"
			break
		}
		if labels["app"] == "flannel" || strings.Contains(name, "flannel") {
			result = "Flannel"
			break
		}
		if labels["k8s-app"] == "calico" || labels["app"] == "calico" || strings.Contains(name, "calico") {
			result = "Calico"
			break
		}
		if labels["app"] == "weave" || strings.Contains(name, "weave") {
			result = "Weave"
			break
		}
		if strings.Contains(name, "canal") {
			result = "Canal"
			break
		}
	}

	cniCache.mu.Lock()
	cniCache.value = result
	cniCache.fetchedAt = time.Now()
	cniCache.mu.Unlock()

	return result
}

// ─── Secondary CNI detection ─────────────────────────────────────────────────

var secondaryCNICache struct {
	mu        sync.Mutex
	value     string
	fetchedAt time.Time
}

func detectSecondaryCNI(ctx context.Context, cs *kubernetes.Clientset) string {
	secondaryCNICache.mu.Lock()
	if secondaryCNICache.value != "" && time.Since(secondaryCNICache.fetchedAt) < cniCacheTTL {
		v := secondaryCNICache.value
		secondaryCNICache.mu.Unlock()
		return v
	}
	secondaryCNICache.mu.Unlock()

	pods, err := cs.CoreV1().Pods("kube-system").List(ctx, metav1.ListOptions{})
	if err != nil {
		return "Secondary CNI"
	}

	result := "Secondary CNI"
	for _, pod := range pods.Items {
		labels := pod.Labels
		name := strings.ToLower(pod.Name)
		if labels["app"] == "multus" || strings.Contains(name, "multus") {
			result = "Multus"
			break
		}
		if labels["app"] == "danm" || strings.Contains(name, "danm") {
			result = "DANM"
			break
		}
		if labels["app"] == "knitter" || strings.Contains(name, "knitter") {
			result = "Knitter"
			break
		}
		if labels["app"] == "cni-genie" || strings.Contains(name, "genie") {
			result = "CNI-Genie"
			break
		}
		if labels["app"] == "whereabouts" || strings.Contains(name, "whereabouts") {
			result = "Whereabouts"
			break
		}
	}

	secondaryCNICache.mu.Lock()
	secondaryCNICache.value = result
	secondaryCNICache.fetchedAt = time.Now()
	secondaryCNICache.mu.Unlock()

	return result
}

// ─── Topology discovery ───────────────────────────────────────────────────────

func BuildTopology(ctx context.Context, cs *kubernetes.Clientset, namespaces []string, profile coreprofile.CoreProfile) (*TopologyGraph, error) {
	var nodes []TopologyNode
	nsSet := make(map[string]bool)
	created := make(map[string]time.Time)

	for _, ns := range namespaces {
		pods, err := cs.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list pods in %s: %w", ns, err)
		}
		for _, pod := range pods.Items {
			node := podToNode(&pod, profile)
			if node != nil {
				nodes = append(nodes, *node)
				created[pod.Name] = pod.CreationTimestamp.Time
				nsSet[ns] = true
			}
		}
	}

	// Preserve input order; include only namespaces that had at least one NF pod.
	var foundNS []string
	for _, ns := range namespaces {
		if nsSet[ns] {
			foundNS = append(foundNS, ns)
		}
	}

	// Deduplicate display names before adding virtual nodes
	deduplicateDisplayNames(nodes, created)

	// Detect DNNs from UPF configmaps and build virtual DN nodes
	cmEntries := profile.ParseUPFConfig(ctx, cs, namespaces)
	dnNodes, upfNodeDNNs, dnByDNN := buildDNNodes(nodes, cmEntries)
	nodes = append(nodes, dnNodes...)

	edges := profile.BuildEdges(nodes, upfNodeDNNs, dnByDNN)
	primaryCNI := DetectPrimaryCNI(ctx, cs)
	secondaryCNI := detectSecondaryCNI(ctx, cs)

	return &TopologyGraph{
		Nodes:        nodes,
		Edges:        edges,
		UpdatedAt:    time.Now(),
		Namespaces:   foundNS,
		PrimaryCNI:   primaryCNI,
		SecondaryCNI: secondaryCNI,
	}, nil
}

// ─── Pod → TopologyNode ───────────────────────────────────────────────────────

func podToNode(pod *corev1.Pod, profile coreprofile.CoreProfile) *TopologyNode {
	if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
		return nil
	}

	// Skip management-only pods (webui, etc.)
	if nfVal, ok := pod.Labels["nf"]; ok && strings.ToLower(nfVal) == "webui" {
		return nil
	}

	ifaces := parseNetworkStatus(pod.Annotations)
	nfType, displayName := coreprofile.ClassifyNF(profile, pod, ifaces)

	if nfType == NFTypeUnknown {
		return nil
	}

	status := podStatus(pod)
	d    := time.Since(pod.CreationTimestamp.Time)
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	mins := int(d.Minutes()) % 60
	secs := int(d.Seconds()) % 60
	var age string
	switch {
	case days >= 30:
		age = fmt.Sprintf("%dd", days)
	case days >= 1:
		age = fmt.Sprintf("%dd %dh", days, hours)
	case int(d.Hours()) >= 1:
		age = fmt.Sprintf("%dh %dm", int(d.Hours()), mins)
	default:
		age = fmt.Sprintf("%dm %ds", mins, secs)
	}

	img := ""
	if len(pod.Spec.Containers) > 0 {
		img = pod.Spec.Containers[0].Image
	}

	containers := make([]string, 0, len(pod.Spec.Containers))
	for _, c := range pod.Spec.Containers {
		containers = append(containers, c.Name)
	}

	return &TopologyNode{
		ID:          string(pod.UID),
		PodName:     pod.Name,
		Namespace:   pod.Namespace,
		NFType:      nfType,
		DisplayName: displayName,
		NodeName:    pod.Spec.NodeName,
		NodeIP:      pod.Status.HostIP,   // node's InternalIP for Prometheus queries
		Status:      status,
		Interfaces:  ifaces,
		Age:         age,
		Image:       img,
		Labels:      pod.Labels,
		Containers:  containers,
	}
}

func parseNetworkStatus(annotations map[string]string) []NetworkInterface {
	raw, ok := annotations["k8s.v1.cni.cncf.io/network-status"]
	if !ok {
		return nil
	}
	var statuses []netStatus
	if err := json.Unmarshal([]byte(raw), &statuses); err != nil {
		return nil
	}
	ifaces := make([]NetworkInterface, 0, len(statuses))
	for _, s := range statuses {
		ifaces = append(ifaces, NetworkInterface{
			Name:      s.Name,
			Interface: s.Interface,
			IPs:       s.IPs,
			MAC:       s.MAC,
			IsDefault: s.Default,
		})
	}
	return ifaces
}

func podStatus(pod *corev1.Pod) PodStatus {
	var restarts int32
	var ready bool

	for _, cs := range pod.Status.ContainerStatuses {
		restarts += cs.RestartCount
		if cs.Ready {
			ready = true
		}
	}

	condition := CondUnknown
	switch pod.Status.Phase {
	case corev1.PodRunning:
		condition = CondRunning
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.State.Waiting != nil {
				switch cs.State.Waiting.Reason {
				case "CrashLoopBackOff":
					condition = CondCrashLoopBackOff
				case "OOMKilled":
					condition = CondOOMKilled
				case "Error":
					condition = CondError
				}
			}
			if cs.LastTerminationState.Terminated != nil &&
				cs.LastTerminationState.Terminated.Reason == "OOMKilled" {
				condition = CondOOMKilled
			}
		}
	case corev1.PodPending:
		condition = CondPending
	case corev1.PodFailed:
		condition = CondError
	}

	phase := PodPhase(pod.Status.Phase)
	if phase == "" {
		phase = PodPhaseUnknown
	}

	return PodStatus{
		Phase:     phase,
		Ready:     ready,
		Condition: condition,
		Restarts:  restarts,
	}
}

// ─── Edge building ────────────────────────────────────────────────────────────

// buildEdges moved to package coreprofile (Free5GCProfile.BuildEdges); see
// docs/NF_CLASSIFICATION_REFACTOR_ASSESSMENT.md.
