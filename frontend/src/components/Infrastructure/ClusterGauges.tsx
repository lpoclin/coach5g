import type { ClusterMetrics, ClusterInfo } from '@/types/k8s'

interface GaugeProps {
  label: string
  value: number | string
  max?: number | string
  color?: string
  status?: 'ok' | 'warn' | 'error'
}

function Gauge({ label, value, max, color = '#3b82f6', status = 'ok' }: GaugeProps) {
  const dotColor = status === 'ok' ? '#22c55e' : status === 'warn' ? '#eab308' : '#ef4444'

  return (
    <div className="card p-4 flex flex-col items-center gap-1.5 min-w-[100px]">
      <div className="text-2xl font-bold font-mono text-slate-100" style={{ color }}>
        {value}
      </div>
      {max !== undefined && (
        <div className="text-xs text-slate-500 font-mono">/ {max}</div>
      )}
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="w-2 h-2 rounded-full" style={{ background: dotColor }} />
        <span className="text-xs text-slate-400 font-semibold uppercase tracking-wide">{label}</span>
      </div>
    </div>
  )
}

export default function ClusterGauges({ metrics, clusterInfo }: { metrics: ClusterMetrics; clusterInfo?: ClusterInfo }) {
  const podStatus =
    metrics.podsRunning === metrics.podsTotal ? 'ok'
    : metrics.podsRunning > metrics.podsTotal * 0.8 ? 'warn'
    : 'error'

  const nodeStatus = metrics.nodesReady === metrics.nodesTotal ? 'ok' : 'error'
  const pvcStatus  = metrics.pvcsBound === metrics.pvcsTotal ? 'ok' : 'warn'

  let uptimeStr = '—'
  if (clusterInfo?.clusterCreatedAt) {
    const diffMs = Date.now() - new Date(clusterInfo.clusterCreatedAt).getTime()
    const days  = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
    uptimeStr = `${days}d ${hours}h`
  }

  return (
    <div className="flex flex-wrap gap-3">
      <Gauge
        label="PODS"
        value={`${metrics.podsRunning} / ${metrics.podsTotal}`}
        color="#22c55e"
        status={podStatus}
      />
      <Gauge
        label="NODES"
        value={`${metrics.nodesReady} / ${metrics.nodesTotal}`}
        color="#3b82f6"
        status={nodeStatus}
      />
      <Gauge
        label="PVCS"
        value={`${metrics.pvcsBound} / ${metrics.pvcsTotal}`}
        color="#a855f7"
        status={pvcStatus}
      />
      <Gauge
        label="UPTIME"
        value={uptimeStr}
        color="#6b7280"
        status="ok"
      />
    </div>
  )
}
