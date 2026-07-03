# Technical Audit — coach5g

Audit conducted directly against the source tree at `c:\Users\Usuario\Documents\5g-observer`. All claims below are backed by file/line citations from the actual code, Helm manifests, Dockerfiles, and CI configuration. Where the code does not resolve a question unambiguously, this is stated explicitly rather than inferred.

---

## 1. FULL TECHNICAL STACK

**Languages**
- Backend: **Go 1.25.0** (`api-server/go.mod:3`) for the API server, **Go 1.23.0** (`capture-agent/go.mod:3`) for the capture agent. Both Dockerfiles build with `golang:1.26-alpine` (`api-server/Dockerfile:1`, `capture-agent/Dockerfile:2`), a newer toolchain than either `go.mod` minimum — a version inconsistency, not a functional issue.
- Frontend: **TypeScript 5.7.2** (`frontend/package.json:38`), compiled via `tsc && vite build` (`frontend/package.json:8`).

**Frontend framework/UI**
- **React 19.0.0** + **react-dom 19.0.0** (`frontend/package.json:22-23`), bundled with **Vite 6.0.5** (`package.json:39`).
- Routing: **react-router-dom 7.1.1** using `createBrowserRouter`/`RouterProvider` (`src/App.tsx:17-27`).
- Server-state/data fetching: **@tanstack/react-query 5.62.11** (`package.json:13`). `zustand 5.0.2` is declared but unused anywhere in `src/` (dead dependency).
- Styling: **Tailwind CSS 3.4.17** with a custom dark "telecom" theme (`tailwind.config.js:6-56`).
- Charts: **Recharts 2.13.3**, used only in `TimeSeriesChart.tsx`.
- Topology graph: **Cytoscape.js 3.30.2** with a hand-written `preset` layout (the installed `cytoscape-dagre` plugin is never invoked).
- Virtualized lists: **@tanstack/react-virtual 3.10.9** (packet tables, log panels).
- In-browser terminal: **@xterm/xterm 6.0.0** + fit/web-links addons.
- No dedicated HTTP client library — raw browser `fetch()` throughout (`src/services/api.ts`).
- No test framework present (no vitest/jest in devDependencies).

**Backend framework**
- **Gin** (`github.com/gin-gonic/gin v1.10.0`, `api-server/go.mod:5`) for HTTP routing/middleware.
- **gorilla/websocket v1.5.3** for all `/ws/*` endpoints.
- **google.golang.org/grpc v1.68.1** for the internal api-server ↔ capture-agent protocol.
- **k8s.io/client-go v0.32.0** for Kubernetes API access (both api-server and capture-agent).
- **zerolog v1.33.0** for structured logging.

**Database / persistent storage**
- No SQL/NoSQL database anywhere in the codebase. The system is stateless request/response over live upstream sources (Kubernetes API, Prometheus, Loki) plus **in-memory, non-persistent** ring buffers for recent packets (`api-server/internal/capture/grpc_server.go`, capacity 10,000 packets per session; `capture-agent/internal/capture/ring_buffer.go`, capacity 5,000).
- An optional PersistentVolumeClaim (`helm/templates/pvc.yaml`, backed by **Longhorn**, 5Gi) can mount `/pcap` into the capture-agent DaemonSet, but **no code in the `capture-agent` Go source writes to that path** — the PVC is provisioned but functionally unused by the current implementation (`captureAgent.persistence.enabled: false` by default, `helm/values.yaml:45`).

**Frontend↔Backend communication**
- **REST (HTTP/JSON)** for on-demand queries (topology snapshot, metrics, node/PVC/event lists, packet decode, pcap export).
- **WebSocket** for all push/streaming data: live topology (`/ws/topology`), live logs (`/ws/logs/:namespace/:pod`), live packet streams (`/ws/packets`), and the browser-based SSH terminal (`/ws/terminal`).
- No gRPC and no SSE are exposed to the browser; gRPC is used only internally between api-server and capture-agent.

