# 01 — Requirements

This page lists what coach5g needs to run, split into two groups. Hard requirements mean the tool does not do its job without them. Optional enhancements mean the tool runs and stays usable, but a specific feature is missing or hidden.

For each item, this page states whether it was validated in this project's own testbed, or whether it is expected to work but has not been tested here.

---

## Hard requirements

### A Kubernetes cluster

Both Go binaries (`api-server`, `capture-agent`) use `client-go`'s standard in-cluster config first, falling back to a local kubeconfig for development (`api-server/internal/k8s/client.go:14-22`, `capture-agent/internal/discovery/pods.go:33-43`). Nothing in either binary depends on a specific Kubernetes distribution.

Validated: kubeadm-provisioned Kubernetes 1.35.4, per the sibling testbed project's own software stack list (external reference, not part of this repository).

### Prometheus

`api-server` reads `PROMETHEUS_URL` (default `http://kube-prometheus-stack-prometheus.monitoring:9090`, `api-server/cmd/server/main.go:40`; the Helm chart overrides this to `.../prometheus`, `helm/values.yaml:61-62`). The Infrastructure page's cluster gauges, node cards, time-series charts, and per-pod utilization table all come from Prometheus queries (`api-server/internal/prometheus/client.go`).

Without Prometheus reachable at that URL, these panels do not error out. `GetClusterMetrics` falls back to an all-zero stub on query failure (`api-server/internal/handlers/metrics.go`, `defaultClusterMetrics()`). In practice this means the Infrastructure page loads but shows zeroed-out or empty metrics rather than real numbers, so treat Prometheus as required for that page to be useful.

Validated: kube-prometheus-stack 85.0.3, per the sibling testbed project.

### Loki

`api-server` reads `LOKI_URL` (default `http://loki-gateway.loki`, `main.go:39`; chart default `http://loki-gateway.loki`, `helm/values.yaml:58-59`). The per-NF log viewer in the Topology page's side panel depends on it entirely (`api-server/internal/loki/client.go`, `api-server/internal/handlers/logs.go`).

Without Loki reachable, `GetLogs` and `StreamLogs` soft-fail to an empty result rather than erroring (`logs.go`). The log panel will simply show nothing.

Validated: Loki 3.7.2 with Grafana Alloy as the log shipper, per the sibling testbed project. This tool does not ship or configure a log shipper itself; it assumes Loki is already receiving logs from the cluster.

### A 5G core deployment

The topology builder's node classification is written specifically for free5GC's and UERANSIM's pod-label and pod-name conventions (`app.kubernetes.io/component`, `nf`, `component` labels; `iupf`/`psaupf` naming; see `api-server/internal/k8s/topology.go:136-287`). It also parses free5GC's own `upfcfg.yaml` ConfigMap format to discover UPF-to-DNN mappings (`topology.go:472-520`).

Validated: free5GC v4.2.2 in a ULCL configuration (one branching UPF, two anchor UPFs) with UERANSIM v4.0.1, per this repository's own README and Chart.yaml keywords (`README.md:32-33,46-51`, `helm/Chart.yaml:10-11`), matching the sibling testbed project's own validated topology exactly (free5GC v4.2.2, UERANSIM v4.0.1, gtp5g v0.10.2).

Open5GS or OpenAirInterface (OAI) are not referenced anywhere in this repository or in the sibling testbed project. Running this tool against either would require the pluggable classification work described in `docs/RISK_ASSESSMENT_ADDITIONS.md`, Addition 3. Without that work, pods from a non-free5GC core will most likely be classified as `UNKNOWN` and dropped from the topology graph (`topology.go:806-808`).

---

## Optional enhancements

### Multus

Multi-interface pod discovery reads the Multus CNI annotation `k8s.v1.cni.cncf.io/network-status` (`capture-agent/internal/discovery/pods.go:112`). If the annotation is missing, the agent falls back to a single interface, `eth0` (`pods.go:114,142-144`).

What you lose without it: the ability to select and capture on any interface other than `eth0` (N2, N3, N4, N6, N9 planes on free5GC NF pods will not show up as separate interfaces to capture on).

Validated: Multus 4.2.4 (thick plugin), per the sibling testbed project. See `docs/CNI_GATEWAY_PORTABILITY_ASSESSMENT.md`, Layer 2, for the full trace of this behavior.

### Cilium with Hubble

The Infrastructure and Topology views show a per-interface packet drop rate sourced from Hubble's Prometheus metrics (`hubble_drop_total`, `hubble_flows_processed_total`), queried only when the primary CNI is detected as Cilium and the interface is `eth0` (`api-server/internal/handlers/metrics.go:92-98`).

What you lose without it: the drop rate row simply does not render. This is not an error state; the frontend conditionally hides it (`frontend/src/components/Topology/SidePanel.tsx:331`, `frontend/src/components/Topology/TopologyCanvas.tsx:671-672`), and the backend query itself returns `0` rather than failing when Hubble metrics are absent (`api-server/internal/prometheus/client.go:184,196-199`).

Validated: Cilium 1.19.3 with Hubble Relay and metrics export enabled, per the sibling testbed project. See `docs/CNI_GATEWAY_PORTABILITY_ASSESSMENT.md`, Layer 2, section E.

### Cilium Gateway API

A single, stable external IP and one URL for the whole application (frontend, REST API, WebSocket) comes from `helm/templates/gateway.yaml` and `helm/templates/httproute.yaml`, which currently assume Cilium's own Gateway API controller (`gatewayClassName: cilium` by default, `helm/values.yaml:8`) plus two cluster-level Cilium resources applied outside this chart (`CiliumLoadBalancerIPPool`, `CiliumL2AnnouncementPolicy`).

What you lose without it: nothing that affects whether the tool works, only how you reach it. See [02](02-installation-cilium.md), [03](03-installation-generic-gateway.md), and [04](04-installation-no-gateway-api.md) for the three ways to expose the frontend depending on what your cluster has.

Validated: Cilium's Gateway API implementation, Gateway API CRDs v1.4.1, per the sibling testbed project. A generic (non-Cilium) Gateway API controller and a plain Service fallback are both discussed later in this guide, and neither has been tested against a live cluster.
