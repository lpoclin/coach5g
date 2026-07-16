package coreprofile

import (
	"context"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
)

// CoreProfile classifies pods and synthesizes topology edges/UPF config for
// one specific 5G core (e.g. free5GC). Free5GCProfile is the only
// implementation today; see docs/RISK_ASSESSMENT_ADDITIONS.md, Addition 3,
// and docs/NF_CLASSIFICATION_REFACTOR_ASSESSMENT.md for why this exists and
// how a future second profile (e.g. Open5GS) would plug in.
type CoreProfile interface {
	// ClassifyNF attempts to classify pod using this profile's own
	// core-specific conventions only. matched=false tells the dispatcher
	// (ClassifyNF below) that this profile has no opinion and the shared
	// generic fallback should be tried next. matched=true means nfType is
	// final -- including when nfType is NFTypeUnknown, which some profiles
	// use to explicitly exclude a pod (e.g. free5GC's webui) rather than
	// leaving it to the generic fallback.
	ClassifyNF(pod *corev1.Pod, ifaces []NetworkInterface) (nfType NFType, displayName string, matched bool)

	// BuildEdges synthesizes topology edges for this core's reference-point
	// wiring, given the already-classified nodes and UPF-to-DNN map.
	BuildEdges(nodes []TopologyNode, upfNodeDNNs map[string][]string, dnByDNN map[string]TopologyNode) []TopologyEdge

	// ParseUPFConfig discovers per-UPF DNN lists from this core's own
	// ConfigMap format.
	ParseUPFConfig(ctx context.Context, cs *kubernetes.Clientset, namespaces []string) []UPFDNNEntry
}

// ClassifyNF tries profile's own classification first, falling back to the
// shared generic checks (a RAN-simulator label convention and standard 3GPP
// NF names, needed by any profile) only when the profile has no opinion.
//
// This reproduces today's exact five-step precedence: profile-specific logic
// runs to completion first (steps equivalent to today's steps 0-1, including
// the short-circuit-on-skip behavior for an explicitly-excluded pod), and
// only if that produces no definitive answer does the generic fallback run
// (steps 2-4, kept as one unsplit unit deliberately -- see
// docs/NF_CLASSIFICATION_REFACTOR_ASSESSMENT.md for why splitting the
// generic fallback further would risk changing which label wins when a pod
// happens to match more than one convention).
func ClassifyNF(profile CoreProfile, pod *corev1.Pod, ifaces []NetworkInterface) (NFType, string) {
	if nfType, display, matched := profile.ClassifyNF(pod, ifaces); matched {
		return nfType, display
	}
	return classifyGeneric(pod, ifaces)
}

// formatComponentLabel converts the `component` pod label (UERANSIM) to
// (NFType, displayName, skip). UERANSIM is a RAN simulator paired with
// free5GC, Open5GS, or OAI equally -- this is not owned by any one core.
func formatComponentLabel(comp string) (NFType, string, bool) {
	switch strings.ToLower(comp) {
	case "gnb", "gnodeb":
		return NFTypeGNB, "gNB", false
	// "ue": the original, still-current convention for free5GC's paired
	// UERANSIM deployments. "ues" (plural): confirmed live on a Gradiant
	// Open5GS deployment's UERANSIM chart (app.kubernetes.io/component=ues,
	// app.kubernetes.io/name=ueransim-gnb -- the same `name` value the real
	// gNB pod also carries, which is why an unmatched UE pod previously fell
	// through to the generic app.kubernetes.io/name substring scan in
	// classifyGeneric and got misclassified as a second gNB via the "gnb"
	// substring in "ueransim-gnb"). Both are exact-matched, not prefix- or
	// substring-matched, to avoid accidentally catching an unrelated future
	// component value that merely starts with or contains "ue".
	case "ue", "ues":
		return NFTypeUE, "UE", false
	default:
		return NFTypeUnknown, "", true
	}
}

// fallbackNFMap is used when neither a profile-specific match nor the
// component label matched. It intentionally mixes a few free5GC-specific
// keywords (iupf/i-upf, psaupf/psa-upf) alongside standard 3GPP NF names and
// generic RAN terms, in this exact declared order -- see
// docs/NF_CLASSIFICATION_REFACTOR_ASSESSMENT.md for why this list is kept
// together, unsplit, rather than separated by specificity: splitting it
// would risk changing which entry wins for a pod whose name or label
// happens to substring-match more than one keyword.
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

// classifyGeneric implements today's detectNFType steps 2-4 verbatim,
// unsplit: the UERANSIM component label, then an app.kubernetes.io/name
// substring scan, then a pod-name substring scan (including the free5GC
// iUPF interface heuristic, kept here rather than in Free5GCProfile for the
// same reason fallbackNFMap is kept together -- see the comment there).
func classifyGeneric(pod *corev1.Pod, ifaces []NetworkInterface) (NFType, string) {
	// 2. component label — UERANSIM. Two different key conventions exist for
	// the same semantic value: the bare `component` key (the original
	// free5GC-paired UERANSIM chart this project was first validated
	// against, component=gnb / component=ue) and the standard-prefixed
	// `app.kubernetes.io/component` key (confirmed live on a Gradiant
	// Open5GS deployment's UERANSIM chart, component=gnb / component=ues).
	// Both route through the same formatComponentLabel conversion -- only
	// the label KEY differs between charts, not the value vocabulary. Bare
	// key checked first, purely to preserve free5GC's exact existing
	// precedence unchanged: no pod has ever been confirmed to carry both
	// keys at once, so this ordering doesn't currently affect any real
	// deployment either way.
	compVal, ok := pod.Labels["component"]
	if !ok {
		compVal, ok = pod.Labels["app.kubernetes.io/component"]
	}
	if ok {
		nfType, display, skip := formatComponentLabel(compVal)
		if !skip && nfType != NFTypeUnknown {
			return nfType, display
		}
	}

	// 3. app.kubernetes.io/name — compound names ("oai-amf", "open5gs-smf", "free5gc-upf").
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
