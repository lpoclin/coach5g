#!/usr/bin/env python3
"""
COACH5G resource overhead benchmark.

Sweeps 0-8 concurrent /ws/packets subscribers, measures coach5g-api and
coach5g-capture CPU/RAM from Prometheus at each level.

Cluster specifics (this deployment):
  - Prometheus scrape_interval = 30s -> rate() window set to 2m.
  - coach5g-auth-proxy is enabled here, so the script opens its own
    port-forward straight to the coach5g-api Service to skip it.
  - Prometheus is reachable via its existing HTTPRoute, no forward needed.

Usage:
  python3 coach5g_overhead_benchmark.py --check-only   # verify connectivity only
  python3 coach5g_overhead_benchmark.py                # full 0-8 sweep

Requires: pip install websockets requests
"""

import argparse
import asyncio
import csv
import json
import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional

import requests
import websockets

RATE_WINDOW      = "2m"
SETTLE_SECONDS   = 30
SAMPLE_SECONDS   = 150
COOLDOWN_SECONDS = 30
LEVELS           = list(range(0, 9))  # matches MAX_CAPTURE_TABS, CapturePage.tsx:46

PF_LOCAL_PORT  = 8081
PF_SVC         = "svc/coach5g-api"
PF_NAMESPACE   = "monitoring"
PF_REMOTE_PORT = 8080


@dataclass
class LevelResult:
    level: int
    timestamp: str
    api_cpu_millicores: Optional[float]
    api_ram_mib: Optional[float]
    capture_cpu_millicores: Optional[float]
    capture_ram_mib: Optional[float]
    requested_connections: int
    confirmed_connections: int
    sanity_ok: bool


class PortForward:
    """Starts `kubectl port-forward` as a child process and waits until the
    local port actually accepts connections before returning."""

    def __init__(self, svc: str, namespace: str, local_port: int, remote_port: int):
        self.svc, self.ns, self.local_port, self.remote_port = svc, namespace, local_port, remote_port
        self.proc = None

    def start(self, timeout=15):
        cmd = ["kubectl", "port-forward", "-n", self.ns, self.svc,
               f"{self.local_port}:{self.remote_port}"]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                out = self.proc.stdout.read()
                raise RuntimeError(f"port-forward exited early:\n{out}")
            try:
                with socket.create_connection(("localhost", self.local_port), timeout=1):
                    return
            except OSError:
                time.sleep(0.5)
        self.stop()
        raise TimeoutError(f"port-forward to {self.local_port} did not come up in {timeout}s")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class PromClient:
    def __init__(self, base_url: str, namespace: str):
        self.base_url = base_url.rstrip("/")
        self.ns = namespace

    def _query_scalar(self, promql: str) -> Optional[float]:
        r = requests.get(f"{self.base_url}/api/v1/query", params={"query": promql}, timeout=20)
        r.raise_for_status()
        result = r.json().get("data", {}).get("result", [])
        return float(result[0]["value"][1]) if result else None

    def pod_cpu_millicores(self, pod_prefix: str, container: str) -> Optional[float]:
        q = (f'sum(rate(container_cpu_usage_seconds_total{{'
             f'namespace="{self.ns}", pod=~"{pod_prefix}-.*", container="{container}"}}[{RATE_WINDOW}])) * 1000')
        return self._query_scalar(q)

    def pod_ram_mib(self, pod_prefix: str, container: str) -> Optional[float]:
        q = (f'sum(container_memory_working_set_bytes{{'
             f'namespace="{self.ns}", pod=~"{pod_prefix}-.*", container="{container}"}}) / 1048576')
        return self._query_scalar(q)

    def check(self) -> bool:
        try:
            r = requests.get(f"{self.base_url}/api/v1/query", params={"query": "up"}, timeout=10)
            return r.status_code == 200
        except requests.RequestException:
            return False

    def check_live_query(self, container: str) -> bool:
        """Confirms the actual query shape this script depends on returns
        data, not just that Prometheus is reachable."""
        try:
            return self.pod_cpu_millicores("coach5g-api", container) is not None
        except Exception:
            return False


