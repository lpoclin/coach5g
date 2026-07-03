import { useState } from 'react'
import clsx from 'clsx'
import type { K8sNode } from '@/types/k8s'

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="relative h-1.5 w-full bg-bg-hover rounded-full overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
        style={{ width: `${Math.min(pct, 100)}%`, background: color }}
      />
    </div>
  )
}

function MetricRow({
  label,
  pct,
  color,
  detail,
}: {
  label: string
  pct: number
  color: string
  detail: string
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px]">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-400 font-mono">{detail}</span>
      </div>
      <ProgressBar pct={pct} color={color} />
    </div>
  )
}

interface Tooltip { x: number; y: number; node: K8sNode }

export default function NodeCards({ nodes }: { nodes: K8sNode[] }) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)

  if (!nodes.length) {
    return (
      <div className="text-slate-600 text-sm text-center py-8">No nodes available</div>
    )
  }

  return (
    <div className="relative space-y-2">
      {nodes.map(node => {
        const cpuColor = node.cpu.percent > 80 ? '#ef4444' : node.cpu.percent > 60 ? '#f97316' : '#22c55e'
        const ramColor = node.memory.percent > 85 ? '#ef4444' : node.memory.percent > 70 ? '#f97316' : '#3b82f6'
        const diskColor = node.disk.percent > 90 ? '#ef4444' : node.disk.percent > 70 ? '#f97316' : '#6b7280'
        const isReady = node.status === 'Ready'

        return (
          <div
            key={node.name}
            className="card p-3 cursor-pointer hover:border-border-hover transition-colors"
            onMouseEnter={e => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setTooltip({ x: rect.right + 8, y: rect.top, node })
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className={clsx('w-2.5 h-2.5 rounded-full', isReady ? 'bg-green-400' : 'bg-red-500')} />
                <span className="font-mono text-sm font-semibold text-slate-200">{node.name}</span>
              </div>
              <div className="flex items-center gap-2">
                {node.role && (
                  <span className="badge bg-bg-hover text-slate-400">{node.role}</span>
                )}
                <span className={clsx('badge', isReady ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400')}>
                  {node.status}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <MetricRow
                label={`CPU — ${node.cpu.percent}%`}
                pct={node.cpu.percent}
                color={cpuColor}
                detail={`${node.cpu.used.toFixed(2)} / ${node.cpu.allocatable}c`}
              />
              <MetricRow
                label={`RAM — ${node.memory.percent}%`}
                pct={node.memory.percent}
                color={ramColor}
                detail={`${Math.round(node.memory.usedBytes / 1e9 * 10) / 10}G / ${Math.round(node.memory.allocatableBytes / 1e9)}G`}
              />
            </div>

            <div className="flex items-center justify-between mt-2 text-[10px] text-slate-500">
              <span>{node.podCount} / {node.podCapacity} pods</span>
              <span className="font-mono">{node.ip}</span>
            </div>
          </div>
        )
      })}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 bg-bg-secondary border border-border rounded-lg p-3 text-xs shadow-xl pointer-events-none w-56"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-mono font-semibold text-slate-200 mb-2">{tooltip.node.name}</div>
          <div className="space-y-1 text-slate-400">
            <div>
              <span className="text-slate-500">Disk: </span>
              {Math.round((tooltip.node.disk.capacityBytes - tooltip.node.disk.usedBytes) / 1e9)}GB free
              ({tooltip.node.disk.percent}% used)
            </div>
            <div>
              <span className="text-slate-500">OS: </span>{tooltip.node.osImage}
            </div>
            <div>
              <span className="text-slate-500">kubelet: </span>
              <span className="font-mono">{tooltip.node.kubeletVersion}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