**Containerization**
- Three independent multi-stage Dockerfiles, each producing a small final image:
  - `frontend/Dockerfile`: build stage `node:24-alpine` → runtime `nginx:1.27-alpine`, serving the Vite build output and reverse-proxying `/api` and `/ws` to the backend (`frontend/nginx.conf`).
  - `api-server/Dockerfile`: build stage `golang:1.26-alpine` (static `CGO_ENABLED=0` build) → runtime `ubuntu:24.04` with `tshark` installed (provides `sharkd` for packet decoding).
  - `capture-agent/Dockerfile`: build stage `golang:1.26-alpine` → runtime `ubuntu:24.04` with `tcpdump`, `tshark`, `iproute2`, `procps`, `util-linux` (provides `nsenter`).

**Deployment**
- A single **Helm chart** (`helm/Chart.yaml`, chart `coach5g`, appVersion `0.1.0`) with three workloads (`frontend` Deployment, `api-server` Deployment, `capture-agent` DaemonSet) plus a **Kubernetes Gateway API** `Gateway`/`HTTPRoute` pair (`helm/templates/gateway.yaml`, `httproute.yaml`) using `gatewayClassName: cilium` — i.e. it depends on **Cilium's** Gateway API controller, not Istio/Envoy Gateway. No raw Ingress manifest exists. CI (`.github/workflows/build.yml`) builds and pushes all three images to `ghcr.io/lpoclin/*` on push to `main`/tags, and runs `helm lint` as its only chart validation (no `helm template` dry-run, no policy/vulnerability scanning).

---

## 2. DATA SOURCES — WHERE EXACTLY IT COLLECTS EACH THING

### Prometheus
Implemented as a raw `net/http` client, no Prometheus client library (`api-server/internal/prometheus/client.go`). Base URL from `PROMETHEUS_URL` env var, default `http://kube-prometheus-stack-prometheus.monitoring:9090` (`cmd/server/main.go:40`; Helm overrides it to `.../prometheus` suffix, `helm/values.yaml:62`). Only two Prometheus HTTP API endpoints are used: `GET /api/v1/query` and `GET /api/v1/query_range` (`prometheus/client.go:304,345`). Exact PromQL strings used, by function:

- `ClusterMetrics` (`client.go:58-66`): `(1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100`; `(1 - sum(node_memory_MemAvailable_bytes)/sum(node_memory_MemTotal_bytes))*100`; `count(kube_pod_status_phase{phase="Running"})`; `count(kube_pod_info)`; `count(kube_node_status_condition{condition="Ready",status="true"})`; `count(kube_node_info)`; `count(kube_persistentvolumeclaim_status_phase{phase="Bound"})`; `count(kube_persistentvolumeclaim_info)`.
- `TimeSeries` (`client.go:104-105`, range query, step 60s/300s/900s for `1h`/`6h`/`24h`): `sum(rate(node_cpu_seconds_total{mode!="idle"}[5m]))`; `1 - sum(node_memory_MemAvailable_bytes)/sum(node_memory_MemTotal_bytes)`.
- `PodMetrics(namespace,pod)` (`client.go:116-117`): `sum(rate(container_cpu_usage_seconds_total{namespace="%s",pod="%s",container!=""}[5m]))*100`; `sum(container_memory_working_set_bytes{namespace="%s",pod="%s",container!=""})/1048576`. **These are built with unescaped `fmt.Sprintf` string interpolation of URL path parameters — a PromQL-injection-shaped weakness** (query-only, no write risk).
- `NodeMetrics` (`client.go:141-143`): per-instance CPU, memory, and root-filesystem utilization.
- `InterfaceDropRate(pod)` (`client.go:191-194`) — the only Hubble-related query, executed against Prometheus, not Hubble directly: `sum(rate(hubble_drop_total{source=~"<pattern>"}[30s])) / clamp_min(sum(rate(hubble_flows_processed_total{source=~"<pattern>"}[30s])), 0.001) * 100`.
- `NodePodCounts` (`client.go:205`): `count by(node) (kube_pod_info)`.
- `PodUtilization` (`client.go:232-235`): per-namespace/pod CPU and memory usage vs. limits.

### Loki
Also a raw `net/http` client (`api-server/internal/loki/client.go`), base URL from `LOKI_URL`, default `http://loki-gateway.loki` (`main.go:39`). **Only `GET /loki/api/v1/query_range` is ever called** (`loki/client.go:59`) — despite a code comment referencing a "tail API" (`handlers/logs.go:55`), live log tailing over WebSocket is implemented by **polling `query_range` every 2 seconds**, not Loki's real streaming `/tail` endpoint. Exact LogQL template, both for last-N-lines and for range queries: `{namespace="%s", pod=~".*%s.*"}` (`loki/client.go:41,47`) — namespace/pod interpolated unescaped via `fmt.Sprintf`, same injection-shaped caveat as Prometheus.

