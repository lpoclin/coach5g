import type { TopologyGraph, TopologyNode, NetworkInterface } from '@/types/topology'
import type {
  K8sNode, K8sEvent, K8sPVC, ClusterMetrics,
  NamespaceStats, ClusterTimeSeries, ClusterInfo, PodMetricEntry,
} from '@/types/k8s'

const BASE = import.meta.env.VITE_API_URL ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  topology: {
    get: (namespace?: string) =>
      request<TopologyGraph>(namespace ? `/api/topology?namespace=${encodeURIComponent(namespace)}` : '/api/topology'),
    namespaces: () => request<string[]>('/api/namespaces'),
  },
  pods: {
    list: (namespace: string) =>
      request<TopologyNode[]>(`/api/pods/${encodeURIComponent(namespace)}`),
    interfaces: (namespace: string, pod: string) =>
      request<NetworkInterface[]>(
        `/api/pod/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/interfaces`,
      ),
  },
  logs: {
    get: (namespace: string, pod: string, lines = 500) =>
      request<string[]>(
        `/api/logs/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}?lines=${lines}`,
      ),
  },
  metrics: {
    cluster: () => request<ClusterMetrics>('/api/metrics/cluster'),
    timeseries: (range: '1h' | '6h' | '24h') =>
      request<ClusterTimeSeries>(`/api/metrics/timeseries?range=${range}`),
    pod: (namespace: string, pod: string) =>
      request<{ cpuPercent: number; memoryMi: number }>(
        `/api/metrics/pod/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}`,
      ),
    podsUtilization: () => request<PodMetricEntry[]>('/api/metrics/pods'),
    interfaceMetrics: (pod: string, iface: string) =>
      request<{ throughputMbps: number; packetsPerSec: number; dropRate: number; isCilium?: boolean }>(
        `/api/metrics/interface?pod=${encodeURIComponent(pod)}&interface=${encodeURIComponent(iface)}`
      ),
  },
  nodes: {
    list: () => request<K8sNode[]>('/api/nodes'),
  },
  clusterInfo: {
    get: () => request<ClusterInfo>('/api/cluster-info'),
  },
  events: {
    list: (namespace?: string) =>
      request<K8sEvent[]>(namespace ? `/api/events/${encodeURIComponent(namespace)}` : '/api/events'),
  },
  pvcs: {
    list: () => request<K8sPVC[]>('/api/pvcs'),
  },
  namespaceStats: {
    list: () => request<NamespaceStats[]>('/api/namespace-stats'),
  },
  capture: {
    exportUrl: (sessionId: string) => `${BASE}/api/capture/export/${encodeURIComponent(sessionId)}`,
  },
}
