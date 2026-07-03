import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { useLogs, type LogLevel } from '@/hooks/useLogs'
import { IconX } from '@/components/common/icons'
import type { TopologyNode } from '@/types/topology'
import type { ClusterInfo } from '@/types/k8s'
import { api } from '@/services/api'

const METRICS_REFRESH_MS = 300

// ─── Types ────────────────────────────────────────────────────────────────────
interface NfTabInfo {
  id: string
  node: TopologyNode
  view: 'logs' | 'info'
}

interface Props {
  node: TopologyNode
  allNodes: TopologyNode[]
  onClose: () => void
  onCaptureEdge?: (nodeId: string, iface: string) => void
  tabs: NfTabInfo[]
  activeTabId: string | null
  onTabSelect: (id: string) => void
  onTabClose: (id: string) => void
}

interface IfaceMeta { throughputMbps: number; packetsPerSec: number; dropRate: number; isCilium?: boolean }
type MetricsMap = Record<string, IfaceMeta | null>

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ node }: { node: TopologyNode }) {
  const { condition, restarts } = node.status
  const color =
    condition === 'Running' && restarts === 0
      ? 'bg-green-500'
      : condition === 'Running' && restarts > 0 && restarts <= 3
        ? 'bg-yellow-400'
        : condition === 'Running' && restarts > 3
          ? 'bg-orange-400'
          : condition === 'CrashLoopBackOff' || condition === 'Error' || condition === 'OOMKilled'
            ? 'bg-red-500'
            : 'bg-gray-500'

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className={clsx('w-2 h-2 rounded-full inline-block', color)} />
      <span className="text-slate-300">{condition}</span>
      {restarts > 0 && (
        <span className="text-yellow-400 font-mono">{restarts}↺</span>
      )}
    </span>
  )
}

// ─── Log line rendering ───────────────────────────────────────────────────────

const FREE5GC_LOG_RE = /^(\S+Z)\s+\[(\w+)\]\[(\w+)\]\[([^\]]+)\](?:\[[^\]]+\])*\s+(.*)$/

const LOG_LEVEL_COLORS: Record<string, string> = {
  INFO: '#56b6c2', DEBU: '#abb2bf', TRAC: '#5c6370', WARN: '#e5c07b', ERRO: '#e06c75', FATAL: '#c678dd',
}

function cleanRaw(raw: string): string {
  // Strip ANSI codes first
  let s = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b/g, '')
  // Only strip Loki prefix when the line has two timestamps (Loki prefix + raw log timestamp)
  if (/^\S+Z\s+\d{4}-\d{2}-\d{2}T/.test(s)) {
    s = s.replace(/^\S+Z\s+/, '')
  }
  return s.trim()
}

function renderMessage(msg: string) {
  const parts = [] as Array<string | React.JSX.Element>
  const re = /(\w+)(=)(\S*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(msg)) !== null) {
    if (m.index > last) parts.push(msg.slice(last, m.index))
    parts.push(<span key={`k${m.index}`} style={{ color: '#61afef' }}>{m[1]}</span>)
    parts.push(<span key={`eq${m.index}`} style={{ color: '#abb2bf' }}>=</span>)
    parts.push(<span key={`v${m.index}`} style={{ color: '#98c379' }}>{m[3]}</span>)
    last = m.index + m[0].length
  }
  if (last < msg.length) parts.push(msg.slice(last))
  return <>{parts}</>
}

function renderLogLine(raw: string) {
  const clean = cleanRaw(raw)
  const m = FREE5GC_LOG_RE.exec(clean)
  if (!m) {
    if (import.meta.env.DEV) console.log('[SidePanel] unmatched line:', clean.slice(0, 80))
    return <span style={{ color: '#abb2bf' }}>{clean}</span>
  }
  const [, ts, level, component, subsystem, message] = m
  const lc = LOG_LEVEL_COLORS[level] ?? '#abb2bf'
  // Wrap in a default-color span so uncolored text in renderMessage never
  // inherits cyan or any other color from a parent element.
  return (
    <span style={{ color: '#abb2bf' }}>
      <span style={{ color: '#56b6c2' }}>{ts.slice(11, 23)}</span>
      {' '}
      <span style={{ color: lc }}>[{level}]</span>
      <span>[{component}]</span>
      <span>[{subsystem}]</span>
      {' '}
      {renderMessage(message)}
    </span>
  )
}