### Kubernetes API
Two independent `client-go` clients exist (api-server and capture-agent each build their own `*kubernetes.Clientset`). Both try **in-cluster config** first (`rest.InClusterConfig()`, reading the mounted ServiceAccount token/CA) and fall back to `~/.kube/config`/`$KUBECONFIG` for local development (`api-server/internal/k8s/client.go:14-22`; `capture-agent/internal/discovery/pods.go:33-43`).

- **api-server** uses only typed `CoreV1()` calls — `Pods`, `Namespaces`, `Nodes`, `Events`, `PersistentVolumeClaims`, `ConfigMaps` — via `List`/`Get`, with **no field/label selectors** in the `handlers`/`k8s` packages (`listOpts()`/`getOpts()` return empty `metav1.ListOptions{}`, e.g. `handlers/common.go:7-13`), so most calls fetch **all objects in all namespaces** on every request (no caching, no `Watch`, no informers). Concretely: `Nodes().List` (`infrastructure.go:30`), `Events(ns="").List` (`infrastructure.go:141`), `PersistentVolumeClaims("").List` (`infrastructure.go:177`), `Pods("").List` (`infrastructure.go:232`, `topology.go:747` per-namespace), `ConfigMaps(ns).List` (`k8s/topology.go:493`, to read UPF `upfcfg.yaml` DNN lists), `Pods("kube-system").List` (`k8s/topology.go:644,700`, for CNI detection). **No `Watch()`, no CRD/dynamic client, no `pods/exec` or `remotecommand` calls anywhere.**
- **capture-agent** uses a single, narrow call: `Pods(ns).List(ctx, metav1.ListOptions{FieldSelector:"status.phase=Running"})` per target namespace (`discovery/pods.go:75-77`), polled every **10 seconds** (`pods.go:54`), then filters client-side to pods scheduled on its own node (`NODE_NAME` from the Downward API).
- **RBAC**: a single **ClusterRole** `observer` (`helm/templates/rbac.yaml`), read-only (`get`,`list`,`watch` only, no write verbs), granting `pods`, `pods/log`, `services`, `nodes`, `events`, `namespaces`, `persistentvolumeclaims`, `persistentvolumes` (core API group); `network-attachment-definitions` (Multus CRD group `k8s.cni.cncf.io`); and `pods`,`nodes` under `metrics.k8s.io` (requires metrics-server). Bound cluster-wide via ClusterRoleBinding to one ServiceAccount, `observer`, which **all three workloads** (frontend, api-server, capture-agent) share (`*-deployment.yaml:21`, `capture-agent-daemonset.yaml:21`) — the static nginx frontend is granted the same cluster-wide read access as the other two, despite having no code path that uses it.

### Hubble
Consumed **only indirectly, via Prometheus metrics** (`hubble_drop_total`, `hubble_flows_processed_total`) as shown above. The dedicated `api-server/internal/hubble/client.go` package is a **stub**: its `ActiveFlows()` always returns an empty map and is never imported by `cmd/server/main.go` — there is no working gRPC connection to Hubble Relay anywhere in the code, despite `HUBBLE_ADDRESS=hubble-relay.kube-system:4245` being wired as an env var (`helm/templates/api-server-deployment.yaml:44-45`).

### Packet capture (the system's most distinctive data source)
Real, unfiltered live traffic capture, implemented entirely with external subprocesses — no `gopacket`/libpcap Go bindings are used (`capture-agent/go.mod` has no such dependency):

1. **Discovery** (Kubernetes API, as above) yields `(PodUID, ContainerID, Interfaces[])` per pod on the local node.
2. **PID resolution** (`capture-agent/internal/capture/nsenter.go:28-72`, `findPodPID`) — pure `/proc` filesystem inspection, no CRI/containerd API call: scans every `/proc/<pid>/cgroup` on the host, string-matches the pod UID (cgroupv1 hyphen or cgroupv2 underscore form) and the first 12 hex chars of the container ID.
3. **Namespace join + capture** (`nsenter.go:93-147`): the exact command executed is
   `nsenter --net=/proc/<PID>/ns/net -- tcpdump -i <iface> -w - --immediate-mode -s 0`
   launched via `exec.CommandContext` (no BPF filter is ever passed, so **all** traffic on the interface is captured, unfiltered, with `-s 0` = no truncation).