class Coach5GClient:
    def __init__(self, api_base: str, ws_base: str):
        self.api_base = api_base.rstrip("/")
        self.ws_base = ws_base.rstrip("/")

    def check(self) -> bool:
        try:
            r = requests.get(f"{self.api_base}/api/topology", timeout=10)
            return r.status_code == 200
        except requests.RequestException:
            return False

    def discover_interfaces(self, max_n: int) -> list[tuple[str, str, str]]:
        r = requests.get(f"{self.api_base}/api/topology", timeout=15)
        r.raise_for_status()
        graph = r.json()
        pairs, seen = [], set()
        for node in graph.get("nodes", []):
            pod, ns = node.get("podName"), node.get("namespace")
            if not pod or not ns:
                continue
            for iface in node.get("interfaces", []) or []:
                name = iface.get("interface")
                if not name:
                    continue
                key = (ns, pod, name)
                if key not in seen:
                    seen.add(key)
                    pairs.append(key)
                    if len(pairs) >= max_n:
                        return pairs
        return pairs

    def active_traffic_pairs(self) -> set[tuple[str, str]]:
        r = requests.get(f"{self.api_base}/api/metrics/active", timeout=10)
        r.raise_for_status()
        return {(item["pod"], item["iface"]) for item in r.json().get("active", [])}

    def ws_url(self, pod: str, iface: str) -> str:
        return f"{self.ws_base}/ws/packets?pod={pod}&interface={iface}"


