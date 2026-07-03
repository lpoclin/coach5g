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

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	sigsyaml "sigs.k8s.io/yaml"
)

// ─── Model types ──────────────────────────────────────────────────────────────

type NFType string

const (
	NFTypeNRF     NFType = "NRF"
	NFTypeAMF     NFType = "AMF"
	NFTypeSMF     NFType = "SMF"
	NFTypeAUSF    NFType = "AUSF"
	NFTypeUDM     NFType = "UDM"
	NFTypeUDR     NFType = "UDR"
	NFTypePCF     NFType = "PCF"
	NFTypeNSSF    NFType = "NSSF"
	NFTypeCHF     NFType = "CHF"
	NFTypeNEF     NFType = "NEF"
	NFTypeUPF     NFType = "UPF"
	NFTypeIUPF    NFType = "iUPF"
	NFTypeGNB     NFType = "gNB"
	NFTypeUE      NFType = "UE"
	NFTypeDN      NFType = "DN"
	NFTypeUnknown NFType = "UNKNOWN"
)

type Plane string

const (
	PlaneSBI        Plane = "sbi"
	PlaneUserPlane  Plane = "userplane"
	PlaneRAN        Plane = "ran"
	PlanePFCP       Plane = "pfcp"
	PlaneManagement Plane = "management"
)

type PodPhase string
type PodCondition string

const (
	PodPhaseRunning PodPhase = "Running"
	PodPhasePending PodPhase = "Pending"
	PodPhaseFailed  PodPhase = "Failed"
	PodPhaseUnknown PodPhase = "Unknown"
)

const (
	CondRunning          PodCondition = "Running"
	CondCrashLoopBackOff PodCondition = "CrashLoopBackOff"
	CondOOMKilled        PodCondition = "OOMKilled"
	CondError            PodCondition = "Error"
	CondPending          PodCondition = "Pending"
	CondUnknown          PodCondition = "Unknown"
)

type PodStatus struct {
	Phase     PodPhase     `json:"phase"`
	Ready     bool         `json:"ready"`
	Condition PodCondition `json:"condition"`
	Restarts  int32        `json:"restarts"`
}

type NetworkInterface struct {
	Name      string   `json:"name"`
	Interface string   `json:"interface"`
	IPs       []string `json:"ips"`
	MAC       string   `json:"mac,omitempty"`
	IsDefault bool     `json:"isDefault"`
}

type TopologyNode struct {
	ID          string             `json:"id"`
	PodName     string             `json:"podName"`
	Namespace   string             `json:"namespace"`
	NFType      NFType             `json:"nfType"`
	DisplayName string             `json:"displayName"`
	NodeName    string             `json:"nodeName"`
	NodeIP      string             `json:"nodeIP"`   // k8s node InternalIP — matches Prometheus instance label
	Status      PodStatus          `json:"status"`
	Interfaces  []NetworkInterface `json:"interfaces"`
	Age         string             `json:"age"`
	Image       string             `json:"image"`
	Labels      map[string]string  `json:"labels"`
}

type TopologyEdge struct {
	ID        string `json:"id"`
	Source    string `json:"source"`
	Target    string `json:"target"`
	Interface string `json:"interface"`
	Label     string `json:"label"`
	Plane     Plane  `json:"plane"`
	SrcIP     string `json:"srcIP,omitempty"`
	DstIP     string `json:"dstIP,omitempty"`
	BusEdge   bool   `json:"busEdge,omitempty"` // SBI bus edge — rendered on canvas overlay
}

type TopologyGraph struct {
	Nodes        []TopologyNode `json:"nodes"`
	Edges        []TopologyEdge `json:"edges"`
	UpdatedAt    time.Time      `json:"updatedAt"`
	Namespaces   []string       `json:"namespaces"`
	PrimaryCNI   string         `json:"primaryCNI"`
	SecondaryCNI string         `json:"secondaryCNI"`
}

// ─── Network-status annotation types ─────────────────────────────────────────

type netStatus struct {
	Name      string   `json:"name"`
	Interface string   `json:"interface"`
	IPs       []string `json:"ips"`
	MAC       string   `json:"mac"`
	Default   bool     `json:"default"`
}

// ─── NF label detection ───────────────────────────────────────────────────────

