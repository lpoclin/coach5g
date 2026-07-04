# 04 — Installation: No Gateway API

This page covers a cluster with no Gateway API CRDs at all, either because you don't want to install them or because your environment doesn't support them.

**This is not implemented in the chart today.** `helm/templates/gateway.yaml` and `helm/templates/httproute.yaml` have no conditional guard around them (checked directly, both full files). They render on every `helm install`, unconditionally. On a cluster without the Gateway API CRDs installed, this means `helm install` will fail when it tries to create a `Gateway` resource of a kind the API server doesn't recognize.

There is no `gateway.class` value and no `gateway.fallback.serviceType` value in `helm/values.yaml` as it exists in this repository right now (checked directly, no match for either key). Those two keys, along with a fallback plain-Service template, are proposed in `docs/CNI_GATEWAY_PORTABILITY_ASSESSMENT.md`, section G, but have not been written into the chart. Everything below is the manual workaround for today, followed by what the values.yaml-driven version would look like once that work lands.

---

## Today's workaround

### Step 1 — Render the chart without the Gateway API resources

```bash
helm template coach5g ./helm \
  --namespace monitoring \
  --show-only templates/api-server-deployment.yaml \
  --show-only templates/api-server-service.yaml \
  --show-only templates/frontend-deployment.yaml \
  --show-only templates/frontend-service.yaml \
  --show-only templates/capture-agent-daemonset.yaml \
  --show-only templates/pvc.yaml \
  --show-only templates/rbac.yaml \
  --show-only templates/serviceaccount.yaml \
  > coach5g-no-gateway.yaml
```

This deliberately leaves out `templates/gateway.yaml` and `templates/httproute.yaml`. Everything else in the chart (both application Deployments, the DaemonSet, RBAC, the ServiceAccount) has no Gateway API dependency at all.

### Step 2 — Apply it

```bash
kubectl create namespace monitoring
kubectl apply -f coach5g-no-gateway.yaml
```

This gives you three running workloads with no external access yet. `observer-api` and `observer-frontend` are created as `ClusterIP` Services (`helm/templates/api-server-service.yaml`, `helm/templates/frontend-service.yaml:17`), reachable only inside the cluster.

### Step 3 — Expose the frontend only

You do not need to expose `observer-api` separately. The frontend's own nginx already proxies `/api/` and `/ws/` to `observer-api:8080` internally (`frontend/nginx.conf:14-29`), so exposing the `observer-frontend` Service alone is enough to reach the whole application.

If you're also enabling `auth.oauth2Proxy` in this tier, expose `coach5g-auth-proxy` instead of `coach5g-frontend` in every command below. The auth proxy is what should be reachable from outside the cluster in that case; it forwards to the frontend internally once a user is signed in.

---

## Sub-case: NodePort

Patch the existing Service, or apply a replacement with `type: NodePort`:

```bash
kubectl patch svc observer-frontend -n monitoring -p '{"spec":{"type":"NodePort"}}'
```

To pin a specific port instead of letting Kubernetes pick one, edit the Service and add a `nodePort` under the port entry:

```yaml
spec:
  type: NodePort
  ports:
    - name: http
      port: 80
      targetPort: 80
      nodePort: 30080
```

Valid NodePort range is 30000-32767 by default (a cluster-wide Kubernetes setting, not something this chart controls). Before picking a number, check what's already in use:

```bash
kubectl get svc -A -o jsonpath='{range .items[*]}{.spec.ports[*].nodePort}{"\n"}{end}' | grep -v '^$'
```

Avoid any port already listed. If you don't specify `nodePort`, Kubernetes assigns one automatically. Find out what it picked:

```bash
kubectl get svc observer-frontend -n monitoring -o jsonpath='{.spec.ports[0].nodePort}'
```

Access the application at `http://<any-node-ip>:<the-nodeport>`. Any node's IP works, not just the one the pod happens to be scheduled on, because NodePort opens the port on every node in the cluster.

---

## Sub-case: LoadBalancer via MetalLB

This chart does not install or configure MetalLB. MetalLB's own `IPAddressPool` and `L2Advertisement` (or BGP configuration) must already exist in your cluster before this step. That setup is entirely separate from this chart and not covered here.

```bash
kubectl patch svc observer-frontend -n monitoring -p '{"spec":{"type":"LoadBalancer"}}'
```

Find the assigned IP:

```bash
kubectl get svc observer-frontend -n monitoring -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

If this stays empty, MetalLB either has no free addresses in its pool or is not watching this Service's namespace. That is a MetalLB configuration question, not something this chart can diagnose.

Access the application at `http://<the-assigned-ip>` once it appears.

---

## Register your access address before you use it

Whatever address you ended up with above (the NodePort URL or the MetalLB IP), add it to `values.yaml`'s `allowedOrigins` and run `helm upgrade`. The app is reachable at that address either way, but without this step api-server rejects it as a CORS/WebSocket origin and the browser will show connection errors even though `curl` works fine.

```yaml
allowedOrigins:
  - "http://192.168.18.50:30080"
```

---

## What this would look like once implemented

`docs/CNI_GATEWAY_PORTABILITY_ASSESSMENT.md`, section G, proposes these values.yaml keys:

```yaml
gateway:
  class: none          # skip Gateway/HTTPRoute rendering entirely
  fallback:
    serviceType: LoadBalancer   # or NodePort
    # nodePort: 30080           # only used with serviceType: NodePort
```

With that in place, `helm install ./helm --set gateway.class=none --set gateway.fallback.serviceType=NodePort` would do everything Steps 1-3 above do manually. As of this repository's current state, that install path does not exist yet.
