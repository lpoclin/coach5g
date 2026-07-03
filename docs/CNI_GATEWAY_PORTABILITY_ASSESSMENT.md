# Pre-Implementation Risk Assessment — External Exposure & CNI Portability

Diagnostic only. No code has been written or modified. All claims about current behavior are cited to file/line; recommendations are explicitly labeled as judgment, not fact.

---

## LAYER 1 — External exposure (Gateway / LoadBalancer / NodePort)

### A. Current State (fact)

**`helm/templates/gateway.yaml`** (full file, 23 lines):
- `gatewayClassName: {{ .Values.gateway.gatewayClassName }}` (`gateway.yaml:12`) — templated, but `helm/values.yaml:8` sets the only default: `gatewayClassName: cilium`. Nothing in the chart branches on this value; whatever string is supplied is passed through verbatim.
- `metadata.annotations` unconditionally includes `cilium.io/ipam-pool: "default"` (`gateway.yaml:8-10`) — this is **not gated behind any condition on `gatewayClassName`**. It renders identically regardless of what `gatewayClassName` is set to.
- `spec.addresses[0] = {type: IPAddress, value: .Values.gateway.ip}` (`gateway.yaml:20-22`). `spec.addresses` is a **standard field of the core Gateway API spec** (`gateway.networking.k8s.io/v1`), not a Cilium extension — but whether a given `GatewayClass` controller actually honors a caller-requested static address is controller-specific and cannot be determined from this codebase; it would need to be verified against whichever controller is in play (Istio, Envoy Gateway, etc.).
- The `Gateway` defines exactly one listener: `http`/port 80 (`gateway.yaml:14-19`) — no TLS listener (consistent with the earlier finding that this deployment is HTTP-only).

**`helm/templates/httproute.yaml`** (full file, 35 lines): plain, standard Gateway API `HTTPRoute` — `parentRefs` to the `Gateway` above (`httproute.yaml:9-11`), `hostnames` list containing `.Values.gateway.hostname` and `.Values.gateway.ip` (`httproute.yaml:12-14`), and two `PathPrefix` rules: `/api/`,`/ws/` → `observer-api:8080`, `/` → `observer-frontend:80` (`httproute.yaml:16-34`). **Nothing in this file is Cilium-specific** — no Cilium annotations, no IPAM references, no non-standard fields. This file would function unchanged under any spec-compliant Gateway API implementation (Istio, Envoy Gateway, etc.), independent of the `Gateway` resource's Cilium coupling.

**`helm/values.yaml`** (full file, 76 lines) — confirmed no other Cilium-specific resources exist in this chart. `helm/templates/` contains exactly: `_helpers.tpl`, `api-server-deployment.yaml`, `api-server-service.yaml`, `capture-agent-daemonset.yaml`, `frontend-deployment.yaml`, `frontend-service.yaml`, `gateway.yaml`, `httproute.yaml`, `pvc.yaml`, `rbac.yaml`, `serviceaccount.yaml` — **no `CiliumLoadBalancerIPPool` or `CiliumL2AnnouncementPolicy` template exists in this chart**, confirming the user's statement that those two are applied manually, outside the chart, as testbed setup steps. There is also **no plain `Service` type fallback and no `gateway.class`/exposure-tier flag anywhere in `values.yaml`** today.

**A previously-unstated architectural fact, load-bearing for Tier 3 below**: the frontend's own `nginx.conf` (full file, 40 lines, `frontend/nginx.conf`) **already implements the exact same path-split that `HTTPRoute` implements**, independently:
- `location /api/ { proxy_pass http://observer-api:8080; ... }` (`nginx.conf:14-19`)
- `location /ws/ { proxy_pass http://observer-api:8080; proxy_set_header Upgrade $http_upgrade; ...}` (`nginx.conf:22-29`, WebSocket upgrade headers present)
- `location / { try_files $uri $uri/ /index.html; }` (`nginx.conf:9-11`, SPA fallback)