// formatNFLabel converts the value of the `nf` pod label to (NFType, displayName, skip).
// Returns skip=true for pods that should be excluded from the topology (e.g., webui).
func formatNFLabel(nfVal string) (NFType, string, bool) {
	lower := strings.ToLower(nfVal)

	if lower == "webui" {
		return NFTypeUnknown, "", true
	}

	// iUPF variants: iupf, iupf1, iupf2, i-upf, i-upf1
	if strings.HasPrefix(lower, "iupf") || strings.HasPrefix(lower, "i-upf") {
		suffix := strings.TrimPrefix(strings.TrimPrefix(lower, "i-upf"), "iupf")
		num := strings.ToUpper(suffix)
		if num == "" {
			num = "1"
		}
		return NFTypeIUPF, "iUPF" + num, false
	}

	// PSA-UPF variants: psaupf1, psaupf2, psa-upf1, psa-upf2
	if strings.HasPrefix(lower, "psaupf") || strings.HasPrefix(lower, "psa-upf") {
		suffix := strings.TrimPrefix(strings.TrimPrefix(lower, "psa-upf"), "psaupf")
		num := strings.ToUpper(suffix)
		return NFTypeUPF, "PSA-UPF" + num, false
	}

	exact := map[string]struct {
		nfType  NFType
		display string
	}{
		"nrf":  {NFTypeNRF, "NRF"},
		"amf":  {NFTypeAMF, "AMF"},
		"smf":  {NFTypeSMF, "SMF"},
		"ausf": {NFTypeAUSF, "AUSF"},
		"udm":  {NFTypeUDM, "UDM"},
		"udr":  {NFTypeUDR, "UDR"},
		"pcf":  {NFTypePCF, "PCF"},
		"nssf": {NFTypeNSSF, "NSSF"},
		"chf":  {NFTypeCHF, "CHF"},
		"nef":  {NFTypeNEF, "NEF"},
		"upf":  {NFTypeUPF, "UPF"},
	}
	if m, ok := exact[lower]; ok {
		return m.nfType, m.display, false
	}

	return NFTypeUnknown, strings.ToUpper(nfVal), false
}

// formatComponentLabel converts the `component` pod label (UERANSIM) to (NFType, displayName, skip).
func formatComponentLabel(comp string) (NFType, string, bool) {
	switch strings.ToLower(comp) {
	case "gnb", "gnodeb":
		return NFTypeGNB, "gNB", false
	case "ue":
		return NFTypeUE, "UE", false
	default:
		return NFTypeUnknown, "", true
	}
}

// fallbackNFMap is used when both nf and component labels are absent.
var fallbackNFMap = []struct {
	keywords []string
	nfType   NFType
	display  string
}{
	{[]string{"nrf"}, NFTypeNRF, "NRF"},
	{[]string{"ausf"}, NFTypeAUSF, "AUSF"},
	{[]string{"udm"}, NFTypeUDM, "UDM"},
	{[]string{"udr"}, NFTypeUDR, "UDR"},
	{[]string{"nssf"}, NFTypeNSSF, "NSSF"},
	{[]string{"chf"}, NFTypeCHF, "CHF"},
	{[]string{"nef"}, NFTypeNEF, "NEF"},
	{[]string{"pcf"}, NFTypePCF, "PCF"},
	{[]string{"amf"}, NFTypeAMF, "AMF"},
	{[]string{"smf"}, NFTypeSMF, "SMF"},
	// iUPF before UPF
	{[]string{"iupf", "i-upf"}, NFTypeIUPF, "iUPF"},
	{[]string{"psaupf", "psa-upf"}, NFTypeUPF, "PSA-UPF"},
	{[]string{"upf"}, NFTypeUPF, "UPF"},
	{[]string{"gnb", "gnode", "gnodeb"}, NFTypeGNB, "gNB"},
	{[]string{"ue", "uesim"}, NFTypeUE, "UE"},
}

func detectNFType(pod *corev1.Pod, ifaces []NetworkInterface) (NFType, string) {
	// 0. app.kubernetes.io/component — bare values only; formatNFLabel handles "amf", "smf", etc.
	if compVal, ok := pod.Labels["app.kubernetes.io/component"]; ok {
		nfType, display, skip := formatNFLabel(compVal)
		if !skip && nfType != NFTypeUnknown {
			return nfType, display
		}
	}

	// 1. nf label — free5GC (nf=amf, nf=psaupf1, nf=iupf1, etc.); handles PSA/iUPF variants
	if nfVal, ok := pod.Labels["nf"]; ok {
		nfType, display, skip := formatNFLabel(nfVal)
		if skip {
			return NFTypeUnknown, ""
		}
		if nfType != NFTypeUnknown {
			return nfType, display
		}
	}

	// 2. component label — UERANSIM (component=gnb, component=ue)
	if comp, ok := pod.Labels["component"]; ok {
		nfType, display, skip := formatComponentLabel(comp)
		if !skip && nfType != NFTypeUnknown {
			return nfType, display
		}
	}

	// 3. app.kubernetes.io/name — compound names ("oai-amf", "open5gs-smf", "free5gc-upf").
	// Substring scan only — no formatNFLabel — so PSA-UPF/iUPF distinction is not attempted here.
	// Only reached when priorities 1 and 2 both failed, preserving free5GC/UERANSIM accuracy.
	if nameVal, ok := pod.Labels["app.kubernetes.io/name"]; ok {
		lower := strings.ToLower(nameVal)
		for _, entry := range fallbackNFMap {
			for _, kw := range entry.keywords {
				if strings.Contains(lower, kw) {
					return entry.nfType, entry.display
				}
			}
		}
	}

	// 4. Pod name fallback — same keyword list; iUPF interface heuristic applied for UPF pods
	name := strings.ToLower(pod.Name)

	ifaceNames := make(map[string]bool)
	for _, iface := range ifaces {
		ifaceNames[iface.Interface] = true
	}
	if strings.Contains(name, "upf") {
		if ifaceNames["n9"] && ifaceNames["n3"] && !ifaceNames["n6"] {
			return NFTypeIUPF, "iUPF"
		}
		if strings.Contains(name, "psa") {
			return NFTypeUPF, "PSA-UPF"
		}
		return NFTypeUPF, "UPF"
	}

	for _, entry := range fallbackNFMap {
		for _, kw := range entry.keywords {
			if strings.Contains(name, kw) {
				return entry.nfType, entry.display
			}
		}
	}

	return NFTypeUnknown, "UNKNOWN"
}

