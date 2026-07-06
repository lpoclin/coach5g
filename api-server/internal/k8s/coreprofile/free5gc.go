package coreprofile

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	sigsyaml "sigs.k8s.io/yaml"
)

// Free5GCProfile implements CoreProfile for free5GC + UERANSIM, the only
// core validated by this project (per docs/deployment-guide/01-requirements.md).
// Its ClassifyNF/BuildEdges/ParseUPFConfig bodies are a mechanical extraction
// of the pre-refactor detectNFType/buildEdges/getUPFDNNEntries -- not a
// rewrite -- per the classification in
// docs/NF_CLASSIFICATION_REFACTOR_ASSESSMENT.md.
type Free5GCProfile struct {
	// dnnMapOverride: namespace -> UPF `nf` label -> DNN name. Optional
	// operator-set override (helm values.yaml targets[].dnnMap), consulted
	// by ParseUPFConfig. nil/empty is the zero-configuration default: no UPF
	// is affected, and behavior is identical to before this field existed.
	dnnMapOverride map[string]map[string]string
}

// NewFree5GCProfile constructs the free5GC core profile. dnnMapOverride may
// be nil, which is equivalent to an empty map.
func NewFree5GCProfile(dnnMapOverride map[string]map[string]string) *Free5GCProfile {
	return &Free5GCProfile{dnnMapOverride: dnnMapOverride}
}

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

// ClassifyNF implements free5GC's own label conventions only (today's
// detectNFType steps 0-1). Returns matched=false to let the dispatcher try
// the shared generic fallback (UERANSIM component label, standard 3GPP
// names) next.
func (*Free5GCProfile) ClassifyNF(pod *corev1.Pod, ifaces []NetworkInterface) (NFType, string, bool) {
	// 0. app.kubernetes.io/component — bare values only; formatNFLabel handles "amf", "smf", etc.
	if compVal, ok := pod.Labels["app.kubernetes.io/component"]; ok {
		nfType, display, skip := formatNFLabel(compVal)
		if !skip && nfType != NFTypeUnknown {
			return nfType, display, true
		}
	}

	// 1. nf label — free5GC (nf=amf, nf=psaupf1, nf=iupf1, etc.); handles PSA/iUPF variants
	if nfVal, ok := pod.Labels["nf"]; ok {
		nfType, display, skip := formatNFLabel(nfVal)
		if skip {
			// Definitive exclusion (e.g. webui) -- do not fall through to
			// the generic fallback, exactly as today's short-circuit does.
			return NFTypeUnknown, "", true
		}
		if nfType != NFTypeUnknown {
			return nfType, display, true
		}
	}

	// No definitive free5GC-specific match; let the dispatcher try the
	// shared generic fallback (today's steps 2-4).
	return NFTypeUnknown, "", false
}

// BuildEdges synthesizes free5GC's 3GPP TS 23.501-style edges, including its
// ULCL-specific iUPF/PSA-UPF wiring (N3-to-iUPF, N4-to-iUPF, N9). The
// standard, non-ULCL reference points this function also draws (N1, N2, the
// N3/N4 single-UPF branches, N6, the SBI bus) already degrade correctly to a
// plain single-UPF topology when no iUPF nodes exist, unchanged from before
// this extraction.
func (*Free5GCProfile) BuildEdges(nodes []TopologyNode, upfNodeDNNs map[string][]string, dnByDNN map[string]TopologyNode) []TopologyEdge {
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

type upfDNNItem struct {
	DNN string `json:"dnn"`
}

type upfConfigSection struct {
	DNNList []upfDNNItem `json:"dnnList"`
}

type upfYAMLDoc struct {
	Configuration upfConfigSection `json:"configuration"`
}

// ParseUPFConfig reads free5GC's own upfcfg.yaml ConfigMap key to discover
// which DNNs each UPF serves, then applies dnnMapOverride (if any) on top:
// for any `nf` label listed in the override for this namespace, the override
// wins over whatever (if anything) was auto-discovered for that label. `nf`
// labels not present in the override are entirely unaffected by this step.
func (p *Free5GCProfile) ParseUPFConfig(ctx context.Context, cs *kubernetes.Clientset, namespaces []string) []UPFDNNEntry {
	var entries []UPFDNNEntry

	for _, ns := range namespaces {
		byNFLabel := make(map[string]int) // nf label -> index into entries, for the override step below

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
			byNFLabel[nfLabel] = len(entries)
			entries = append(entries, UPFDNNEntry{NFLabel: nfLabel, DNNs: dnns})
		}

		// Optional operator override (helm values.yaml targets[].dnnMap).
		// Replaces an auto-discovered entry's DNNs if one exists for that nf
		// label, or adds a new entry if auto-discovery found nothing for it
		// (e.g. a ConfigMap<->Pod nf-label mismatch silently dropped it --
		// see buildDNNodes' own fallback warning for that failure mode).
		for nfLabel, dnn := range p.dnnMapOverride[ns] {
			if idx, ok := byNFLabel[nfLabel]; ok {
				entries[idx].DNNs = []string{dnn}
			} else {
				entries = append(entries, UPFDNNEntry{NFLabel: nfLabel, DNNs: []string{dnn}})
			}
		}
	}
	return entries
}