4. tcpdump's raw pcap bytes on stdout are parsed **in-process** by a hand-rolled Go pcap-format parser (`parsePcapFramesDirect`, `nsenter.go:455-512`) with manual Ethernet/VLAN/IPv4/IPv6/ARP field extraction (`extractPacketFields`, `nsenter.go:308-451`), including 5G-specific port recognition (UDP 8805→PFCP, UDP 2152→GTP-U).
5. Optionally, when the operator opens a live view in the UI (see §4), api-server calls the agent's `EnableTshark` RPC, which additionally tees tcpdump's stdout into `tshark -r - -T fields ...` for richer protocol-name decoding (NGAP, NAS, SCTP, HTTP/2, DNS, TCP, UDP).
6. Captured packets are **never written to disk** by this code path (the pcap only exists transiently as a byte stream); the optional `/pcap` PVC mount is unused by the reviewed Go source.
7. Packets are batched (≤50 or every 100ms) and shipped over a **plaintext (no TLS)** gRPC client-streaming call `StreamPackets` to the api-server on `<api-server>:9999`, with exponential-backoff retry.

This requires the capture-agent DaemonSet to run with `hostPID: true`, `privileged: true`, and capabilities `NET_RAW`, `NET_ADMIN`, `SYS_PTRACE`, plus read-only hostPath mounts of `/proc` and `/sys` (`helm/templates/capture-agent-daemonset.yaml:22,33-39,63-69`) — this is what allows the agent container to see and enter the network namespace of arbitrary other pods on the same node.

### Command execution inside pods
There is **no `kubectl exec`/Kubernetes `pods/exec` subresource usage anywhere** in the codebase. The only "shell into something" feature is `/ws/terminal` (`api-server/internal/handlers/terminal.go`), which is a **generic SSH gateway**: it dials a raw SSH connection (via `golang.org/x/crypto/ssh`, host-key verification disabled with `ssh.InsecureIgnoreHostKey()`) to `SSH_HOST`/`SSH_PORT` (or a client-supplied host) using client-supplied username/password, and relays a PTY session over the WebSocket. It is unrelated to the Kubernetes API and not scoped to any particular pod/container — it targets whatever SSH server is reachable, and the deployed default target is the **Kubernetes control-plane node itself** (`terminal.sshHost: "192.168.18.210"`, `helm/values.yaml:69`).

### Logs
Not read from container stdout or files directly by this codebase — logs are always fetched from **Loki** (as described above), which is assumed to already be scraping the cluster's containers via an external Promtail/Loki agent stack not part of this repository.

---

## 3. MAIN COMPONENTS / MODULES