async def hold_connection(url: str, stop_event: asyncio.Event, connected_event: asyncio.Event):
    try:
        async with websockets.connect(url, open_timeout=10) as ws:
            connected_event.set()
            while not stop_event.is_set():
                try:
                    await asyncio.wait_for(ws.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                except websockets.ConnectionClosed:
                    break
    except Exception as e:
        print(f"  [!] {url} failed: {e}", file=sys.stderr)


async def run_level(level, pairs, client, prom, api_container, capture_container, dry_run) -> LevelResult:
    print(f"\n--- level {level}: opening {level} connection(s) ---")

    stop_event = asyncio.Event()
    connected_events = [asyncio.Event() for _ in range(level)]
    chosen = pairs[:level]
    tasks = [
        asyncio.create_task(hold_connection(client.ws_url(pod, iface), stop_event, connected_events[i]))
        for i, (_, pod, iface) in enumerate(chosen)
    ]

    confirmed = 0
    if level > 0:
        try:
            await asyncio.wait_for(asyncio.gather(*[e.wait() for e in connected_events]), timeout=15)
        except asyncio.TimeoutError:
            pass
        confirmed = sum(1 for e in connected_events if e.is_set())
        print(f"  confirmed {confirmed}/{level} connections open")

    sanity_ok = True
    if level > 0 and not dry_run:
        await asyncio.sleep(2)
        try:
            active = client.active_traffic_pairs()
            expected = {(pod, iface) for _, pod, iface in chosen}
            overlap = expected & active
            sanity_ok = len(overlap) > 0
            print(f"  {len(overlap)}/{len(expected)} pairs showing live traffic in /api/metrics/active")
        except Exception as e:
            print(f"  [!] sanity check failed: {e}", file=sys.stderr)
            sanity_ok = False

    print(f"  settling {SETTLE_SECONDS}s, sampling {SAMPLE_SECONDS}s...")
    await asyncio.sleep(SETTLE_SECONDS)
    await asyncio.sleep(SAMPLE_SECONDS)

    # a single failed Prometheus query should not lose the rest of the sweep
    api_cpu = api_ram = cap_cpu = cap_ram = None
    try:
        api_cpu = prom.pod_cpu_millicores("coach5g-api", api_container)
        api_ram = prom.pod_ram_mib("coach5g-api", api_container)
        cap_cpu = prom.pod_cpu_millicores("coach5g-capture", capture_container)
        cap_ram = prom.pod_ram_mib("coach5g-capture", capture_container)
        print(f"  api: {api_cpu} m CPU / {api_ram} MiB   capture: {cap_cpu} m CPU / {cap_ram} MiB")
    except Exception as e:
        print(f"  [!] Prometheus query failed for level {level}: {e}", file=sys.stderr)
        sanity_ok = False

    # close every connection from this level and wait for it to actually
    # finish before the next level opens, so levels never overlap
    stop_event.set()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    print(f"  level {level} closed, cooling down {COOLDOWN_SECONDS}s...")
    await asyncio.sleep(COOLDOWN_SECONDS)

    return LevelResult(level, datetime.now(timezone.utc).isoformat(),
                        api_cpu, api_ram, cap_cpu, cap_ram, level, confirmed, sanity_ok)


def run_checks(client: Coach5GClient, prom: PromClient, pairs: list, api_container: str) -> bool:
    ok = True
    print("checking coach5g-api ...", end=" ")
    if client.check():
        print("ok")
    else:
        print("FAILED")
        ok = False
    print("checking Prometheus ...", end=" ")
    if prom.check():
        print("ok")
    else:
        print("FAILED")
        ok = False
    print("checking Prometheus actually returns coach5g-api CPU data ...", end=" ")
    if prom.check_live_query(api_container):
        print("ok")
    else:
        print("FAILED (namespace/container name likely wrong)")
        ok = False
    print(f"checking topology has interfaces ... found {len(pairs)}", "ok" if pairs else "FAILED")
    if not pairs:
        ok = False
    return ok


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--api-base", default=f"http://localhost:{PF_LOCAL_PORT}")
    ap.add_argument("--ws-base", default=f"ws://localhost:{PF_LOCAL_PORT}")
    ap.add_argument("--prom-base", default="http://192.168.18.230/prometheus")
    ap.add_argument("--namespace", default="monitoring")
    ap.add_argument("--api-container", default="api-server")
    ap.add_argument("--capture-container", default="capture-agent")
    ap.add_argument("--out", default="coach5g_overhead.csv")
    ap.add_argument("--dry-run", action="store_true", help="skip the sanity check requirement")
    ap.add_argument("--check-only", action="store_true", help="only verify connectivity, run nothing")
    ap.add_argument("--no-port-forward", action="store_true", help="assume port-forward is already running")
    args = ap.parse_args()

    pf = None
    if not args.no_port_forward:
        print(f"starting kubectl port-forward -n {PF_NAMESPACE} {PF_SVC} {PF_LOCAL_PORT}:{PF_REMOTE_PORT} ...")
        pf = PortForward(PF_SVC, PF_NAMESPACE, PF_LOCAL_PORT, PF_REMOTE_PORT)
        try:
            pf.start()
        except Exception as e:
            print(f"could not start port-forward: {e}", file=sys.stderr)
            sys.exit(1)
        print("port-forward is up")

    try:
        client = Coach5GClient(args.api_base, args.ws_base)
        prom = PromClient(args.prom_base, args.namespace)

        pairs = client.discover_interfaces(max_n=8) if client.check() else []
        if not run_checks(client, prom, pairs, args.api_container):
            print("\nconnectivity check failed, fix the above before running the sweep", file=sys.stderr)
            sys.exit(1)

        if args.check_only:
            print("\nall checks passed")
            return

        if len(pairs) < 8:
            print(f"[!] only {len(pairs)} distinct interfaces found, levels above that will be skipped",
                  file=sys.stderr)

        def write_results(results):
            tmp = args.out + ".tmp"
            if args.out.endswith(".json"):
                with open(tmp, "w") as f:
                    json.dump([asdict(r) for r in results], f, indent=2)
            else:
                with open(tmp, "w", newline="") as f:
                    w = csv.DictWriter(f, fieldnames=list(asdict(results[0]).keys()))
                    w.writeheader()
                    for r in results:
                        w.writerow(asdict(r))
            os.replace(tmp, args.out)  # atomic: readers never see a half-written file

        results = []
        for level in LEVELS:
            if level > len(pairs):
                print(f"skipping level {level}: not enough interfaces", file=sys.stderr)
                continue
            results.append(await run_level(level, pairs, client, prom,
                                            args.api_container, args.capture_container, args.dry_run))
            # write after every level, not only at the end, so a later
            # crash doesn't discard levels already measured
            write_results(results)

        if not results:
            print("nothing to write", file=sys.stderr)
            return
        print(f"\nwrote {len(results)} level(s) to {args.out}")

    finally:
        if pf:
            pf.stop()


if __name__ == "__main__":
    asyncio.run(main())
