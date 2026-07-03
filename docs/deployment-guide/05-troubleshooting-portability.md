# 05 — Troubleshooting: Portability

This page covers problems specific to CNI and Gateway portability, meaning anything that behaves differently depending on which CNI or exposure method your cluster uses. It does not cover general application bugs.

Each entry lists the symptom, the command to check it, and what a working versus broken result looks like.

---

## The Gateway never gets an address

**Symptom**: `kubectl get gateway -A` shows the `observer` Gateway with an empty `ADDRESS` column, or `PROGRAMMED: False`, for more than a minute or two after install.

**Check**:

```bash
kubectl get gatewayclass -o wide
```

Working: your target GatewayClass (`cilium`, or whatever you set `gateway.gatewayClassName` to) shows `ACCEPTED: True`. Broken: the GatewayClass is missing entirely, or shows `False`. If missing, the controller for that class was never installed, or Gateway API support was not enabled on it.

```bash
kubectl describe gateway observer -n monitoring
```

Read the `Conditions` section at the bottom. Look for anything mentioning IP allocation or the pool name. If you're on Cilium, confirm the pool referenced actually exists:

```bash
kubectl get ciliumloadbalancerippool
```

If this is empty, no pool was ever created (see [02](02-installation-cilium.md), Step 2). If a pool exists but the address still doesn't get assigned, check whether `gateway.ip` actually falls inside that pool's `.spec.blocks` range, and whether the pool has a `.spec.serviceSelector` that might exclude this Gateway. Set `gateway.ipamPoolName` (`helm/values.yaml`) to your pool's real name for clarity, but note that per Cilium's own LB-IPAM documentation, address assignment is driven by matching `spec.addresses` (`gateway.yaml:20-22`) against a pool's block range, not by the `cilium.io/ipam-pool` annotation naming the pool. See [02](02-installation-cilium.md) for the full explanation.

---

## HTTPRoute shows no attached routes

**Symptom**: the Gateway has an address, but requests to it return a connection reset, a generic 404 from the Gateway controller itself (not from the frontend's nginx), or time out.

**Check**:

```bash
kubectl get httproute observer -n monitoring -o yaml
```

Look at `.status.parents`. Working: at least one entry with `Accepted: True` and `ResolvedRefs: True`. Broken: the `parents` list is empty, or shows `Accepted: False`.

A common cause is a namespace mismatch. `httproute.yaml`'s `parentRefs` points at the `observer` Gateway in `.Values.namespace` (`helm/templates/httproute.yaml:9-11`). If you installed the chart into a different namespace than the Gateway lives in, or overrode one without the other, the reference will not resolve.

```bash
kubectl get svc observer-api observer-frontend -n monitoring
```

Confirm both Services exist and have endpoints:

```bash
kubectl get endpoints observer-api observer-frontend -n monitoring
```

Working: both show at least one IP:port pair. Broken: empty endpoints, meaning the backing pods are not Ready. Check `kubectl get pods -n monitoring` next.

---

## Multi-interface capture only shows eth0

**Symptom**: opening the interface dropdown for a pod in the Captures view only ever offers `eth0`, even for a pod you know has additional network attachments.

**Check**:

```bash
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.metadata.annotations.k8s\.v1\.cni\.cncf\.io/network-status}'
```

Working: this returns a JSON array with one entry per interface, including non-default ones. Broken: empty output, meaning Multus is either not installed or not attaching a NetworkAttachmentDefinition to this pod.

```bash
kubectl get pods -n kube-system -l app=multus
```

Confirm the Multus DaemonSet pods are `Running` on every node, including the one this pod is scheduled on. If Multus itself is fine but this specific pod still shows no `network-status` annotation, check whether the pod's spec actually references a `NetworkAttachmentDefinition` (`k8s.v1.cni.cncf.io/networks` annotation on the pod).

If Multus is genuinely not installed in your cluster, this is expected. `capture-agent/internal/discovery/pods.go:114,142-144` falls back to `["eth0"]` by design when the annotation is absent. See [01 — Requirements](01-requirements.md) for what Multus adds.

---

## Drop-rate metrics never appear

**Symptom**: the "Drop" row never shows up in the interface tooltip or side panel, on any pod or interface.

**Check**:

```bash
curl -s 'http://<prometheus-url>/api/v1/query?query=hubble_drop_total' | python3 -m json.tool
```

Working: `data.result` is a non-empty array. Broken: an empty array, meaning Prometheus has no `hubble_drop_total` series at all, which means Hubble metrics export was never enabled or is not being scraped.

This row is expected to be hidden entirely on a non-Cilium cluster, or on Cilium without Hubble metrics export enabled. The backend already detects this and returns `isCilium: false` in that case (`api-server/internal/handlers/metrics.go:92-98`); the frontend hides the row rather than showing zero (`frontend/src/components/Topology/SidePanel.tsx:331`, `frontend/src/components/Topology/TopologyCanvas.tsx:671-672`). If you are on Cilium and expect this to work, confirm the CNI is actually being detected as Cilium:

```bash
curl -s http://<api-server-host>/api/cluster-info | python3 -m json.tool
```

Check the `primaryCNI` field in the response. If it shows `"CNI"` instead of `"Cilium"`, detection failed. `api-server/internal/k8s/topology.go:635-681` (`DetectPrimaryCNI`) looks for specific pod names and labels in `kube-system`; an unusual Cilium install (custom Helm release name, non-standard namespace) may not match.

---

## Using a CNI/Gateway combination not covered here

If you're on a CNI other than Cilium or Flannel+Multus, or a Gateway API controller other than Cilium's, none of this guide's steps have been tested against your exact setup. Two things are confirmed independent of CNI and Gateway choice, from direct code reading, and are a safe starting point for isolating the problem:

The packet capture mechanism itself (`nsenter --net=/proc/<pid>/ns/net -- tcpdump`) reads only the Linux kernel's network namespace file and runs standard packet-capture syscalls inside it. It has no CNI-specific code anywhere (`capture-agent/internal/capture/nsenter.go`, full file checked). If capture doesn't work, the problem is almost certainly in pod/PID discovery (`findPodPID`, `nsenter.go:28-72`) or in RBAC/privileges (`hostPID`, `NET_RAW`/`NET_ADMIN`/`SYS_PTRACE`, `helm/templates/capture-agent-daemonset.yaml`), not in the CNI.

CORS and WebSocket origin checks are wide open (`Access-Control-Allow-Origin: *`, `api-server/cmd/server/main.go:167`; `CheckOrigin` always returns `true`, `api-server/internal/handlers/topology.go:20`). Whatever address or hostname you reach the frontend at, the backend does not reject the request based on origin. If something breaks when switching exposure methods, it is not this.

For anything else, see `docs/CNI_GATEWAY_PORTABILITY_ASSESSMENT.md` for the full trace of what depends on Cilium and what doesn't, or open an issue describing your exact CNI and Gateway combination.
