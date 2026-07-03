# coach5g

Production-grade 5G SA network observability platform for Kubernetes-native testbeds.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Browser (React 19 + Vite)                    │
│  ┌──────────────┐  ┌───────────────────┐  ┌─────────────────┐  │
│  │ Topology View│  │Infrastructure View│  │  Capture View   │  │
│  │ (Cytoscape.js│  │ (Recharts/k8s API)│  │ (Wireshark-like)│  │
│  └──────┬───────┘  └────────┬──────────┘  └────────┬────────┘  │
└─────────┼────────────────── ┼──────────────────────┼───────────┘
          │ REST + WebSocket  │                      │
┌─────────▼───────────────────▼──────────────────────▼───────────┐
│                  api-server (Go + Gin)  :8080                   │
│  ┌────────────┐  ┌──────────┐  ┌───────────┐  ┌─────────────┐ │
│  │ k8s client │  │  Loki    │  │ Prometheus│  │ gRPC server │ │
│  │ (topology) │  │  client  │  │  client   │  │ (captures)  │ │
│  └─────┬──────┘  └────┬─────┘  └─────┬─────┘  └──────┬──────┘ │
└────────┼──────────────┼──────────────┼────────────────┼────────┘
         │              │              │                 │ gRPC stream
         ▼              ▼              ▼       ┌─────────▼────────┐
  ┌─────────────┐  ┌─────────┐  ┌──────────┐  │  capture-agent   │
  │  k8s API    │  │  Loki   │  │Prometheus│  │  (DaemonSet)     │
  │  :6443      │  │  :80    │  │  :9090   │  │  nsenter+tcpdump │
  └─────────────┘  └─────────┘  └──────────┘  └──────────────────┘
         │
  ┌──────▼──────────────────────────────┐
  │         Kubernetes Cluster          │
  │  free5GC NFs  │  UERANSIM  │ Infra │
  └─────────────────────────────────────┘
```

## Components

| Component | Image | Description |
|-----------|-------|-------------|
| frontend | `ghcr.io/lpoclin/coach5g-frontend` | React SPA served by nginx |
| api-server | `ghcr.io/lpoclin/coach5g-api` | Go REST + WebSocket backend |
| capture-agent | `ghcr.io/lpoclin/coach5g-capture` | Privileged DaemonSet for packet capture |

## Views

### Topology View
Auto-discovers all pods in target namespaces and builds a 3GPP TS 23.501-style topology graph:
- **SBI plane** (blue): NRF hub-and-spoke with AMF, SMF, AUSF, UDM, UDR, PCF, NSSF, CHF, NEF
- **RAN layer** (orange): gNB ↔ AMF (N2/NGAP), gNB ↔ iUPF (N3/GTP-U)
- **User plane** (green): iUPF1 → PSA-UPF1/2 (N9), UPFs → DN (N6)
- **PFCP plane** (purple): SMF ↔ all UPFs (N4)

### Infrastructure View
Kubernetes-wide monitoring without Grafana:
- Node resource usage (CPU/RAM/disk)
- Cluster summary gauges
- Time-series charts (Recharts)
- PVC status, Events, Pod tables

### Packet Capture View
Wireshark-style live packet capture per interface:
- GTP-U, PFCP, HTTP/2, NGAP, NAS, SCTP decode
- Live filter, hex dump, .pcap export
- Multiple simultaneous capture tabs

## Cluster Requirements

```
k8s-master:    192.168.18.210  (control plane)
k8s-worker-1:  192.168.18.211  role=general     (free5GC CP)
k8s-worker-2:  192.168.18.212  role=userplane   (UPF, gNB, UE)
k8s-worker-3:  192.168.18.213  role=observability (this stack)
```

## Install

```bash
helm install coach5g ./helm \
  --namespace monitoring \
  --set gateway.ip=192.168.18.234
```

Access at: `http://192.168.18.234`

## Development

```bash
# Frontend
cd frontend && npm install && npm run dev

# api-server
cd api-server && go run ./cmd/server

# capture-agent (needs privileged node access)
cd capture-agent && go run ./cmd/agent
```

## Existing Stack Integration

| Service | Address |
|---------|---------|
| Prometheus | `kube-prometheus-stack-prometheus.monitoring:9090` |
| Grafana | `kube-prometheus-stack-grafana.monitoring:80` |
| Loki | `loki-gateway.loki:80` |
| Hubble Relay | `hubble-relay.kube-system:4245` |
| Longhorn | `longhorn-backend.longhorn-system:9500` |

## License

MIT