This means the `observer-frontend` pod is a **fully self-contained entry point** that does not depend on `HTTPRoute`'s routing at all — it performs the identical `/api/`, `/ws/`, `/` split internally via the cluster-DNS name `observer-api:8080` (a Kubernetes Service name, resolvable from any pod in the cluster regardless of CNI or Gateway API presence).

**`helm/templates/frontend-service.yaml`** (full file, 17 lines): `type: ClusterIP` is hardcoded (`frontend-service.yaml:17`), not templated from any values key.

**CORS / origin-checking — host-agnostic, confirmed by grep of the whole `api-server` tree**:
- `c.Header("Access-Control-Allow-Origin", "*")` (`api-server/cmd/server/main.go:167`) — wildcard, not keyed to any specific host/IP.
- `CheckOrigin: func(r *http.Request) bool { return true }` (`api-server/internal/handlers/topology.go:20`) — the single shared WebSocket upgrader used by all `/ws/*` routes accepts any origin unconditionally.

No other CORS/origin-check call site exists in the Go backend. **Fact: nothing in the backend or in `nginx.conf` assumes a fixed base path, a specific host header, or the absence of a path prefix.** Both the Gin routes (`/api/...`, `/ws/...`, registered as literal path patterns in `main.go`) and `nginx.conf`'s `location` blocks match by path only, not by `Host` header content — so reaching the same paths via `<node-ip>:<nodePort>` or a MetalLB-assigned IP instead of the Cilium L2-announced IP requires no code change; the `Host` header value is irrelevant to how the request is routed on the server side.

### B. Feasibility Verdict

**Low risk** for all three tiers.
- **Tier 1** requires zero changes — it already exists as the default.
- **Tier 2** requires zero changes to `httproute.yaml` (already generic) and one small, additive conditional in `gateway.yaml` to avoid rendering the Cilium-only annotation for non-Cilium classes (cosmetic/hygiene, not functional — see §C).
- **Tier 3** is low-effort specifically because of the nginx-proxy fact above: the fallback does not need to reimplement `HTTPRoute`'s path-splitting logic in a `Service`/`Ingress` — it only needs to expose the existing `observer-frontend` Service under a different `type`. No new routing logic has to be invented.

### C. What Could Break

