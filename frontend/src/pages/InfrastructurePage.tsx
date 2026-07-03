import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import NodeCards from '@/components/Infrastructure/NodeCards'
import ClusterGauges from '@/components/Infrastructure/ClusterGauges'
import TimeSeriesChart from '@/components/Infrastructure/TimeSeriesChart'
import EventsTable from '@/components/Infrastructure/EventsTable'
import { NodeCardSkeleton, Skeleton } from '@/components/common/LoadingSkeleton'
import { api } from '@/services/api'
import type { ClusterMetrics, ClusterInfo, K8sNode, NamespaceStats, PodMetricEntry } from '@/types/k8s'

// ─── Node stack card ──────────────────────────────────────────────────────────

function StackCard({ node, info }: { node: K8sNode; info: ClusterInfo }) {
  const cni = [info.cniPrimary, info.cniSecondary].filter(Boolean).join(' + ') || '—'
  return (
    <div
      className="rounded-lg p-3 text-xs space-y-1"
      style={{ background: '#161b22', border: '1px solid #30363d' }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono font-bold text-sm" style={{ color: '#e6edf3' }}>{node.name}</span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono"
          style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d' }}
        >
          {node.role}
        </span>
      </div>
      {([
        ['CPU',          `${node.cpuCores} cores`],
        ['RAM',          `${node.totalMemoryGiB} GiB`],
        ['Architecture', node.architecture],
        ['Hypervisor',   info.hypervisor || '—'],
        ['OS',           node.osImage],
        ['Kernel',       node.kernelVersion],
        ['Runtime',      node.containerRuntime],
        ['Kubernetes',   node.kubeletVersion],
        ['CNI',          cni],
      ] as [string, string][]).map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <span className="w-24 shrink-0 font-mono" style={{ color: '#8b949e' }}>{label}:</span>
          <span className="font-mono break-all" style={{ color: '#c9d1d9' }}>{value || '—'}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Pod utilization panel ────────────────────────────────────────────────────

function pctColor(pct: number): string {
  if (pct > 80) return '#f85149'
  if (pct >= 60) return '#d29922'
  return '#3fb950'
}

function PodUtilizationPanel() {
  const { data: podMetrics = [] } = useQuery<PodMetricEntry[]>({
    queryKey: ['pod-utilization'],
    queryFn: api.metrics.podsUtilization,
    refetchInterval: 15_000,
  })

  const grouped = useMemo(() => {
    const map = new Map<string, PodMetricEntry[]>()
    for (const p of podMetrics) {
      if (!map.has(p.namespace)) map.set(p.namespace, [])
      map.get(p.namespace)!.push(p)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [podMetrics])

  return (
    <div className="card p-4">
      <div className="label mb-3">Pod Utilization</div>
      <div className="overflow-y-auto" style={{ height: 300 }}>
        {grouped.length === 0 ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          grouped.map(([ns, pods]) => (
            <div key={ns} className="mb-4">
              <div
                className="font-mono text-xs font-bold mb-1 pb-1"
                style={{ color: '#58a6ff', borderBottom: '1px solid #30363d' }}
              >
                {ns}
              </div>
              <div
                className="grid font-mono mb-1"
                style={{ gridTemplateColumns: 'minmax(320px, 1fr) 140px 140px', color: '#6e7681', fontSize: 10 }}
              >
                <span>Pod</span>
                <span>CPU (used / % lim)</span>
                <span>RAM (used / % lim)</span>
              </div>
              {pods.map(p => {
                const cpuPct = p.cpuLimitM > 0 ? Math.round((p.cpuUsedM / p.cpuLimitM) * 100) : null
                const ramPct = p.ramLimitMi > 0 ? Math.round((p.ramUsedMi / p.ramLimitMi) * 100) : null
                return (
                  <div
                    key={p.pod}
                    className="grid font-mono text-xs py-0.5"
                    style={{ gridTemplateColumns: 'minmax(320px, 1fr) 140px 140px', color: '#c9d1d9' }}
                  >
                    <span className="pr-2" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.pod}</span>
                    <span>
                      {Math.round(p.cpuUsedM)}m
                      {cpuPct !== null
                        ? <span> (<span style={{ color: pctColor(cpuPct) }}>{cpuPct}%</span> lim)</span>
                        : <span style={{ color: '#8b949e' }}> (no limit)</span>
                      }
                    </span>
                    <span>
                      {Math.round(p.ramUsedMi)}Mi
                      {ramPct !== null
                        ? <span> (<span style={{ color: pctColor(ramPct) }}>{ramPct}%</span> lim)</span>
                        : <span style={{ color: '#8b949e' }}> (no limit)</span>
                      }
                    </span>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const REFETCH = 10_000

export default function InfrastructurePage() {
  const { data: nodes = [], isLoading: nodesLoading } = useQuery({
    queryKey: ['nodes'],
    queryFn: api.nodes.list,
    refetchInterval: REFETCH,
  })

  const { data: clusterInfo } = useQuery<ClusterInfo>({
    queryKey: ['cluster-info'],
    queryFn: api.clusterInfo.get,
    staleTime: 300_000,
  })

  const defaultClusterInfo: ClusterInfo = { hypervisor: '', cniPrimary: 'Cilium', cniSecondary: '' }

  const { data: metrics } = useQuery<ClusterMetrics>({
    queryKey: ['metrics-cluster'],
    queryFn: api.metrics.cluster,
    refetchInterval: REFETCH,
  })

  const { data: events = [] } = useQuery({
    queryKey: ['events'],
    queryFn: () => api.events.list(),
    refetchInterval: REFETCH,
  })

  const { data: nsStats = [] } = useQuery<NamespaceStats[]>({
    queryKey: ['namespace-stats'],
    queryFn: api.namespaceStats.list,
    refetchInterval: REFETCH,
  })

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto p-4 space-y-4">

        {/* Summary gauges */}
        {metrics ? (
          <ClusterGauges metrics={metrics} clusterInfo={clusterInfo} />
        ) : (
          <div className="flex gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-28" />
            ))}
          </div>
        )}

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">

          {/* LEFT: Node cards + Namespaces */}
          <div className="space-y-4">
            <div>
              <div className="label mb-2">Nodes</div>
              {nodesLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => <NodeCardSkeleton key={i} />)}
                </div>
              ) : (
                <NodeCards nodes={nodes} />
              )}
            </div>

            <div className="card p-4">
              <div className="label mb-3">Namespaces</div>
              {nsStats.length === 0 ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <div className="space-y-1">
                  {nsStats.map(ns => (
                    <div key={ns.namespace} className="flex items-center gap-3 text-xs">
                      <span className="font-mono text-slate-300 w-28 truncate">{ns.namespace}</span>
                      <span className="text-green-400 font-mono w-12">{ns.running}●</span>
                      {ns.pending > 0 && (
                        <span className="text-yellow-400 font-mono w-12">{ns.pending}⚡</span>
                      )}
                      {ns.failed > 0 && (
                        <span className="text-red-400 font-mono w-12">{ns.failed}✗</span>
                      )}
                      {ns.restarting > 0 && (
                        <span className="text-orange-400 font-mono w-12">{ns.restarting}↺</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: Pod utilization + Cluster charts + Node stack + Events */}
          <div className="space-y-4">
            <PodUtilizationPanel />

            <TimeSeriesChart />

            {nodes.length > 0 && (
              <div className="card p-4">
                <div className="label mb-3">Node Stack</div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {nodes.map(node => (
                    <StackCard key={node.name} node={node} info={clusterInfo ?? defaultClusterInfo} />
                  ))}
                </div>
              </div>
            )}

            <div className="card p-4">
              <div className="label mb-2">Recent Events</div>
              <EventsTable events={events.slice(0, 50)} />
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
