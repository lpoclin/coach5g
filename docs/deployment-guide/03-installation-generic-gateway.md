# 03 — Installation: Generic Gateway API

This page covers a cluster that has the Kubernetes Gateway API CRDs installed, but uses a controller other than Cilium (Istio, Envoy Gateway, or anything else implementing the same spec).

**Not verified.** Nothing in this page has been tested against a real Istio or Envoy Gateway cluster. It is written from reading the chart's templates and the Gateway API spec, not from a working deployment. Treat the steps below as a starting point, and confirm each one against your own controller's documentation.

---

## What already works without changes

`helm/templates/httproute.yaml` is a plain, standard `HTTPRoute`. It has no Cilium-specific fields, annotations, or assumptions (checked directly, full file). It should work unmodified under any spec-compliant Gateway API implementation.

`helm/templates/gateway.yaml`'s `gatewayClassName` field is already templated from `.Values.gateway.gatewayClassName` (`gateway.yaml:12`), so pointing it at a different controller does not require editing the chart, only a `--set` override at install time.

---

## What is Cilium-specific and needs attention

The `Gateway` resource carries one unconditional annotation, `cilium.io/ipam-pool: "default"` (`gateway.yaml:8-10`). It is not gated behind any check on `gatewayClassName`, so it renders regardless of which controller you target. A spec-compliant, non-Cilium controller should simply ignore an annotation it doesn't recognize (this is standard Kubernetes API behavior), but you may see it in the rendered manifest and wonder why it's there. It has no effect outside Cilium.

The static IP request via `spec.addresses` (`gateway.yaml:20-22`) is a standard Gateway API field, not a Cilium extension, but whether your controller honors a caller-requested static address is controller-specific. Some implementations assign addresses dynamically and ignore this field. Check after install (Step 3 below) rather than assuming it worked.

---

## Step 1 — Confirm your GatewayClass

```bash
kubectl get gatewayclass -o wide
```

Note the exact name your controller registers (for example `istio`, `eg` for Envoy Gateway). You will pass this as `gateway.gatewayClassName`.

---

## Step 2 — Install the chart

```bash
kubectl create namespace monitoring
helm install coach5g ./helm \
  --namespace monitoring \
  --set gateway.gatewayClassName=<your-gatewayclass-name> \
  --set gateway.ip=<an-ip-your-controller-can-assign-or-ignore>
```

If your controller does not support caller-requested static addresses, set `gateway.ip` to any placeholder value. It will still be written into `spec.addresses` and into the `HTTPRoute`'s `hostnames` list (`httproute.yaml:12-14`), but the actual assigned address may differ. See Step 3 to find out what address you actually got.

---

## Step 3 — Check what address you actually got

```bash
kubectl get gateway observer -n monitoring -o jsonpath='{.status.addresses}'
```

This is the address your controller actually assigned, which may or may not match `gateway.ip`. If it differs, either update your DNS/hosts entry to point at the real address, or reinstall the `HTTPRoute` with a corrected `hostnames` list to match.

```bash
kubectl get gateway observer -n monitoring
```

Check the `PROGRAMMED` column. `True` means the controller accepted and processed the Gateway. `False` or missing means something in Steps 1-2 needs fixing before continuing.

---

## Step 4 — Verify routing

```bash
kubectl get httproute observer -n monitoring -o jsonpath='{.status.parents}'
```

Look for a `Accepted: True` / `ResolvedRefs: True` condition under your controller's name. If these are missing or `False`, the route was not attached to the Gateway, and requests will not reach the frontend or api-server.

```bash
curl -I http://<the-address-from-step-3>/
```

If this fails, go to [05 — Troubleshooting](05-troubleshooting-portability.md).

---

## If none of this works

Fall back to [04 — No Gateway API](04-installation-no-gateway-api.md). It does not depend on any Gateway API controller at all.
