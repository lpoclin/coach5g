# 02 — Installation: Cilium Gateway API

This is the validated reference configuration. It matches the setup used in this project's own testbed.

`helm install` handles three things automatically: the `Gateway` resource, the `HTTPRoute` resource, and the three application workloads (frontend, api-server, capture-agent). It does not install the Gateway API CRDs, and it does not create the Cilium IP pool or L2 announcement policy. Those three are cluster-level prerequisites you apply once, before running `helm install`, and they are not part of this chart.

---

## Prerequisites

- [ ] A Kubernetes cluster with Cilium installed as the CNI
- [ ] `kubectl` access with cluster-admin rights
- [ ] `helm` installed locally

---

## Step 1 — Install Gateway API CRDs

Skip this if your cluster already has them (check with `kubectl get crd | grep gateway.networking.k8s.io`).

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.1/standard-install.yaml
```

Verify:

```bash
kubectl get gatewayclass -o wide
```

You should see a `cilium` GatewayClass with `ACCEPTED: True`. If Cilium's Gateway API support was not enabled at install time, this GatewayClass will not exist. Check Cilium's own documentation for enabling it (not covered by this repository).

---

## Step 2 — Create the IP pool

This is a cluster-level resource. It is not part of this Helm chart, and `helm install` will not create it for you.

```bash
kubectl apply -f - <<EOF
apiVersion: cilium.io/v2
kind: CiliumLoadBalancerIPPool
metadata:
  name: local-pool
spec:
  blocks:
  - start: "192.168.18.230"
    stop: "192.168.18.237"
EOF
```

The IP range above is an example, taken from this project's own testbed setup (external reference; not defined anywhere in this repository). Adjust it to whatever range is free on your local network. This chart's default `gateway.ip` (`helm/values.yaml:7`, `192.168.18.234`) falls inside that example range, so if you reuse the same range, no override is needed.

Set `gateway.ipamPoolName` to the name of the pool you created above:

```bash
--set gateway.ipamPoolName=local-pool
```

`local-pool` is this project's own reference testbed pool name, confirmed against the live cluster (`kubectl get ciliumloadbalancerippool -A`). The chart's shipped default for `gateway.ipamPoolName` is `default`, unchanged from prior behavior, so any existing deployment that hasn't set this value renders exactly as before.

One thing worth knowing about how this actually resolves the requested IP: per Cilium's own LB-IPAM documentation, pool selection is done by matching a pool's `.spec.blocks` range (and, if set, its `.spec.serviceSelector`) against the request, not by an annotation naming the pool. The `cilium.io/ipam-pool` annotation set by this chart is not documented anywhere in Cilium's official LB-IPAM reference as a recognized key. What actually determines which pool your Gateway draws from is `spec.addresses` (`gateway.yaml:20-22`, driven by `gateway.ip`) landing inside an existing pool's block range, plus that pool having no `serviceSelector` that excludes this Gateway. `local-pool`'s range (`192.168.18.230`-`192.168.18.237` in the example above) already covers the default `gateway.ip` (`192.168.18.234`), so the address should resolve correctly through `spec.addresses` regardless of what `gateway.ipamPoolName` is set to. Setting it to match your real pool name is still correct practice and may matter on a future Cilium release, but as of Cilium 1.19 it does not appear to be load-bearing for address assignment. If the Gateway does not get the address you expect, see [05 — Troubleshooting](05-troubleshooting-portability.md).

---

## Step 3 — Create the L2 announcement policy

Also a cluster-level resource, applied once, outside this chart.

First check your nodes' primary interface name:

```bash
ip -br link show | grep -v lo
```

Then apply the policy, using the interface name and node selector that match your cluster. `role: observability` below matches this chart's own `nodeSelector` for the frontend and api-server Deployments (`helm/values.yaml:21-22,36-37`):

```bash
kubectl apply -f - <<EOF
apiVersion: cilium.io/v2alpha1
kind: CiliumL2AnnouncementPolicy
metadata:
  name: l2-announcement-policy
  namespace: kube-system
spec:
  nodeSelector:
    matchLabels:
      role: observability
  interfaces:
  - ens18
  externalIPs: true
  loadBalancerIPs: true
EOF
```

Replace `ens18` with whatever `ip -br link show` returned for your nodes.

If your cluster already has an IP pool and L2 announcement policy from installing other Cilium-fronted services (the observability stack, the 5G core WebUI), you do not need a second one. Reuse the existing pool and confirm it has free addresses.

---

## Step 4 — Install the chart

```bash
kubectl create namespace monitoring
helm install coach5g ./helm \
  --namespace monitoring \
  --set gateway.ip=192.168.18.234
```

`gateway.ip` must be an address inside the pool created in Step 2, and not already claimed by another Gateway.

---

## Step 5 — Verify

```bash
kubectl get gateway -A
```

Expect `observer` with `PROGRAMMED: True` and `ADDRESS` matching the IP you set.

```bash
kubectl get httproute -A
```

Expect `observer` with a parent reference to the `observer` Gateway.

```bash
curl -I http://192.168.18.234
```

Expect a `200` or a redirect from the frontend's nginx. If you get a `404` at the exact address with no path, that can be normal depending on how the SPA's root route responds; check `curl -I http://192.168.18.234/` (with trailing slash) if unsure.

If any of these do not match, go to [05 — Troubleshooting](05-troubleshooting-portability.md).
