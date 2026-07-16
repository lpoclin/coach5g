// Package coreprofile defines the pluggable 5G-core classification contract
// (CoreProfile) and the domain types shared between it and package k8s.
// These types live here, not in package k8s, so that k8s can import
// coreprofile (for the CoreProfile interface and Free5GCProfile) without
// creating an import cycle -- package k8s re-exports every type below as a
// type alias so its own existing code is unaffected.
package coreprofile

import "time"

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
	NFTypeSCP     NFType = "SCP"
	NFTypeBSF     NFType = "BSF"
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
	NodeIP      string             `json:"nodeIP"` // k8s node InternalIP — matches Prometheus instance label
	Status      PodStatus          `json:"status"`
	Interfaces  []NetworkInterface `json:"interfaces"`
	Age         string             `json:"age"`
	Image       string             `json:"image"`
	Labels      map[string]string  `json:"labels"`
	Containers  []string           `json:"containers"` // container names, for exec-target selection
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

// UPFDNNEntry associates one or more DNNs with a UPF, identified by the value
// of that UPF's `nf` label ("" = applies to all UPFs). Produced by
// CoreProfile.ParseUPFConfig, consumed by package k8s's buildDNNodes.
type UPFDNNEntry struct {
	NFLabel string
	DNNs    []string
}
