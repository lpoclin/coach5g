# Pre-Implementation Risk Assessment — Project Rename (5g-observer → coach5g)

Diagnostic only. No file has been renamed or had its naming content changed as part of this assessment (the one exception, `helm/templates/gateway.yaml`'s `cilium.io/ipam-pool` annotation, was already made configurable in a prior, separate, already-completed task and is not a naming-scheme match — it is excluded from this inventory). All claims are backed by direct reads and greps of the current repository state, cited by file and line.

Casing convention assumed for this assessment, per the request: `coach5g` for lowercase-hyphenated identifiers (Kubernetes names, Go/npm package identifiers, Docker image names), `COACH5G` for all-caps display strings (matching the current `5G-OBSERVER` nav-brand convention), `Coach5G` for PascalCase prose/title contexts (matching the current `5G Observer` title-case convention). Where the current codebase uses the bare word `observer` (not the full `5g-observer` string) as a short-form identifier, this is flagged explicitly as a naming decision the user must confirm before Tier B execution — see the note at the end of Step 2.

---

## STEP 1 — Full inventory

Every match found, by file. Grep patterns used: `5g-observer` (case-insensitive), `5gobserver`/`5g_observer`/`5gObserver` (no matches, confirmed absent), `observer-api`, `observer-frontend`, `5gobs`, `name:\s*observer\b`/`serviceAccountName:\s*observer\b`, plus full-file reads of every Helm template and the affected Go/TypeScript files to confirm exact line numbers and surrounding structure. `.env*` files: none exist in the repository (confirmed via glob).

### Documentation and metadata

| File | Line | Content |
|---|---|---|
| `README.md` | 1 | `# 5g-observer` |
| `README.md` | 40 | `` `ghcr.io/lpoclin/5g-observer-frontend` `` |
| `README.md` | 41 | `` `ghcr.io/lpoclin/5g-observer-api` `` |
| `README.md` | 42 | `` `ghcr.io/lpoclin/5g-observer-capture` `` |
| `README.md` | 78 | `helm install 5g-observer ./helm` |
| `docs/TECHNICAL_AUDIT.md` | 1, 3, 48, 188 | Title and prose referencing `5g-observer` (self-authored diagnostic doc) |
| `docs/RISK_ASSESSMENT_ADDITIONS.md` | 1 | Title referencing `5g-observer` |
| `docs/CNI_GATEWAY_PORTABILITY_ASSESSMENT.md` | 17, 26, 41, 47, 56, 120, 130 | Prose and code citations referencing `5g-observer`, `observer-api`, `observer-frontend` |
| `docs/RENAME_ASSESSMENT.md` | this file | Self-referential, not counted |
| `docs/deployment-guide/01-requirements.md` | 3 | Prose: "what 5g-observer needs to run" |
| `docs/deployment-guide/02-installation-cilium.md` | 106 | `helm install 5g-observer ./helm` |
| `docs/deployment-guide/03-installation-generic-gateway.md` | 39 | `helm install 5g-observer ./helm` |
| `docs/deployment-guide/04-installation-no-gateway-api.md` | 16, 26, 35, 38, 42 | Example commands and prose referencing `5g-observer`, `observer-api`, `observer-frontend` |
| `docs/deployment-guide/05-troubleshooting-portability.md` | 50, 56 | `kubectl get svc observer-api observer-frontend` |

All of the above are prose, code-block examples inside documentation, or my own previously-authored diagnostic files. None of them execute or affect a running deployment.

### Helm chart

| File | Line | Content | Notes |
|---|---|---|---|
| `helm/Chart.yaml` | 2 | `name: 5g-observer` | Chart identity metadata |
| `helm/Chart.yaml` | 13 | `home: https://github.com/lpoclin/5g-observer` | External URL, depends on Tier D |
| `helm/Chart.yaml` | 15 | `- https://github.com/lpoclin/5g-observer` (sources) | External URL, depends on Tier D |
| `helm/values.yaml` | 9 | `hostname: 5g-observer.local` | Gateway hostname default |
| `helm/values.yaml` | 16 | `image: ghcr.io/lpoclin/5g-observer-frontend:latest` | Docker image reference |
| `helm/values.yaml` | 29 | `image: ghcr.io/lpoclin/5g-observer-api:latest` | Docker image reference |
| `helm/values.yaml` | 44 | `image: ghcr.io/lpoclin/5g-observer-capture:latest` | Docker image reference |
| `helm/templates/_helpers.tpl` | 4 | `{{- define "5g-observer.name" -}}` | Named template, **confirmed unused** (see Step 2) |
| `helm/templates/_helpers.tpl` | 11 | `{{- define "5g-observer.chart" -}}` | Named template, **confirmed unused** |
| `helm/templates/_helpers.tpl` | 18 | `{{- define "5g-observer.labels" -}}` | Named template, **confirmed unused** |
| `helm/templates/_helpers.tpl` | 19 | `{{ include "5g-observer.chart" . }}` | Internal self-reference within the same dead block |
| `helm/templates/_helpers.tpl` | 20 | `{{ include "5g-observer.name" . }}` | Internal self-reference within the same dead block |
| `helm/templates/api-server-service.yaml` | 4 | `name: observer-api` | **Kubernetes Service DNS name** |
| `helm/templates/api-server-service.yaml` | 7 | `app: 5g-observer-api` (metadata.labels) | Paired with selector below |
| `helm/templates/api-server-service.yaml` | 8 | `app.kubernetes.io/name: 5g-observer` | Descriptive label, not a selector |
| `helm/templates/api-server-service.yaml` | 10-11 | `selector: {app: 5g-observer-api}` | **Selector, must match Deployment** |
| `helm/templates/api-server-deployment.yaml` | 4 | `name: observer-api` | Deployment's own name (cosmetic, not selector-relevant) |
| `helm/templates/api-server-deployment.yaml` | 7 | `app: 5g-observer-api` (metadata.labels) | |
| `helm/templates/api-server-deployment.yaml` | 8 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/api-server-deployment.yaml` | 13-14 | `selector.matchLabels: {app: 5g-observer-api}` | **Selector, must match pod template + Service** |
| `helm/templates/api-server-deployment.yaml` | 18 | `app: 5g-observer-api` (pod template label) | **Must match selector above** |
| `helm/templates/api-server-deployment.yaml` | 19 | `app.kubernetes.io/name: 5g-observer` (pod template) | Descriptive label |
| `helm/templates/api-server-deployment.yaml` | 21 | `serviceAccountName: observer` | **Must match ServiceAccount name** |
| `helm/templates/frontend-service.yaml` | 4 | `name: observer-frontend` | **Kubernetes Service DNS name** |
| `helm/templates/frontend-service.yaml` | 7 | `app: 5g-observer-frontend` (metadata.labels) | |
| `helm/templates/frontend-service.yaml` | 8 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/frontend-service.yaml` | 10-11 | `selector: {app: 5g-observer-frontend}` | **Selector, must match Deployment** |
| `helm/templates/frontend-deployment.yaml` | 4 | `name: observer-frontend` | Deployment's own name (cosmetic) |
| `helm/templates/frontend-deployment.yaml` | 7 | `app: 5g-observer-frontend` (metadata.labels) | |
| `helm/templates/frontend-deployment.yaml` | 8 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/frontend-deployment.yaml` | 13-14 | `selector.matchLabels: {app: 5g-observer-frontend}` | **Selector, must match pod template + Service** |
| `helm/templates/frontend-deployment.yaml` | 18 | `app: 5g-observer-frontend` (pod template label) | **Must match selector above** |
| `helm/templates/frontend-deployment.yaml` | 19 | `app.kubernetes.io/name: 5g-observer` (pod template) | Descriptive label |
| `helm/templates/frontend-deployment.yaml` | 21 | `serviceAccountName: observer` | **Must match ServiceAccount name** |
| `helm/templates/capture-agent-daemonset.yaml` | 5 | `name: observer-capture` | DaemonSet's own name (cosmetic — no Service targets this) |
| `helm/templates/capture-agent-daemonset.yaml` | 8 | `app: 5g-observer-capture` (metadata.labels) | |
| `helm/templates/capture-agent-daemonset.yaml` | 9 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/capture-agent-daemonset.yaml` | 13-14 | `selector.matchLabels: {app: 5g-observer-capture}` | **Selector, must match pod template (same file, no Service)** |
| `helm/templates/capture-agent-daemonset.yaml` | 18 | `app: 5g-observer-capture` (pod template label) | **Must match selector above** |
| `helm/templates/capture-agent-daemonset.yaml` | 19 | `app.kubernetes.io/name: 5g-observer` (pod template) | Descriptive label |
| `helm/templates/capture-agent-daemonset.yaml` | 21 | `serviceAccountName: observer` | **Must match ServiceAccount name** |
| `helm/templates/capture-agent-daemonset.yaml` | 46 | `value: "observer-api:9999"` (env var `API_SERVER_ADDR`) | **Must match api-server Service DNS name** |
| `helm/templates/capture-agent-daemonset.yaml` | 86 | `claimName: observer-pcap` | **Must match PVC name** (only rendered when persistence is enabled) |
| `helm/templates/gateway.yaml` | 4 | `name: observer` | **Gateway resource name** |
| `helm/templates/gateway.yaml` | 7 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/httproute.yaml` | 4 | `name: observer` | HTTPRoute's own name (cosmetic — nothing else references it by name) |
| `helm/templates/httproute.yaml` | 7 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/httproute.yaml` | 9-10 | `parentRefs: [{name: observer}]` | **Must match Gateway name** |
| `helm/templates/httproute.yaml` | 25 | `backendRefs: [{name: observer-api}]` | **Must match api-server Service name** |
| `helm/templates/httproute.yaml` | 33 | `backendRefs: [{name: observer-frontend}]` | **Must match frontend Service name** |
| `helm/templates/pvc.yaml` | 5 | `name: observer-pcap` | **PVC name** |
| `helm/templates/pvc.yaml` | 8 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/rbac.yaml` | 4 | `name: observer` (ClusterRole) | **Must match ClusterRoleBinding's roleRef** |
| `helm/templates/rbac.yaml` | 6 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/rbac.yaml` | 32 | `name: observer` (ClusterRoleBinding) | Binding's own name (cosmetic) |
| `helm/templates/rbac.yaml` | 34 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |
| `helm/templates/rbac.yaml` | 38 | `roleRef.name: observer` | **Must match ClusterRole name (line 4)** |
| `helm/templates/rbac.yaml` | 41 | `subjects[0].name: observer` | **Must match ServiceAccount name** |
| `helm/templates/serviceaccount.yaml` | 4 | `name: observer` | **ServiceAccount name** |
| `helm/templates/serviceaccount.yaml` | 7 | `app.kubernetes.io/name: 5g-observer` | Descriptive label |

### Go source

| File | Line | Content |
|---|---|---|
| `api-server/go.mod` | 1 | `module github.com/lpoclin/5g-observer/api-server` |
| `capture-agent/go.mod` | 1 | `module github.com/lpoclin/5g-observer/capture-agent` |
| `api-server/proto/capture.proto` | 5 | `option go_package = "github.com/lpoclin/5g-observer/api-server/internal/pb;pb";` |
| `api-server/internal/pb/capture.pb.go` | 547 | Embedded raw FileDescriptorProto bytes containing the literal string `github.com/lpoclin/5g-observer/api-server/internal/pb;pb` — **generated file** |
| `capture-agent/internal/pb/capture.pb.go` | 547 | Same embedded descriptor string — **generated file**, capture-agent's own copy |
| `api-server/cmd/server/main.go` | 16, 17, 18, 19, 20 | Five import statements: `github.com/lpoclin/5g-observer/api-server/internal/{capture,handlers,k8s,loki,prometheus}` |
| `api-server/cmd/server/main.go` | 138 | Log message string: `"5g-observer api-server starting"` |
| `api-server/internal/capture/grpc_server.go` | 17 | Import: `github.com/lpoclin/5g-observer/api-server/internal/pb` |
| `api-server/internal/handlers/topology.go` | 16 | Import: `k8stopo "github.com/lpoclin/5g-observer/api-server/internal/k8s"` |
| `api-server/internal/handlers/packets.go` | 14 | Import: `github.com/lpoclin/5g-observer/api-server/internal/capture` |
| `api-server/internal/handlers/metrics.go` | 11, 12, 13 | Three imports: `internal/{capture,k8s,prometheus}` |
| `api-server/internal/handlers/logs.go` | 12 | Import: `github.com/lpoclin/5g-observer/api-server/internal/loki` |
| `api-server/internal/handlers/infrastructure.go` | 15 | Import: `github.com/lpoclin/5g-observer/api-server/internal/prometheus` |
| `api-server/internal/handlers/decode.go` | 19 | Import: `github.com/lpoclin/5g-observer/api-server/internal/capture` |
| `api-server/internal/handlers/config.go` | 7 | Import: `github.com/lpoclin/5g-observer/api-server/internal/capture` |
| `api-server/internal/handlers/decode.go` | 108 | `fmt.Sprintf("/tmp/5gobs-decode-%d.pcap", ...)` — unrelated derived abbreviation, temp file only |
| `capture-agent/cmd/agent/main.go` | 13, 14, 15, 16 | Four imports: `internal/{capture,control,discovery,grpc}` |
| `capture-agent/cmd/agent/main.go` | 23 | `envOr("API_SERVER_ADDR", "observer-api:9999")` — Go default value, overridden at runtime by the Helm-injected env var (`capture-agent-daemonset.yaml:46`) but must still match if anyone runs the binary outside the chart |
| `capture-agent/internal/control/server.go` | 10, 11 | Two imports: `internal/{capture,pb}` |
| `capture-agent/internal/capture/manager.go` | 14, 15, 16 | Three imports: `internal/{discovery,grpc,pb}` |
| `capture-agent/internal/grpc/client.go` | 15 | Import: `github.com/lpoclin/5g-observer/capture-agent/internal/pb` |

Total Go import-statement lines referencing the module path: 25 (10 in capture-agent, 15 in api-server), plus 1 source-of-truth `go_package` option and 2 generated-file copies of the same embedded string.

### CI/CD

| File | Line | Content |
|---|---|---|
| `.github/workflows/build.yml` | 12 | `FRONTEND_IMAGE: ghcr.io/lpoclin/5g-observer-frontend` |
| `.github/workflows/build.yml` | 13 | `API_IMAGE: ghcr.io/lpoclin/5g-observer-api` |
| `.github/workflows/build.yml` | 14 | `CAPTURE_IMAGE: ghcr.io/lpoclin/5g-observer-capture` |

### Frontend (source)

| File | Line | Content |
|---|---|---|
| `frontend/index.html` | 7 | `<title>5G Observer</title>` |
| `frontend/package.json` | 2 | `"name": "5g-observer-frontend"` |
| `frontend/package-lock.json` | 2, 8 | `"name": "5g-observer-frontend"` (top-level and `packages[""].name`, npm lockfile v3 format) |
| `frontend/src/components/common/Layout.tsx` | 76 | `5G-OBSERVER` (nav brand text, JSX) |
| `frontend/src/pages/TopologyPage.tsx` | 27, 48, 49, 54, 77, 89, 109 | `'5g-observer-sidepanel-width'`, `'5g-observer-terminal-height'` (localStorage key strings, 7 occurrences) |
| `frontend/src/components/Topology/TopologyCanvas.tsx` | 721 | `` `5g-observer-positions-${namespace}` `` (localStorage key, template string) |

### Frontend (dependency/build artifacts — not source)

| File | Line | Content |
|---|---|---|
| `frontend/node_modules/.package-lock.json` | 2 | `"name": "5g-observer-frontend"` — npm-generated dependency-tree snapshot, not hand-edited, regenerated by `npm install` |
| `frontend/dist/assets/index-ILJ3BpZy.js` | 26, 76 | Minified production bundle containing the same strings as the source files above (title, localStorage keys, import-derived identifiers) — regenerated automatically by `npm run build`, never hand-edited |

---

## STEP 2 — Categorization

### TIER A — Cosmetic only

Every "Documentation and metadata" row above; every "Frontend (dependency/build artifacts)" row (regenerate, don't edit); the `_helpers.tpl` named templates (confirmed dead code, see below); every `app.kubernetes.io/name: 5g-observer` descriptive label (confirmed never used as a `selector`/`matchLabels` anywhere in this chart — only the separate `app:` key is); `helm/Chart.yaml`'s `home`/`sources` URLs (metadata only, not consumed by any template); `helm/values.yaml`'s `hostname: 5g-observer.local` (already a single-source-of-truth value, flows into `httproute.yaml`'s `hostnames` list via templating, not hardcoded a second time anywhere); `api-server/cmd/server/main.go:138`'s log message string; `decode.go:108`'s `/tmp/5gobs-*` temp-file prefix (created and deleted within the same function call, zero external coupling); `frontend/index.html`'s `<title>`; `Layout.tsx:76`'s nav brand text; `frontend/package.json`/`package-lock.json`'s `"name"` field (not consumed by any build step or import, single-pair coordination between the two files only); the three localStorage key strings in `TopologyPage.tsx` and `TopologyCanvas.tsx`.

**One nuance worth flagging inside Tier A**: the localStorage keys are functional in the narrow sense that they are literal string keys read/written to each end user's browser storage. Renaming them causes no service-communication break of any kind (confirmed: nothing else in the codebase reads these keys), but it does mean any user who previously saved a custom side-panel width, terminal height, or node layout will silently lose that saved preference exactly once, falling back to defaults. This is a one-time, per-browser cosmetic UX reset, not a functional regression.

**Dead-code finding, confirmed by grep**: `helm/templates/_helpers.tpl`'s three named templates (`5g-observer.name`, `5g-observer.chart`, `5g-observer.labels`) are never `include`d by any other template file in this chart (confirmed: `grep -r 'include "5g-observer'` across `helm/` returns only the two internal self-references inside `_helpers.tpl` itself, lines 19-20). Every other template hardcodes `app.kubernetes.io/name: 5g-observer` as a literal string instead of calling this helper. Renaming or deleting these three named templates has zero effect on any rendered manifest today. `.Chart.Name` and `.Release.Name` (`_helpers.tpl:5,12,21`) are referenced only inside this same dead block — so `helm/Chart.yaml`'s `name:` field is confirmed to have no live templating dependency anywhere in the chart, reinforcing its Tier A classification.

### TIER B — Coordinated functional identifiers

Three independent coordination groups, detailed fully in Step 3:

1. **Pod-selector labels** (`app: 5g-observer-api`, `app: 5g-observer-frontend`, `app: 5g-observer-capture`) — each must stay identical across a Service's `spec.selector` and the matching Deployment/DaemonSet's `spec.selector.matchLabels` + pod template `metadata.labels`, within its own trio of files (capture-agent has no Service, so its trio collapses to a single-file self-consistency requirement).
2. **Service DNS names** (`observer-api`, `observer-frontend`) — referenced by `nginx.conf`, `capture-agent`'s Go default and Helm-injected env var, and `httproute.yaml`'s `backendRefs`.
3. **RBAC identity chain** (`observer` as ServiceAccount name, referenced by three `serviceAccountName:` fields and by `rbac.yaml`'s ClusterRoleBinding subject) plus the **Gateway/HTTPRoute name pairing** (`observer` as Gateway name, referenced by `httproute.yaml`'s `parentRefs`) plus the **PVC name pairing** (`observer-pcap`, referenced by `capture-agent-daemonset.yaml`'s `claimName`).

### TIER C — Build/CI/publishing identifiers requiring external coordination

**Docker image names** (`ghcr.io/lpoclin/5g-observer-{frontend,api,capture}`, referenced in `.github/workflows/build.yml:12-14`, `helm/values.yaml:16,29,44`, `README.md:40-42`). Renaming these strings in this repository is sufficient by itself to start publishing under the new name on the next CI run — GHCR creates a new package automatically the first time an image is pushed under a new name; **it does not require deleting or migrating the old package**. The old `5g-observer-{frontend,api,capture}` packages will continue to exist under `ghcr.io/lpoclin/` as separate, now-stale packages unless the repository owner manually archives or deletes them via GitHub's package settings UI — an out-of-repo, GitHub-account-level action, optional, not a blocker for the new name to work. Confirmed independent of Tier D: GHCR package names are strings chosen at push time, not derived from the source GitHub repository's name, so this can be renamed whether or not the GitHub repo itself (Tier D) is ever renamed.

**Go module paths** (`github.com/lpoclin/5g-observer/api-server`, `github.com/lpoclin/5g-observer/capture-agent`, `api-server/go.mod:1`, `capture-agent/go.mod:1`). Confirmed to exist. Renaming either module path requires updating every one of the 25 internal import-statement lines listed in Step 1, plus the `go_package` option in `api-server/proto/capture.proto:5`, plus regenerating (via `protoc`, not hand-editing) both generated file pairs (`api-server/internal/pb/{capture.pb.go,capture_grpc.pb.go}` and `capture-agent/internal/pb/{capture.pb.go,capture_grpc.pb.go}`), since the old path is embedded as a raw descriptor byte string inside the generated `.pb.go` files (`capture.pb.go:547` in both copies), not simply written as importable Go source. **Clarification on the "external coordination" framing**: this module path is not fetched from the network for the module's own build (Go builds this repository's binaries directly from the checked-out source tree via `go build ./cmd/...`, it does not `go get` its own main module from GitHub), so renaming the string does not require the GitHub repository to already be renamed for `go build`/CI to keep working. The real cost here is blast radius (26+ files touched, 2 files that must be regenerated rather than edited by hand), not an external blocking dependency. It only becomes truly "externally coordinated" if this module is ever imported as a library by code outside this repository, which nothing in the current codebase or CI indicates.

### TIER D — Out of scope for this session

The GitHub repository name itself (`lpoclin/5g-observer` → whatever the new repository name would be). The local folder name on disk (`c:\Users\Usuario\Documents\5g-observer`). Any git remote URL — moot in this specific working copy, since `git status` confirms this directory is not currently a git repository at all, so there is no remote URL to update here regardless.

### Open naming-decision flag, not yet resolved by this assessment

Every Tier B identifier that uses the bare word `observer` (not the compound `5g-observer`) is *derived from* `5g-observer` by dropping the `5g-` prefix: the ServiceAccount, ClusterRole, ClusterRoleBinding, Gateway, and the `observer-api`/`observer-frontend`/`observer-capture`/`observer-pcap` short-form resource names. The request says to rename "5g-observer" and derived variants to "coach5g." Whether these short-form `observer`-only identifiers should become `coach5g` (e.g., `coach5g-api`, `coach5g-frontend`) or should keep a similarly-shortened but distinct word is a naming decision, not a technical one, and should be confirmed before Tier B execution begins. This assessment treats them as in-scope, derived variants, consistent with "any other clearly-derived variant" in the task, but flags this explicitly rather than assuming the answer.

---

## STEP 3 — Tier B coordination trace

### Group 1: Pod-selector labels (three independent trios)

**api-server**: `app: 5g-observer-api` must be changed identically, in the same commit, in:
- `helm/templates/api-server-service.yaml:7` (Service label) and `:10-11` (`spec.selector`, the value kube-proxy actually matches against)
- `helm/templates/api-server-deployment.yaml:7` (Deployment label), `:13-14` (`spec.selector.matchLabels`), `:18` (pod template label, must equal `:13-14` or the Deployment itself is rejected by the API server as invalid)

If the Service's selector (`:10-11`) is changed without changing the Deployment's pod template label (`:18`) to match, `observer-api` Service will have zero endpoints. Every internal caller (`nginx.conf`, capture-agent's control-channel dial-back via the registered pod IP, the HTTPRoute) would see connection failures even though the pods themselves are Running and Ready.

**frontend**: identical pattern with `app: 5g-observer-frontend` across `helm/templates/frontend-service.yaml:7,10-11` and `helm/templates/frontend-deployment.yaml:7,13-14,18`.

**capture-agent**: `app: 5g-observer-capture` across `helm/templates/capture-agent-daemonset.yaml:8,13-14,18` only — no Service exists for this workload (confirmed: no `capture-agent-service.yaml` file in the chart; api-server dials capture-agent pods directly by pod IP, not via a Service DNS name), so this trio collapses to a single-file self-consistency requirement between `spec.selector.matchLabels` and the pod template label, both in the same file.

### Group 2: Service DNS names

`observer-api` (`helm/templates/api-server-service.yaml:4`) must be changed simultaneously with every place that dials it by that literal string:
- `frontend/nginx.conf:15,23` (`proxy_pass http://observer-api:8080`)
- `capture-agent/cmd/agent/main.go:23` (`envOr("API_SERVER_ADDR", "observer-api:9999")`, the compiled-in default)
- `helm/templates/capture-agent-daemonset.yaml:46` (`value: "observer-api:9999"`, the Helm-injected env var that overrides the Go default at runtime — this is the one that actually matters for the Helm-deployed path, but the Go default should stay consistent for anyone running the binary outside the chart)
- `helm/templates/httproute.yaml:25` (`backendRefs: [{name: observer-api}]`)

`observer-frontend` (`helm/templates/frontend-service.yaml:4`) must be changed simultaneously with:
- `helm/templates/httproute.yaml:33` (`backendRefs: [{name: observer-frontend}]`)

Missing any one of these means either a broken internal proxy (nginx returns 502/504), a broken control channel (capture-agent's tshark enable/disable RPCs to the wrong or nonexistent address), or a broken external route (HTTPRoute references a Service name that no longer exists, and Gateway API will report `ResolvedRefs: False`).

### Group 3: RBAC identity chain + Gateway/HTTPRoute pairing + PVC pairing

**RBAC**: `observer` as a ServiceAccount name (`helm/templates/serviceaccount.yaml:4`) must be changed simultaneously with:
- `helm/templates/api-server-deployment.yaml:21` (`serviceAccountName: observer`)
- `helm/templates/frontend-deployment.yaml:21` (`serviceAccountName: observer`)
- `helm/templates/capture-agent-daemonset.yaml:21` (`serviceAccountName: observer`)
- `helm/templates/rbac.yaml:41` (`subjects[0].name: observer`, inside the ClusterRoleBinding)

If the ServiceAccount is renamed but any workload's `serviceAccountName:` or the ClusterRoleBinding's subject is left pointing at the old name, that workload either fails to schedule (referencing a nonexistent ServiceAccount) or runs under the `default` ServiceAccount with zero Kubernetes API permissions — every Kubernetes API call from that pod (topology discovery, node/event/PVC listing, pod discovery for packet capture) would fail with 403 Forbidden.

Separately, `helm/templates/rbac.yaml:4` (ClusterRole name) and `:38` (`roleRef.name`) must match each other, but this pairing is entirely self-contained within `rbac.yaml`, so it carries lower coordination risk than the ServiceAccount chain above.

**Gateway/HTTPRoute**: `observer` as the Gateway's own name (`helm/templates/gateway.yaml:4`) must match `helm/templates/httproute.yaml:9-10` (`parentRefs: [{name: observer}]`). Missing this means the HTTPRoute never attaches to the Gateway (`Accepted: False` in its status), and no traffic reaches either backend Service regardless of whether Group 1/2 renames were done correctly.

**PVC**: `observer-pcap` (`helm/templates/pvc.yaml:5`) must match `helm/templates/capture-agent-daemonset.yaml:86` (`claimName: observer-pcap`). This pairing only matters when `captureAgent.persistence.enabled` is `true` (disabled by default per `helm/values.yaml:45`), so its real-world blast radius today is smaller than the other two groups, but it is still a hard two-file coordination requirement whenever that feature is turned on.

---

## STEP 4 — Risk-ordered rename plan

1. **Tier A first, any time, incrementally.** Zero functional risk. Can be done file-by-file, committed independently, without touching Tier B/C at all. Recommended to do this first simply because it's the bulk of the matches and clears the search results down to only the identifiers that actually require care.

2. **Tier B as one single atomic change, not incremental.** All three coordination groups in Step 3 must land in the same commit. Partial application (for example, renaming Service names but not the Deployment selectors, or renaming the ServiceAccount but not all three `serviceAccountName:` references) produces a cluster that fails in ways that are not immediately obvious from `kubectl get pods` (pods show `Running`, but Services have no endpoints, or RBAC calls silently 403). Recommended approach: make every Tier B edit across every file in Step 3 in one working session, then validate with `helm template ./helm | kubectl apply --dry-run=server -f -` (or an equivalent local render-and-validate step) before applying to a real cluster, precisely because this class of failure does not show up as a Helm template error, only as runtime misbehavior.

3. **Tier C after Tier B is validated, and treated as two independent sub-decisions.** The Docker image rename (workflow + values.yaml) can go out in the same commit as Tier B with no additional risk, since it only takes effect on the next CI build and next `helm upgrade` — there is no cutover moment where old and new image names must coexist correctly, since the previous image tags remain pullable at their old name indefinitely. The Go module path rename is higher-effort (26+ files, 2 files requiring `protoc` regeneration rather than hand-editing) and has no coupling to when Tier B lands. It can reasonably be deferred to a follow-up change if the team wants to keep the first rename PR smaller, since an inconsistent module-path string does not break any build or CI step on its own.

4. **Tier D is entirely manual, outside this coding session, and has no strict ordering dependency on 1-3.** The GitHub repository rename and local folder rename can happen before, during, or after Tiers A-C, since nothing in Tiers A-C requires Tier D to be done first for the application itself to build or run correctly (confirmed in Tier C's Go module discussion: builds do not depend on the module path resolving to a real, renamed remote repository). The only consequence of sequencing Tier D last is that `helm/Chart.yaml`'s `home`/`sources` URLs (Tier A) will point at a stale repository name in the interim — cosmetic, and trivially fixed once Tier D happens, but worth noting so the two aren't assumed to be silently synchronized.

Recommended overall order: **A, then B (atomic), then C (image names immediately alongside B; Go module path whenever convenient), then D whenever the user is ready to act outside this session** — with the open naming-decision flag (bare `observer` → `coach5g` or something else) resolved before Tier B begins, since it changes the literal string used throughout Step 3's coordination groups.
