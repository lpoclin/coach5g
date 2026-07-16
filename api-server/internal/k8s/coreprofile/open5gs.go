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

// Open5GSProfile implements CoreProfile for the Gradiant Open5GS Helm chart
// (chart v2.3.4, app v2.7.5), confirmed against a live deployment's pod
// labels: every NF pod carries a single `app.kubernetes.io/name=<type>`
// label with the values amf, ausf, bsf, mongodb, nrf, nssf, pcf, populate,
// scp, smf, udm, udr, upf, webui. Unlike Free5GCProfile, classification here
// is a direct, exact-match lookup on that one label -- no precedence chain,
// no numbered-variant parsing -- because the source labels are already
// clean and unambiguous. This deployment is single-UPF (no ULCL split), so
// BuildEdges never needs an iUPF/PSA-UPF distinction or an N9 edge.
type Open5GSProfile struct{}

// NewOpen5GSProfile constructs the Open5GS core profile.
func NewOpen5GSProfile() *Open5GSProfile {
	return &Open5GSProfile{}
}

// open5gsNFLabel maps the exact value of app.kubernetes.io/name to
// (NFType, displayName) for every 5G network function in a Gradiant Open5GS
// deployment.
var open5gsNFLabel = map[string]struct {
	nfType  NFType
	display string
}{
	"amf":  {NFTypeAMF, "AMF"},
	"ausf": {NFTypeAUSF, "AUSF"},
	"bsf":  {NFTypeBSF, "BSF"},
	"nrf":  {NFTypeNRF, "NRF"},
	"nssf": {NFTypeNSSF, "NSSF"},
	"pcf":  {NFTypePCF, "PCF"},
	"scp":  {NFTypeSCP, "SCP"},
	"smf":  {NFTypeSMF, "SMF"},
	"udm":  {NFTypeUDM, "UDM"},
	"udr":  {NFTypeUDR, "UDR"},
	"upf":  {NFTypeUPF, "UPF"},
}

// open5gsExcluded lists app.kubernetes.io/name values that are real pods in
// a Gradiant Open5GS deployment but are not 5G network functions and must
// not appear in the topology -- mirrors how Free5GCProfile's formatNFLabel
// explicitly excludes free5GC's own webui (free5gc.go) rather than leaving
// the exclusion to chance.
var open5gsExcluded = map[string]bool{
	"mongodb":  true,
	"populate": true,
	"webui":    true,
}

// ClassifyNF implements Open5GS's own label convention only
// (app.kubernetes.io/name). Returns matched=false whenever that label is
// absent or holds a value this profile doesn't recognize, letting the
// dispatcher try the shared generic fallback next -- in particular the
// UERANSIM `component=gnb`/`component=ue` convention, for any RAN simulator
// paired with this core the same way one is with free5GC.
func (*Open5GSProfile) ClassifyNF(pod *corev1.Pod, ifaces []NetworkInterface) (NFType, string, bool) {
	nameVal, ok := pod.Labels["app.kubernetes.io/name"]
	if !ok {
		return NFTypeUnknown, "", false
	}
	lower := strings.ToLower(nameVal)

	if open5gsExcluded[lower] {
		// Definitive exclusion -- do not fall through to the generic
		// fallback, exactly as Free5GCProfile's webui short-circuit does.
		return NFTypeUnknown, "", true
	}
	if m, ok := open5gsNFLabel[lower]; ok {
		return m.nfType, m.display, true
	}

	return NFTypeUnknown, "", false
}