| Module | Responsibility | Location | Talks to |
|---|---|---|---|
| **frontend** | React SPA: topology visualization, infrastructure dashboard, packet-capture UI, SSH terminal | `frontend/src/` | api-server, via REST (`services/api.ts`) and WebSocket (`services/websocket.ts`, raw `WebSocket` in `CapturePage.tsx`/`TerminalPanel.tsx`) |
| **api-server** (HTTP/Gin) | REST + WebSocket gateway; aggregates Kubernetes, Prometheus, Loki data; serves packet decode/export; SSH terminal gateway | `api-server/internal/handlers/*`, `cmd/server/main.go` | Kubernetes API (`internal/k8s`), Prometheus (`internal/prometheus`), Loki (`internal/loki`), capture-agent (gRPC), local `sharkd`/`tshark` subprocess, arbitrary SSH host |
| **api-server capture hub** (gRPC server, `:9999`) | Receives packet batches from all capture-agent instances, fans them out to WebSocket subscribers, maintains per-session ring buffers and traffic-rate stats, remote-controls tshark decoding on agents | `api-server/internal/capture/grpc_server.go` | capture-agent (bidirectional gRPC: server for `StreamPackets`, client for `EnableTshark`/`DisableTshark`/`Ping` on `<agent-pod-ip>:9998`) |
| **capture-agent** (per-node DaemonSet) | Discovers pods on its own node; for each pod/interface, joins the pod's network namespace and captures live traffic via tcpdump/tshark; streams packets to api-server | `capture-agent/internal/{discovery,capture,control,grpc}` | Kubernetes API (pod discovery), local `/proc` (PID/netns resolution), local `nsenter`/`tcpdump`/`tshark` subprocesses, api-server (gRPC client for streaming, gRPC server for control) |
| **Topology builder** | Converts raw Pod objects into a 3GPP-style NF graph (SBI bus, N1/N2/N3/N4/N6/N9 edges) using pod labels/name heuristics and UPF ConfigMap DNN entries | `api-server/internal/k8s/topology.go` | Kubernetes API only |
| **CNI/Hubble metrics glue** | Detects the cluster's primary/secondary CNI via `kube-system` pod heuristics; gates Hubble drop-rate queries to Cilium-only interfaces | `api-server/internal/k8s/topology.go` (`DetectPrimaryCNI`), `internal/prometheus/client.go` (`InterfaceDropRate`) | Kubernetes API, Prometheus |
| **Terminal gateway** | Generic browser-to-SSH bridge over WebSocket/PTY | `api-server/internal/handlers/terminal.go`, `frontend/src/components/Terminal/TerminalPanel.tsx` | Arbitrary SSH server (default: cluster control-plane node) |
| **Gateway API ingress** | Single external entry point routing `/api/`,`/ws/` → api-server:8080, everything else → frontend:80 | `helm/templates/gateway.yaml`, `httproute.yaml` | Cilium Gateway API controller |

---

## 4. FUNCTIONALITY — WHAT IT ACTUALLY DOES

| User action | Backend call | What happens internally | User feedback |
|---|---|---|---|
| Open the Topology page | `GET /api/topology?namespace=` + `GET /ws/topology` | `TopologyHandler.GetTopology` (`topology.go:120`) lists Pods/ConfigMaps across target namespaces and builds a 3GPP-style graph (`k8s.BuildTopology`); `WatchTopology` (`topology.go:177`) re-sends the graph every 5s over WebSocket | Rendered Cytoscape.js diagram of NFs, refreshed live |
| View live traffic indicators on topology edges | `GET /api/metrics/active`, polled every 300ms (`TopologyPage.tsx:125`) | `MetricsHandler.GetActiveTraffic` reads in-memory active src/dst pairs from the capture hub (no external call) | Animated dots/pulses along edges currently carrying traffic |
| Click an NF node | (client-side only) | Opens `SidePanel` | Shows pod info + a live log tab |
| View an NF's logs | `GET /ws/logs/:namespace/:pod` | `LogsHandler.StreamLogs` sends last 200 lines via one Loki query, then polls Loki's `query_range` every 2s and pushes new lines | Live-scrolling log viewer with level-based coloring |
| Click "Live Capture" on an interface tooltip | `GET /ws/packets?pod=&interface=` | Client navigates to `/captures?pod=&interface=`; `PacketsHandler.StreamPacketsQuery` subscribes to the capture hub; on the **first** subscriber for that session, api-server calls `CallEnableTshark` — a gRPC call to that pod's node-local capture-agent — which starts `nsenter+tcpdump` (and tshark) on the target pod's interface | A new tab opens in the Captures view with a live, Wireshark-style packet table |
| Select a packet row | `GET /api/packet/decode?pod=&interface=&ts=` | `DecodePacketHandler` pulls the raw bytes for that timestamp from the ring buffer, writes a temp 1-packet pcap file, and drives `sharkd` via JSON-RPC over stdin/stdout to get a full protocol dissection | Protocol tree + hex dump panel |
| Export packets (30s/5min/1h or custom range) | `GET /api/packets/export?pod=&interface=&duration=` or `&start=&end=` | `ExportPacketsHandler` reads matching packets out of the ring buffer and streams a hand-written valid `.pcap` file directly to the response | Browser download of a `.pcap` file |
| Filter/search packets in a capture tab | (client-side only) | Filtering happens entirely in the browser over already-received packets | Table re-renders instantly |
| Pause/Resume/Clear a capture tab | (client-side only, no dedicated stop endpoint call) | The WebSocket keeps streaming; pause just stops appending to the visible buffer client-side | Table freezes/clears |
| Close the last viewer of a capture session | (WebSocket close) | On last unsubscribe, api-server calls `CallDisableTshark` on the agent, stopping the tshark decode goroutine (raw tcpdump capture loop for that session also tears down when no session context remains) | Tab closes |
| View Infrastructure page | `GET /api/nodes`, `/api/cluster-info`, `/api/metrics/cluster`, `/api/events`, `/api/namespace-stats`, `/api/metrics/pods`, `/api/metrics/timeseries` | Combination of Kubernetes `List` calls and Prometheus queries, refreshed every 10–15s (metrics.pods) or on range-button click for timeseries | Node cards, cluster gauges, per-pod utilization table, CPU/RAM area charts, K8s events table |
| Change time-series range (1h/6h/24h) | `GET /api/metrics/timeseries?range=` | New Prometheus `query_range` with a different step | Chart re-renders for the new window |
| Open the SSH terminal panel | `GET /ws/terminal`, then client sends `{type:"auth", host, user, password}` | api-server dials SSH to `SSH_HOST:SSH_PORT` (or a client-specified host) with the given credentials, host-key checking disabled, opens a PTY, relays I/O | Interactive xterm.js terminal in-browser |
| Click a topology edge | (client-side only) | No backend call | Toast: "capture coming soon" (unimplemented) |