// ─── Single NF log column ─────────────────────────────────────────────────────
function NfLogColumn({
  node,
  onRemove,
}: {
  node: TopologyNode
  onRemove: () => void
}) {
  const logs = useLogs(node.namespace, node.podName, true)
  const parentRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [level, setLevel] = useState<LogLevel>('all')
  const lastAnimTs   = useRef(0)
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [animRange, setAnimRange] = useState<{ newIdx: number; batchStart: number } | null>(null)
  const prevLen      = useRef(0)

  const filtered = useMemo(() => {
    let lines = logs.lines
    if (level !== 'all') {
      lines = lines.filter(l => l.level === level || l.level === 'unknown')
    }
    if (search) {
      const s = search.toLowerCase()
      lines = lines.filter(l => l.raw.toLowerCase().includes(s))
    }
    return lines
  }, [logs.lines, level, search])

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 20,
  })

  // Auto-scroll to bottom
  useEffect(() => {
    if (logs.autoScroll && filtered.length > 0) {
      virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' })
    }
  }, [filtered.length, logs.autoScroll, virtualizer])

  // ── New-entry animation (100ms throttle) ──────────────────────────────────
  useEffect(() => {
    const newLen = filtered.length
    if (newLen > prevLen.current) {
      const now = Date.now()
      if (now - lastAnimTs.current >= 100) {
        clearTimeout(animTimerRef.current)
        setAnimRange({ newIdx: newLen - 1, batchStart: Math.max(prevLen.current, newLen - 4) })
        lastAnimTs.current = now
        animTimerRef.current = setTimeout(() => setAnimRange(null), 600)
      }
    }
    prevLen.current = newLen
  }, [filtered.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(animTimerRef.current), [])

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0 border-r border-border last:border-0">
      {/* Column header */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-bg-secondary border-b border-border shrink-0">
        <span className="text-xs font-mono font-semibold text-blue-400 flex-1 truncate">
          {node.displayName} <span className="text-slate-500">·</span>{' '}
          <span className="text-slate-400 font-normal">{node.podName}</span>
        </span>
        {logs.live ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#3fb950', fontWeight: 'bold', fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3fb950', animation: 'pulse 1s ease-in-out infinite', display: 'inline-block' }} />
            LIVE
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#6e7681', fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6e7681', display: 'inline-block' }} />
            CONNECTING
          </span>
        )}
        <button
          onClick={onRemove}
          className="text-slate-600 hover:text-slate-300 shrink-0"
        >
          <IconX className="w-3 h-3" />
        </button>
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-1 px-1.5 py-1 shrink-0" style={{ background: '#0d1117', borderBottom: '1px solid #30363d' }}>
        <input
          type="text"
          placeholder="filter…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-xs outline-none px-1.5 py-0.5"
          style={{ border: '1px solid #30363d', borderRadius: 4, color: '#f0f6fc' }}
          onFocus={e => (e.currentTarget.style.borderColor = '#58a6ff')}
          onBlur={e => (e.currentTarget.style.borderColor = '#30363d')}
        />
        <select
          value={level}
          onChange={e => setLevel(e.target.value as LogLevel)}
          className="text-xs outline-none px-1 py-0.5 shrink-0"
          style={{ border: '1px solid #30363d', borderRadius: 4, background: '#161b22', color: '#f0f6fc' }}
        >
          <option value="all">all</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>
      </div>

      {/* Log lines */}
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto overflow-x-auto"
        style={{ background: '#080c10', fontFamily: '"JetBrains Mono", "Cascadia Code", monospace', fontSize: 12 }}
        onMouseEnter={() => logs.setAutoScroll(false)}
        onMouseLeave={() => logs.setAutoScroll(true)}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(item => {
            const line = filtered[item.index]!
            return (
              <div
                key={item.key}
                className={
                  item.index === animRange?.newIdx
                    ? 'log-new'
                    : item.index >= (animRange?.batchStart ?? -1) && item.index < (animRange?.newIdx ?? -1)
                      ? 'log-new-batch'
                      : undefined
                }
                style={{
                  position: 'absolute',
                  top: item.start,
                  minWidth: '100%',
                  height: item.size,
                  lineHeight: 1.4,
                  padding: '2px 4px',
                  whiteSpace: 'nowrap',
                }}
              >
                {renderLogLine(line.raw)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Pod info section ─────────────────────────────────────────────────────────
function PodInfo({ node, ifaceMetrics, clusterInfo }: {
  node: TopologyNode
  ifaceMetrics: MetricsMap
  clusterInfo: ClusterInfo | undefined
}) {
  return (
    <div className="px-4 py-3 space-y-2 shrink-0 border-b border-border">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono text-base font-bold text-blue-400">{node.displayName}</span>
          <span className="text-slate-500 text-xs ml-2">{node.podName}</span>
        </div>
        <StatusBadge node={node} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className="text-slate-500">Node</span>
          <span className="text-slate-300 ml-2 font-mono">{node.nodeName || '—'}</span>
        </div>
        <div>
          <span className="text-slate-500">Age</span>
          <span className="text-slate-300 ml-2">{node.age}</span>
        </div>
        <div className="col-span-2">
          <span className="text-slate-500">Image</span>
          <span className="text-slate-400 ml-2 font-mono text-[10px] break-all">{node.image}</span>
        </div>
      </div>

      {/* Interfaces with live metrics */}
      {node.interfaces.length > 0 && (
        <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, lineHeight: 1.7 }}>
          {node.interfaces.map(iface => {
            const loading = !(iface.interface in ifaceMetrics)
            const m       = ifaceMetrics[iface.interface]
            const cni     = iface.isDefault
              ? (clusterInfo?.cniPrimary ?? '')
              : (clusterInfo?.cniSecondary ?? '')
            return (
              <div key={iface.interface} className="flex items-center gap-3 py-0.5 flex-wrap">
                <span style={{ color: iface.isDefault ? '#58a6ff' : '#3fb950', minWidth: 38 }}>
                  {iface.interface}
                </span>
                <span style={{ color: '#f0f6fc', minWidth: 126 }}>
                  {iface.ips[0] || '—'}
                </span>
                {loading ? (
                  <span style={{ color: '#6b7280' }}>—</span>
                ) : m ? (
                  <>
                    <span>
                      <span style={{ color: '#c9d1d9' }}>{m.throughputMbps.toFixed(1)}</span>
                      <span style={{ color: '#6b7280' }}> Mbps</span>
                    </span>
                    <span>
                      <span style={{ color: '#c9d1d9' }}>{Math.round(m.packetsPerSec)}</span>
                      <span style={{ color: '#6b7280' }}> pkt/s</span>
                    </span>
                    {m.isCilium && (
                    <span>
                      <span style={{ color: '#c9d1d9' }}>{m.dropRate.toFixed(1)}</span>
                      <span style={{ color: '#6b7280' }}>% drop</span>
                    </span>
                    )}
                  </>
                ) : (
                  <span style={{ color: '#6b7280' }}>—</span>
                )}
                {cni && <span style={{ color: '#6e7681' }}>{cni}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Main SidePanel ───────────────────────────────────────────────────────────
export default function SidePanel({ node, allNodes: _allNodes, onClose, onCaptureEdge: _onCaptureEdge, tabs, activeTabId, onTabSelect, onTabClose }: Props) {
  const [view, setView] = useState<'logs' | 'info'>('logs')

  // ── Interface metrics ──────────────────────────────────────────────────────
  const [ifaceMetrics, setIfaceMetrics] = useState<MetricsMap>({})

  const { data: clusterInfo } = useQuery<ClusterInfo>({
    queryKey: ['cluster-info'],
    queryFn: api.clusterInfo.get,
    staleTime: 300_000,
  })

  useEffect(() => { setIfaceMetrics({}) }, [node.id])

  useEffect(() => {
    if (node.interfaces.length === 0) return
    const podName = node.podName
    const ifaces  = node.interfaces
    const fetchAll = () =>
      Promise.all(
        ifaces.map(iface =>
          api.metrics.interfaceMetrics(podName, iface.interface)
            .then(m  => [iface.interface, m]    as const)
            .catch(() => [iface.interface, null] as const),
        ),
      ).then(entries => setIfaceMetrics(Object.fromEntries(entries)))
    fetchAll()
    const id = setInterval(fetchAll, METRICS_REFRESH_MS)
    return () => clearInterval(id)
  }, [node.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full bg-bg-card border-l border-border animate-slide-in-right">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary shrink-0">
        <span className="text-sm font-semibold text-slate-200 flex-1">NF Detail</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView('logs')}
            className={clsx('text-xs px-2 py-0.5 rounded', view === 'logs' ? 'bg-blue-600/20 text-blue-400' : 'text-slate-500 hover:text-slate-300')}
          >
            Logs
          </button>
          <button
            onClick={() => setView('info')}
            className={clsx('text-xs px-2 py-0.5 rounded', view === 'info' ? 'bg-blue-600/20 text-blue-400' : 'text-slate-500 hover:text-slate-300')}
          >
            Info
          </button>
        </div>
        <button onClick={onClose} className="text-slate-600 hover:text-slate-300">
          <IconX className="w-4 h-4" />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex items-center border-b border-[#30363d] shrink-0 overflow-x-auto" style={{ background: '#161b22' }}>
        {tabs.map(t => (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            onClick={() => onTabSelect(t.id)}
            onKeyDown={e => e.key === 'Enter' && onTabSelect(t.id)}
            className="group relative flex items-center gap-1.5 px-3 py-2 cursor-pointer border-r border-[#30363d] shrink-0"
            style={{
              background: t.id === activeTabId ? '#1e3a5f' : undefined,
              borderBottom: `2px solid ${t.id === activeTabId ? '#58a6ff' : 'transparent'}`,
              color: t.id === activeTabId ? '#f0f6fc' : '#8b949e',
            }}
            onMouseEnter={e => { if (t.id !== activeTabId) (e.currentTarget as HTMLElement).style.background = '#1c2128' }}
            onMouseLeave={e => { if (t.id !== activeTabId) (e.currentTarget as HTMLElement).style.background = '' }}
          >
            <span className="text-xs font-mono whitespace-nowrap">{t.node.displayName}</span>
            <button
              onClick={e => { e.stopPropagation(); onTabClose(t.id) }}
              tabIndex={-1}
              className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 text-[#8b949e] hover:text-[#ef4444]"
            >
              <IconX className="w-2.5 h-2.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Pod info */}
      <PodInfo node={node} ifaceMetrics={ifaceMetrics} clusterInfo={clusterInfo} />

      {view === 'info' ? (
        /* Extended info view */
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs">
          <div>
            <div className="label mb-1">Labels</div>
            {Object.entries(node.labels).map(([k, v]) => (
              <div key={k} className="font-mono text-slate-400">
                <span className="text-blue-400">{k}</span>
                <span className="text-slate-600">=</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Logs view: single column for active tab */
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <NfLogColumn key={node.id} node={node} onRemove={() => onTabClose(node.id)} />
        </div>
      )}
    </div>
  )
}
