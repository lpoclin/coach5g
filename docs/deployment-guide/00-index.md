# Deployment Guide

Read these in order. Each one assumes the previous one is done.

1. [01 — Requirements](01-requirements.md). What the tool needs to run, and what it can run without.
2. [02 — Installation: Cilium Gateway API](02-installation-cilium.md). The validated reference setup, matching this project's own testbed.
3. [03 — Installation: Generic Gateway API](03-installation-generic-gateway.md). Same chart, a Gateway API controller other than Cilium (Istio, Envoy Gateway, etc). Not verified against a real cluster.
4. [04 — Installation: No Gateway API](04-installation-no-gateway-api.md). NodePort or a LoadBalancer implementation such as MetalLB, with no Gateway API CRDs at all. Requires a manual workaround today.
5. [05 — Troubleshooting: Portability](05-troubleshooting-portability.md). What to check when the Gateway, HTTPRoute, multi-interface capture, or drop-rate metrics don't come up the way this guide says they should.

This guide only covers external exposure and CNI/Gateway portability. It does not cover the 5G core deployment itself (free5GC, UERANSIM), which belongs to a separate project. It also does not cover authentication, TLS, or RBAC hardening, which are tracked separately in `docs/RISK_ASSESSMENT_ADDITIONS.md`.