---

## 5. SCREENS / TABS / VIEWS OF THE INTERFACE

| Route | File | Displays | Visual components | Interactivity |
|---|---|---|---|---|
| `/` (Topology) | `frontend/src/pages/TopologyPage.tsx` | 3GPP-style NF topology graph with SBI bus, animated traffic on active edges | `TopologyCanvas` (Cytoscape.js + Canvas 2D overlay), `SidePanel` (logs/info tabs), `TerminalPanel` (bottom drawer) | Node click → side panel; interface tooltip → per-interface metrics + "Live Capture" button; draggable node positions (persisted to `localStorage`); resizable side-panel/terminal; manual refresh; auto-refresh (5s poll + WS push for topology, 300ms poll for active-traffic overlay) |
| `/infrastructure` | `frontend/src/pages/InfrastructurePage.tsx` | Cluster-wide node/pod/PVC/event summary "without Grafana" | `ClusterGauges` (4 stat cards), `NodeCards` (per-node CPU/RAM/disk bars + hover detail), `PodUtilizationPanel` (table), `TimeSeriesChart` (Recharts area charts), `EventsTable` | Time-range buttons (1h/6h/24h) on the chart; all other panels auto-refresh every 10–15s, no manual filters |
| `/captures` | `frontend/src/pages/CapturePage.tsx` (always-mounted inside `Layout`, largest file at 1527 lines) | Wireshark-style live packet tables, one per open capture tab (up to 8), plus protocol decode/hex-dump panel | Virtualized packet table (`@tanstack/react-virtual`), split-pane decode panel (protocol tree + hex dump), tab strip | Pause/Resume/Clear; protocol quick-filters (GTP-U/PFCP/HTTP/HTTP2/NGAP/SCTP/DNS/TCP/UDP/All); free-text search; From/To time range picker; quick-duration export links (30s/5min/1h); add-tab NF/interface dropdown; tab close; single/split view toggle; no fixed polling — packets arrive push-style over WebSocket |

Note: `App.tsx`'s router technically defines a fourth "route" for `/captures` but its element is an empty fragment — `Layout.tsx` keeps `CapturePage` permanently mounted (toggling CSS visibility) so its WebSocket connections survive navigation between tabs (`Layout.tsx:107-122`).

---

## 6. AUTHENTICATION AND SECURITY