// dedupVendorPrefixes are pod-name segments that carry no distinguishing information.
var dedupVendorPrefixes = map[string]bool{
	"free5gc": true, "open5gs": true, "oai": true, "towards5gs": true,
}

// dedupNFKeywords are NF-type segments that are already encoded in DisplayName.
var dedupNFKeywords = map[string]bool{
	"amf": true, "smf": true, "upf": true, "nrf": true, "ausf": true,
	"udm": true, "udr": true, "nssf": true, "pcf": true, "chf": true,
	"nef": true, "gnb": true, "ue": true, "webui": true, "iupf": true, "psaupf": true,
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

type upfDNNItem struct {
	DNN string `json:"dnn"`
}

type upfConfigSection struct {
	DNNList []upfDNNItem `json:"dnnList"`
}

type upfYAMLDoc struct {
	Configuration upfConfigSection `json:"configuration"`
}

type upfDNNEntry struct {
	nfLabel string // value of the `nf` label on the configmap; "" = applies to all UPFs
	dnns    []string
}

func getUPFDNNEntries(ctx context.Context, cs *kubernetes.Clientset, namespaces []string) []upfDNNEntry {
	var entries []upfDNNEntry

	for _, ns := range namespaces {
		cms, err := cs.CoreV1().ConfigMaps(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			continue
		}
		for _, cm := range cms.Items {
			raw, ok := cm.Data["upfcfg.yaml"]
			if !ok {
				continue
			}
			var doc upfYAMLDoc
			if err := sigsyaml.Unmarshal([]byte(raw), &doc); err != nil {
				continue
			}
			var dnns []string
			for _, d := range doc.Configuration.DNNList {
				if d.DNN != "" {
					dnns = append(dnns, d.DNN)
				}
			}
			if len(dnns) == 0 {
				continue
			}
			nfLabel := cm.Labels["nf"]
			entries = append(entries, upfDNNEntry{nfLabel: nfLabel, dnns: dnns})
		}
	}
	return entries
}

// buildDNNodes returns virtual DN nodes and two lookup maps:
//   - upfNodeDNNs: UPF node ID → []dnn (which DNNs each UPF serves)
//   - dnByDNN: dnn string → DN TopologyNode
func buildDNNodes(nodes []TopologyNode, entries []upfDNNEntry) ([]TopologyNode, map[string][]string, map[string]TopologyNode) {
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
		if entry.nfLabel != "" {
			for _, nodeID := range upfByNFLabel[entry.nfLabel] {
				upfNodeDNNs[nodeID] = append(upfNodeDNNs[nodeID], entry.dnns...)
			}
		} else {
			for _, n := range nodes {
				if n.NFType == NFTypeUPF {
					upfNodeDNNs[n.ID] = append(upfNodeDNNs[n.ID], entry.dnns...)
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

func BuildTopology(ctx context.Context, cs *kubernetes.Clientset, namespaces []string) (*TopologyGraph, error) {
	var nodes []TopologyNode
	nsSet := make(map[string]bool)
	created := make(map[string]time.Time)

	for _, ns := range namespaces {
		pods, err := cs.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list pods in %s: %w", ns, err)
		}
		for _, pod := range pods.Items {
			node := podToNode(&pod)
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
	cmEntries := getUPFDNNEntries(ctx, cs, namespaces)
	dnNodes, upfNodeDNNs, dnByDNN := buildDNNodes(nodes, cmEntries)
	nodes = append(nodes, dnNodes...)

	edges := buildEdges(nodes, upfNodeDNNs, dnByDNN)
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

func podToNode(pod *corev1.Pod) *TopologyNode {
	if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
		return nil
	}

	// Skip management-only pods (webui, etc.)
	if nfVal, ok := pod.Labels["nf"]; ok && strings.ToLower(nfVal) == "webui" {
		return nil
	}

	ifaces := parseNetworkStatus(pod.Annotations)
	nfType, displayName := detectNFType(pod, ifaces)

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

func buildEdges(nodes []TopologyNode, upfNodeDNNs map[string][]string, dnByDNN map[string]TopologyNode) []TopologyEdge {
	byType := make(map[NFType][]TopologyNode)
	for _, n := range nodes {
		if n.NFType != NFTypeDN {
			byType[n.NFType] = append(byType[n.NFType], n)
		}
	}

	var edges []TopologyEdge

	// Safe 8-char prefix for edge IDs (avoids panic on short UUIDs or short virtual IDs)
	idShort := func(id string) string {
		if len(id) > 8 {
			return id[:8]
		}
		return id
	}
	addEdge := func(src, dst TopologyNode, iface, label string, plane Plane) {
		edges = append(edges, TopologyEdge{
			ID:        fmt.Sprintf("e-%s-%s-%s", idShort(src.ID), idShort(dst.ID), iface),
			Source:    src.ID,
			Target:    dst.ID,
			Interface: iface,
			Label:     label,
			Plane:     plane,
		})
	}

	iupfs := byType[NFTypeIUPF]
	upfs := byType[NFTypeUPF]

	// N1: UE ↔ gNB (NAS-over-RAN)
	for _, ue := range byType[NFTypeUE] {
		for _, gnb := range byType[NFTypeGNB] {
			addEdge(ue, gnb, "n1", "N1", PlaneRAN)
		}
	}

	// N2: gNB ↔ AMF (NGAP)
	for _, gnb := range byType[NFTypeGNB] {
		for _, amf := range byType[NFTypeAMF] {
			addEdge(gnb, amf, "n2", "N2", PlaneRAN)
		}
	}

	// N3: gNB → iUPF (ULCL) or gNB → UPF (single)
	for _, gnb := range byType[NFTypeGNB] {
		if len(iupfs) > 0 {
			for _, iupf := range iupfs {
				addEdge(gnb, iupf, "n3", "N3", PlaneUserPlane)
			}
		} else {
			for _, upf := range upfs {
				addEdge(gnb, upf, "n3", "N3", PlaneUserPlane)
			}
		}
	}

	// N4: SMF ↔ all UPFs (PFCP)
	for _, smf := range byType[NFTypeSMF] {
		for _, iupf := range iupfs {
			addEdge(smf, iupf, "n4", "N4", PlanePFCP)
		}
		for _, upf := range upfs {
			addEdge(smf, upf, "n4", "N4", PlanePFCP)
		}
	}

	// N9: iUPF → PSA-UPFs (GTP-U tunnel between UPFs)
	for _, iupf := range iupfs {
		for _, upf := range upfs {
			addEdge(iupf, upf, "n9", "N9", PlaneUserPlane)
		}
	}

	// N6: PSA-UPF (or single UPF) → DN, one edge per DNN served
	for _, upf := range upfs {
		dnns := upfNodeDNNs[upf.ID]
		for _, dnn := range dnns {
			if dn, ok := dnByDNN[dnn]; ok {
				addEdge(upf, dn, "n6", "N6", PlaneUserPlane)
			}
		}
		// Fallback: no DNN mapped → connect to every DN node
		if len(dnns) == 0 {
			for _, dn := range dnByDNN {
				addEdge(upf, dn, "n6", "N6", PlaneUserPlane)
			}
		}
	}

	// SBI: NRF ↔ each CP NF, labelled with the NF's service name.
	// BusEdge=true: these are rendered on the canvas SBI bus overlay, not as Cytoscape edges.
	sbiLabel := map[NFType]string{
		NFTypeAMF:  "Namf",
		NFTypeSMF:  "Nsmf",
		NFTypeAUSF: "Nausf",
		NFTypeUDM:  "Nudm",
		NFTypeUDR:  "Nudr",
		NFTypePCF:  "Npcf",
		NFTypeNSSF: "Nnssf",
		NFTypeCHF:  "Nchf",
		NFTypeNEF:  "Nnef",
	}
	for _, nrf := range byType[NFTypeNRF] {
		for nfType, lbl := range sbiLabel {
			for _, nf := range byType[nfType] {
				edges = append(edges, TopologyEdge{
					ID:        fmt.Sprintf("e-sbi-%s-%s", idShort(nrf.ID), idShort(nf.ID)),
					Source:    nrf.ID,
					Target:    nf.ID,
					Interface: "sbi",
					Label:     lbl,
					Plane:     PlaneSBI,
					BusEdge:   true,
				})
			}
		}
	}

	return edges
}