- **Tier 2 (non-Cilium Gateway API implementation)**: the unconditional `cilium.io/ipam-pool: "default"` annotation (`gateway.yaml:8-10`) will be silently ignored by a spec-compliant, non-Cilium controller (Kubernetes API conventions treat unrecognized annotations as inert) — **this does not break anything functionally**, but it is misleading operator-facing metadata (an Istio/Envoy Gateway user inspecting the rendered manifest would see a stray Cilium annotation with no effect, which could cause confusion during troubleshooting). This is a hygiene issue, not a breaking one.
- **Tier 2, unverified risk**: `spec.addresses` (`gateway.yaml:20-22`) requesting a specific static IP is honored by Cilium's controller (confirmed operationally, since this is the currently-validated path) but **whether Istio's or Envoy Gateway's Gateway API implementation honors a caller-supplied static address is not something this codebase can confirm** — if the target controller ignores or rejects `spec.addresses`, the `Gateway` may come up with a different (dynamically-assigned) address than `.Values.gateway.ip`, which would silently desync from the `hostnames` list in `httproute.yaml:12-14` (which includes that same IP as a matchable hostname) — the practical effect would be that the IP-based hostname stops matching incoming requests, while the DNS-hostname-based one (`.Values.gateway.hostname`) would still work.
- **Tier 3 (plain Service)**: if only `observer-frontend`'s Service type is changed (per the recommendation in §D) and `observer-api`'s Service (`api-server-service.yaml`, `type: ClusterIP` per prior full-text audit) is left untouched, this is **not a regression** — it is in fact the minimal-surface-area fallback, since `observer-api` never needs direct external exposure (browser clients never call it directly in production builds; only `nginx.conf`'s internal proxy does). The one thing that would break this assumption: the **dev-mode direct-to-`:8080` connections** in `CapturePage.tsx:840` and `TerminalPanel.tsx:15-17` (gated by `import.meta.env.DEV`, confirmed by prior audit) are Vite-dev-server-only code paths that do not exist in the production build served by `nginx:1.27-alpine` (`frontend/Dockerfile`), so they are irrelevant to the Tier 3 production fallback and would not need `observer-api` externally exposed.
- **NodePort specifically**: a NodePort service is reachable at `<any-node-ip>:<nodePort>`, a routing characteristic genuinely different from a single stable Cilium L2-announced IP — nothing in the Go backend or `nginx.conf` cares which node-IP:port combination the request arrives on (confirmed above: no `Host`-header-based logic anywhere), so this is a non-issue functionally, but operators should be told explicitly that the "one stable URL" property of the current Tier 1 setup is lost under NodePort (documented in §E).

### D. Recommended Implementation Approach

*(Recommendation — additive only; Tier 1's rendered manifests must remain byte-for-byte identical to today's output when `gateway.class == "cilium"`.)*

1. Introduce a new values key `gateway.class` (see §G) as the tier-selector, decoupled from `gateway.gatewayClassName` (which remains the literal `GatewayClass` name passed to the `Gateway` resource — needed even for Tier 2, since a non-Cilium cluster still needs *some* `gatewayClassName`, e.g. `istio`). Guard the whole `gateway.yaml`/`httproute.yaml` template pair behind `{{- if and .Capabilities.APIVersions.Has "gateway.networking.k8s.io/v1" (ne .Values.gateway.class "none") }}` so Tier 3 clusters without the CRDs installed never even attempt to render Gateway API objects (Helm would otherwise fail outright on a missing CRD, which is worse than silently falling back).
2. Condition the Cilium-only annotation: `{{- if eq .Values.gateway.class "cilium" }}` around the `cilium.io/ipam-pool` annotation block (`gateway.yaml:8-10`) — when `gateway.class == "cilium"` (the default), this renders exactly as today (Tier 1 preserved byte-for-byte); for any other value (Tier 2), the annotation is simply omitted rather than rendered-and-ignored, which is strictly safer and clearer for operators.
3. Add a new, separate template `helm/templates/frontend-service-fallback.yaml` (or extend `frontend-service.yaml` with a conditional `type` field — see the caveat below) guarded by `{{- if eq .Values.gateway.class "none" }}`, setting `spec.type: {{ .Values.gateway.fallback.serviceType }}` (`LoadBalancer` or `NodePort`) on the **`observer-frontend` Service only** — per §A/§C, this is sufficient because the frontend's `nginx.conf` already performs the full `/api/`,`/ws/`,`/` split internally. Do **not** also expose `observer-api`'s Service externally; that would needlessly widen the attack surface (the internal `observer-api:8080` ClusterIP remains the only address api-server is reachable at, exactly as today).
   - **Caveat, stated explicitly**: modifying `frontend-service.yaml`'s hardcoded `type: ClusterIP` (`frontend-service.yaml:17`) to be conditional is technically a change to an existing file, but it is additive in effect — when `gateway.class == "cilium"` (default) or `"generic"` (Tier 2), the value must resolve to `ClusterIP` exactly as today, so Tier 1/2 behavior is unaffected; only when `gateway.class == "none"` does the rendered type change. This preserves the instruction to not modify the *working, validated* Tier 1 output while still keeping the fallback logic in one file rather than duplicating the whole Service definition.
4. Document Tier 2 as "should work, unverified" rather than "confirmed working" (see §E) — do not claim confidence this repository cannot back with an actual test against Istio/Envoy Gateway.

### E. What Remains Cilium-Specific and Should Be Explicitly Documented As Such

*(Declaration, not a defect to fix.)*
- The **two cluster-level resources applied manually outside this chart** — `CiliumLoadBalancerIPPool` and `CiliumL2AnnouncementPolicy` — remain a hard, undocumented-in-code prerequisite for Tier 1 to produce a reachable, stable external IP on a bare-metal (non-cloud-LB) cluster. This should be stated in the README/chart docs exactly as plainly as the existing "Existing Stack Integration" table already documents Prometheus/Loki/Hubble/Longhorn as pre-existing dependencies (`README.md:98-106`, per prior audit) — the same honesty standard already applied to those four services should extend to these two Cilium CRDs.
- The static-IP request via `spec.addresses` (`gateway.yaml:20-22`) is validated only against Cilium's Gateway API implementation; its behavior under other controllers is unverified (§C) and should be labeled as such rather than assumed portable.
- Under Tier 3 (NodePort), the single stable externally-reachable URL property of the current setup (`http://192.168.18.234`, `README.md:83`) is lost — this is an inherent property of NodePort, not a bug, and should be documented as a known trade-off of the fallback tier.

---

## LAYER 2 — Internal data-plane portability

### A. Current State (fact)

**Packet capture mechanism — confirmed CNI-agnostic, exactly as the user's stated belief.**
`capture-agent/internal/capture/nsenter.go` (full file read, 600 lines) contains **no reference to Cilium, no eBPF map access, no Cilium CRD/API usage of any kind**. The capture path is:
1. `findPodPID(podUID, containerID)` (`nsenter.go:28-72`) — pure `/proc/<pid>/cgroup` string matching, no CNI awareness whatsoever.
2. `netNS := fmt.Sprintf("/proc/%d/ns/net", pid)` (`nsenter.go:99`) — the Linux kernel's network namespace file, which exists identically regardless of which CNI plugin wired that namespace's interfaces.
3. The exact command run is `nsenter --net=<netNS> -- tcpdump -i <iface> -w - --immediate-mode -s 0` (`nsenter.go:108-127`) — `tcpdump` opens a raw socket on the named interface *inside* the joined namespace via the standard Linux packet-capture syscalls (`AF_PACKET`), which is identical machinery whether that interface's traffic is forwarded by Cilium's eBPF datapath, Flannel's VXLAN, Calico's iptables/eBPF, or anything else. **The belief stated in the prompt is confirmed correct**: this mechanism operates below and independent of any CNI's control plane or API.

**Interface discovery — depends on Multus's annotation format, not on Cilium specifically.**
`capture-agent/internal/discovery/pods.go:111-145` (`parseInterfaces`) reads the annotation key literally `k8s.v1.cni.cncf.io/network-status` (`pods.go:112`) — this is the **Multus CNI meta-plugin's standard annotation**, written by Multus regardless of which underlying CNI plugin(s) it delegates to (Cilium, Flannel, or others can all sit behind Multus as the primary or a secondary network). If the annotation is absent, `parseInterfaces` returns `[]string{"eth0"}` (`pods.go:114,142-144`) — a graceful, non-erroring default, not a crash. So: this code path is agnostic to which CNI is in front, but it **does implicitly assume Multus is installed and annotating pods** if multiple interfaces beyond the default `eth0` are to be discovered; under a plain Flannel-only setup with no Multus, every pod would report only `["eth0"]`, which is a pre-existing behavior (not a Cilium-specific dependency) and would apply equally today under Cilium-without-Multus.

**Prometheus/Hubble metrics — already gracefully degrades, confirmed by reading both the query function and its caller.**
- `InterfaceDropRate(ctx, pod)` (`api-server/internal/prometheus/client.go:180-201`): the function's own doc comment states "Returns 0.0 when Hubble metrics are unavailable" (`client.go:184`); implementation discards the query error (`drop, _ := c.queryScalar(ctx, dropQ)`, `client.go:196`) and clamps negative results to 0 (`client.go:197-199`) — so even if called against a Prometheus instance with zero `hubble_drop_total`/`hubble_flows_processed_total` series (i.e., no Hubble/Cilium present), it returns `0`, not an error.
- Its caller, `GetInterfaceMetrics` (`api-server/internal/handlers/metrics.go:79-112`), **already gates the call entirely**: `isCilium := primaryCNI == "Cilium" && iface == "eth0"` (`metrics.go:93`), and `InterfaceDropRate` is only invoked `if isCilium` (`metrics.go:96-98`) — on a non-Cilium cluster, the Hubble query is never even issued; the endpoint returns `{dropRate: 0, isCilium: false}` (`metrics.go:106-111`) unconditionally in that case.

**Frontend `DetectPrimaryCNI`/`isCilium` handling — already degrades gracefully, confirmed by reading the actual rendering logic.**
- Backend: `DetectPrimaryCNI` (`api-server/internal/k8s/topology.go:635-681`) returns the literal string `"CNI"` (`topology.go:646,649`) if no known CNI is matched among `kube-system` pods — a defined, non-error fallback value, not `nil`/error. `detectSecondaryCNI` (`topology.go:691-737`) mirrors this with `"Secondary CNI"` (`topology.go:702,705`).
- Frontend: the drop-rate UI row is conditionally rendered on the `isCilium` flag in **two places**, confirmed by direct grep of `frontend/src`: `{m.isCilium && (...)}` in `SidePanel.tsx:331`, and `{metrics?.isCilium && (...)}` in `TopologyCanvas.tsx:671-672` — on a non-Cilium cluster, this row is **simply absent from the DOM**, not rendered-with-an-error. The generic CNI label (`getCNILabel`, `TopologyCanvas.tsx:163-165`) and the `graph.primaryCNI ?? 'CNI'` fallback (`TopologyCanvas.tsx:1054`) both degrade to a plain, non-branded string rather than failing.

### B. Feasibility Verdict

**Low risk — because there is effectively nothing left to fix.** Every one of the four data flows named in the prompt (packet capture, interface discovery, Hubble/Prometheus metrics, and the frontend's CNI-detection UI) already either (a) has no Cilium dependency at all (packet capture, interface discovery), or (b) already implements the graceful-degradation behavior the prompt asks whether it needs (Hubble metrics gating, frontend conditional rendering). This is a **verification finding, not an implementation gap** — the work here is documentation, not code.

### C. What Could Break

Nothing new breaks by exposing/documenting this, since no behavior changes are being proposed for Layer 2. The only latent risk identified:
- The interface-discovery fallback to `["eth0"]` (`pods.go:114,142-144`) means that on a cluster with **no Multus** (regardless of CNI), only the pod's primary interface is ever discoverable/capturable — this is a real, pre-existing functional limitation of the tool's *feature scope* (multi-interface capture requires Multus), not a portability defect introduced by any CNI choice. It should be documented as a prerequisite the same way Prometheus/Loki/Hubble are already documented in `README.md:98-106`.

### D. Recommended Implementation Approach

*(Recommendation.)* No code changes are recommended for Layer 2. The single actionable recommendation is **documentation**: add a short "CNI compatibility" note (README or a new `docs/` file) stating explicitly, with the same citations used above, that (1) packet capture is CNI-agnostic by design, (2) interface discovery requires Multus (any CNI) for multi-interface pods and gracefully defaults to `eth0` otherwise, and (3) Hubble-derived drop-rate metrics are Cilium-specific and already no-op cleanly on other CNIs. This turns a currently-implicit set of correct behaviors into an explicit, citable claim reviewers and future contributors can trust without re-deriving it from the source.

### E. What Remains Cilium-Specific and Should Be Explicitly Documented As Such

*(Declaration, not a defect to fix.)*
- **Only the Hubble drop-rate metric is Cilium-specific** in the entire internal data plane — and it is already inert (not broken, not erroring) on non-Cilium clusters, both server-side (`metrics.go:93,96-98`) and client-side (`SidePanel.tsx:331`, `TopologyCanvas.tsx:671-672`). This should be documented as "Cilium-enhanced, not Cilium-required" — the tool's core packet-capture and topology functionality has zero dependency on it.
- Multi-interface discovery's dependency on Multus (not Cilium) should be documented as a **separate, CNI-independent prerequisite** — conflating it with "Cilium dependency" in future documentation would be a factual error, since Multus is commonly paired with Flannel, Calico, or any other primary CNI just as often as with Cilium.

---

## F. Consolidated Verdict

| Component | CNI-agnostic today? | Gateway-agnostic today? | Action needed | Effort |
|---|---|---|---|---|
| Packet capture pipeline (`nsenter`/`tcpdump`/`tshark`, gRPC to api-server, WS relay) | **Yes** — confirmed, no Cilium/CNI code path anywhere (`nsenter.go` full read) | N/A (not exposure-related) | None — document as CNI-agnostic | None |
| Interface discovery (`discovery/pods.go`) | **Yes for CNI**, but implicitly requires **Multus** for >1 interface; degrades to `eth0` gracefully otherwise | N/A | Document Multus as a separate prerequisite | None (docs only) |
| Prometheus/Hubble metrics (`InterfaceDropRate`, `GetInterfaceMetrics`) | **Yes** — Hubble-specific query is gated (`metrics.go:93,96-98`) and self-degrades to 0 (`client.go:184,196-199`) | N/A | Document as "Cilium-enhanced, not required" | None (docs only) |
| Frontend CNI-detection UI (`isCilium`, `primaryCNI`) | **Yes** — conditional rendering already hides Cilium-only UI (`SidePanel.tsx:331`, `TopologyCanvas.tsx:671-672`) and falls back to generic labels (`topology.go:646,649,702,705`) | N/A | None | None |
| External exposure — `Gateway`/`HTTPRoute` (Tier 1/2) | N/A | **`HTTPRoute` yes; `Gateway` no** — one unconditional Cilium annotation + an unverified-elsewhere static-address request | Gate the annotation behind `gateway.class`; document static-address support as Cilium-verified-only | Small (1 conditional block) |
| External exposure — plain Service fallback (Tier 3) | N/A | **Not yet implemented**, but low-effort due to `nginx.conf` already handling path-splitting internally | Add conditional `type` on `observer-frontend` Service only | Small (1 new/modified template) |

## G. Suggested `values.yaml` Additions

*(Recommendation — additive keys only; no existing key renamed or removed.)*

```yaml
gateway:
  ip: 192.168.18.234              # unchanged
  gatewayClassName: cilium        # unchanged — literal GatewayClass name passed through as-is
  hostname: coach5g.local     # unchanged

  # NEW — selects which exposure tier to render. Does not replace gatewayClassName:
  # gatewayClassName is still needed for "cilium" and "generic" (it's the literal
  # value handed to the Gateway API), while `class` controls chart branching logic.
  #   cilium  → Tier 1 (default; today's exact behavior, byte-for-byte unchanged)
  #   generic → Tier 2 (render Gateway/HTTPRoute, omit Cilium-only annotation)
  #   none    → Tier 3 (skip Gateway API entirely, fall back to a plain Service)
  class: cilium

  # NEW — only consulted when gateway.class == "none"
  fallback:
    serviceType: LoadBalancer     # or "NodePort"
    # nodePort: 30080             # optional, only meaningful with serviceType: NodePort
```

No existing key (`gateway.ip`, `gateway.gatewayClassName`, `gateway.hostname`, or anything under `targets`, `frontend`, `apiServer`, `captureAgent`, `loki`, `prometheus`, `hubble`, `terminal`, `clusterInfo`) is redesigned, renamed, or removed by this proposal.