- **No application-level authentication exists.** There is no login page, no session/JWT/cookie handling, and the frontend's REST client never attaches an `Authorization` header (`frontend/src/services/api.ts:9-19`, headers hardcoded to only `Content-Type: application/json`). Every `/api/*` and `/ws/*` route is reachable by anyone who can route to the Gateway IP, with zero credential check inside the Go handlers.
- CORS is wide open: `Access-Control-Allow-Origin: *` (`api-server/cmd/server/main.go:165-176`), and the WebSocket upgrader accepts any Origin (`CheckOrigin: func(r *http.Request) bool { return true }`, `topology.go:19-23`).
- **RBAC**: a single cluster-wide **ClusterRole** `observer`, read-only (`get/list/watch` only, no write verbs), covering core Pods/Services/Nodes/Events/Namespaces/PVCs/PVs, Multus CRDs, and `metrics.k8s.io` (`helm/templates/rbac.yaml`, full text reproduced above in §2). Bound via one ClusterRoleBinding to one ServiceAccount `observer`, shared identically by **all three workloads**, including the static frontend, which has no code path requiring cluster API access.
- **Cluster connectivity**: both Go binaries use the standard client-go in-cluster ServiceAccount-token mechanism, with a kubeconfig fallback purely for local development outside the cluster.
- **The one credentialed feature — the SSH web-terminal — is the weakest link found**: host-key verification is explicitly disabled (`ssh.InsecureIgnoreHostKey()`, `terminal.go:93-97`), the default configured target is the **Kubernetes control-plane node itself** (`terminal.sshHost: "192.168.18.210"`), and the client can override the target host arbitrarily (`{"type":"auth","host":...}`), turning the api-server into an open network pivot to any SSH-reachable host, gated only by whatever SSH credentials the caller supplies (and by whatever network perimeter fronts the unauthenticated web UI). The username/password transit the WebSocket as plaintext JSON (`TerminalPanel.tsx:157-158`); confidentiality depends entirely on the outer connection being `wss://`/TLS, which is not configured anywhere in this deployment (the Gateway only defines an HTTP, not HTTPS, listener — `helm/templates/gateway.yaml`).
- **Transport security**: all internal gRPC (api-server↔capture-agent) uses `insecure.NewCredentials()` — plaintext, no TLS, no mTLS, no per-call auth token. The external Gateway also only exposes plain HTTP (no TLS listener configured).
- **Container privilege**: capture-agent runs `privileged: true` with `hostPID: true` and `NET_RAW/NET_ADMIN/SYS_PTRACE` capabilities plus read-only hostPath mounts of `/proc` and `/sys` — by design, to allow entering other pods' network namespaces for capture. This is a very large blast radius if the capture-agent container is ever compromised (near-root access to the node).

---

## 7. CURRENT TECHNICAL LIMITATIONS