// BuildEdges synthesizes Open5GS's 3GPP TS 23.501-style edges for this
// single-UPF deployment. N9 is deliberately not synthesized here:
// Free5GCProfile's own N9 loop (free5gc.go) only ever fires when NFTypeIUPF
// nodes exist, and this profile never classifies anything as NFTypeIUPF, so
// omitting the loop entirely is behaviorally identical to including a loop
// that always runs zero times -- not a functional gap.
//
// SCP and BSF are both represented as standard SBI-bus spokes off NRF, the
// same BusEdge-rendered pattern free5GC's AMF/SMF/etc already use. BSF fits
// this cleanly (it is a normal SBI-registered NF). SCP's real 3GPP role is
// as SBI routing infrastructure other NFs' traffic passes through, which a
// spoke-off-NRF edge does not capture precisely -- a distinct hub-style
// representation would be more architecturally faithful but needs new
// edge-model work the existing canvas rendering doesn't support today; the
// spoke treatment is the deliberate, documented simplification here.
func (*Open5GSProfile) BuildEdges(nodes []TopologyNode, upfNodeDNNs map[string][]string, dnByDNN map[string]TopologyNode) []TopologyEdge {
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

	// N3: gNB → UPF (single UPF, no ULCL split)
	for _, gnb := range byType[NFTypeGNB] {
		for _, upf := range byType[NFTypeUPF] {
			addEdge(gnb, upf, "n3", "N3", PlaneUserPlane)
		}
	}

	// N4: SMF ↔ UPF (PFCP)
	for _, smf := range byType[NFTypeSMF] {
		for _, upf := range byType[NFTypeUPF] {
			addEdge(smf, upf, "n4", "N4", PlanePFCP)
		}
	}

	// N6: UPF → DN, one edge per DNN served
	for _, upf := range byType[NFTypeUPF] {
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
		NFTypeBSF:  "Nbsf",
		NFTypeSCP:  "Nscp",
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

// open5gsSession is one entry in Open5GS's own upf.yaml `upf.session` list --
// each entry is one DNN the UPF serves. Confirmed against a live Gradiant
// open5gs-upf ConfigMap (chart v2.3.4, key "upf.yaml"):
//
//	upf:
//	  session:
//	    - dev: ogstun
//	      dnn: internet
//	      gateway: 10.45.0.1
//	      subnet: 10.45.0.0/16
//
// session is a list -- the same ConfigMap ships a commented-out second
// example entry (dnn: ims) as reference material for a multi-DNN setup, not
// live config, so this parses N entries even though exactly one is active
// in the confirmed deployment. gateway/dev are not read: nothing downstream
// (buildDNNodes, BuildEdges) consumes them, only the dnn value matters for
// N6 edge synthesis, matching what Free5GCProfile.ParseUPFConfig extracts
// from its own dnnList (free5gc.go's upfDNNItem, DNN-only).
type open5gsSession struct {
	DNN string `json:"dnn"`
}

type open5gsUPFSection struct {
	Session []open5gsSession `json:"session"`
}

type open5gsUPFYAMLDoc struct {
	UPF open5gsUPFSection `json:"upf"`
}

// ParseUPFConfig reads Open5GS's own upf.yaml ConfigMap key (rendered by the
// Gradiant open5gs-upf chart) to discover which DNNs the UPF serves. Reuses
// the exact same sigs.k8s.io/yaml unmarshal pattern Free5GCProfile.ParseUPFConfig
// already uses for free5GC's upfcfg.yaml (free5gc.go) -- no new parsing
// library or approach introduced.
//
// Unlike Free5GCProfile, entries are never matched to a specific UPF pod by
// label: Open5GS pods carry no `nf` label, only app.kubernetes.io/name=upf,
// so every entry comes back with NFLabel: "", which buildDNNodes
// (api-server/internal/k8s/topology.go:302-307) already treats as "applies
// to every NFTypeUPF node in the topology". That is correct and sufficient
// for this confirmed single-UPF deployment; it would not disambiguate DNNs
// per-instance if a multi-UPF Open5GS deployment needed that in the future.
func (*Open5GSProfile) ParseUPFConfig(ctx context.Context, cs *kubernetes.Clientset, namespaces []string) []UPFDNNEntry {
	var entries []UPFDNNEntry

	for _, ns := range namespaces {
		cms, err := cs.CoreV1().ConfigMaps(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			continue
		}
		for _, cm := range cms.Items {
			// Only open5gs-upf's ConfigMap carries this key -- e.g.
			// open5gs-upf-entrypoint's ConfigMap (a bash script under a
			// different key) simply fails this check and is skipped, same
			// as Free5GCProfile's own "upfcfg.yaml" key check (free5gc.go).
			raw, ok := cm.Data["upf.yaml"]
			if !ok {
				continue
			}
			var doc open5gsUPFYAMLDoc
			if err := sigsyaml.Unmarshal([]byte(raw), &doc); err != nil {
				continue
			}
			var dnns []string
			for _, s := range doc.UPF.Session {
				if s.DNN != "" {
					dnns = append(dnns, s.DNN)
				}
			}
			if len(dnns) == 0 {
				continue
			}
			entries = append(entries, UPFDNNEntry{NFLabel: "", DNNs: dnns})
		}
	}
	return entries
}