**Hardcoded / deployment-specific**
- Default target namespace `free5gc` is hardcoded as the fallback everywhere it matters (`api-server main.go` topology default, `capture-agent main.go:24` default `TARGET_NAMESPACES`, `helm/values.yaml:3-4`).
- The topology builder's NF classification is driven by a **fixed keyword list** — `amf, smf, upf, nrf, ausf, udm, udr, pcf, nssf, chf, nef, gnb, n3iwf, nwdaf, scp, sepp` (`k8s/topology.go:40-43`) — and by **free5GC-specific UPF-splitting terminology** (`iUPF`, `PSA-UPF1/2`) baked into the synthesized N3/N9/N6 edge logic (`k8s/topology.go:1014-1041`, README.md:49-51). UPF DNN discovery reads a free5GC-shaped `upfcfg.yaml` key out of a ConfigMap (`k8s/topology.go:493`), a format specific to free5GC's UPF configuration, not a generic 5G-core config schema.
- Helm chart keywords explicitly list `free5gc` and `ueransim` (`helm/Chart.yaml:10-11`); no mention of Open5GS or OAI anywhere in the repository.
- Hardcoded lab IPs baked into `values.yaml`/README as defaults: Gateway LB IP `192.168.18.234`, SSH terminal target `192.168.18.210` (the cluster's own control-plane node), and a 4-node cluster topology description (`README.md:66-73`) specific to one physical lab (Proxmox VE hypervisor, `clusterInfo.hypervisor: "Proxmox VE"`).
- Hard dependency on **Cilium** specifically (not just "any CNI"): the Gateway API resource requires `gatewayClassName: cilium` and a `cilium.io/ipam-pool` annotation (`gateway.yaml:8-10`) to get an externally reachable IP; Hubble drop-rate metrics only populate when Cilium is detected as the primary CNI, and even then only for `iface=="eth0"` (`metrics.go:92-97`).
- Assumes **kube-prometheus-stack** and **Loki** are already installed at their conventional Helm-release service names (`kube-prometheus-stack-prometheus.monitoring`, `loki-gateway.loki`) — these are naming conventions, not universal Kubernetes primitives.
- Interface discovery depends on the **Multus** `k8s.v1.cni.cncf.io/network-status` pod annotation (`discovery/pods.go:112`, `k8s/topology.go`); without Multus, everything defaults to a single `eth0` interface.

**Generic / reusable as-is with any Kubernetes-native 5G core**
- The Infrastructure View (nodes, PVCs, events, namespace stats, cluster/pod resource utilization) is entirely generic Kubernetes/Prometheus tooling with no 5G-specific assumptions — it would work unmodified against any cluster.
- The packet-capture mechanism itself (nsenter+tcpdump+tshark against any pod's network namespace, ring buffer, gRPC fan-out, pcap export, sharkd decode) is **fully core-agnostic** — it operates on any pod/interface a user selects, regardless of what NF runs inside it. Protocol name recognition for GTP-U/PFCP is based on standard UDP ports (2152/8805) defined by 3GPP, not free5GC-specific, so it correctly labels this traffic for OAI or Open5GS deployments too.
- The Loki-backed log viewer and the SSH terminal gateway are both fully generic — neither has any 5G-core-specific logic.
- RBAC, deployment topology (Deployments + DaemonSet + Gateway API), and the CI pipeline are generic and not core-specific.

**Would require code changes to port to a different 5G core (e.g. Open5GS, OAI)**
- NF discovery/classification logic in `k8s/topology.go` (keyword list, label-based heuristics, and the specific N3/N9/N6 edge-synthesis algorithm built around free5GC's iUPF/PSA-UPF split) would need to be reworked or made pluggable for cores that model UPF differently (Open5GS and OAI do not split UPF into intermediate/anchor instances by default).
- The UPF DNN/ConfigMap parsing (`getUPFDNNEntries`, reading a free5GC-shaped `upfcfg.yaml`) is specific to free5GC's configuration format and would not parse Open5GS's or OAI's UPF config structures.
- Default namespace, Helm values, and README material all assume free5GC + UERANSIM; adapting to another core means overriding `targets[].namespace` and (for correct topology rendering) extending or replacing the NF-keyword/edge-synthesis logic — this is a code change, not just a values override, if the target core's NF split differs structurally from 3GPP's SBI model as free5GC implements it.
- Terminal/SSH default host and any lab-specific IP defaults would need reconfiguration (values-only change, not code, but worth noting as it's presented as a "cluster requirement" rather than a parameter).

---

## 8. EXECUTIVE SUMMARY FOR THE ABSTRACT

This paper presents coach5g, an observability and diagnostic platform for Kubernetes-native 5G Standalone testbeds built on free5GC and UERANSIM. The system combines read-only Kubernetes API introspection, Prometheus and Loki query aggregation, and a privileged per-node capture agent that performs live, unfiltered packet capture by entering target pods' network namespaces via `nsenter` and `tcpdump`, without relying on a Go packet-capture library. Captured traffic is streamed over gRPC to a central API server, decoded on demand via a `tshark`/`sharkd` subprocess, and exposed through a React single-page application offering a 3GPP TS 23.501-style network-function topology view, a cluster infrastructure dashboard, and a multi-tab Wireshark-style capture interface, all updated in near real time over WebSocket. The current implementation has no application-level authentication, assumes an already-provisioned Prometheus/Loki/Cilium-Hubble stack, and encodes several free5GC-specific assumptions — namely UPF-splitting terminology and NF-classification heuristics — that would require code changes, not configuration alone, to generalize to other 5G core implementations such as Open5GS or OpenAirInterface.

---

## 9. NAME PROPOSAL

Based strictly on what the system does — read-only observability plus interactive packet-level control over a live cloud-native 5G core — three candidate names:

1. **NFScope** — evokes both "Network Function" and an oscilloscope/inspection instrument; short, unambiguous, no collision with known OSS projects.
2. **CoreLens** — "lens into the core network"; captures the dual observability (topology/metrics) + inspection (packet capture) role without genericizing to "dashboard."
3. **PlaneWatch** — references the SBI/user/control "planes" the tool visualizes and the live traffic-watching function; distinct from existing network-observability tool names (Wireshark, Grafana, Hubble, Kiali, etc.).
