import { useState, useCallback, useRef, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import TopologyCanvas from '@/components/Topology/TopologyCanvas'
import SidePanel from '@/components/Topology/SidePanel'
import { TopologySkeleton } from '@/components/common/LoadingSkeleton'
import { useToast } from '@/components/common/Toast'
import { IconRefresh } from '@/components/common/icons'
import { useTopology } from '@/hooks/useTopology'
import type { TopologyOutletContext } from '@/components/common/Layout'
import type { TopologyNode, TopologyEdge } from '@/types/topology'

interface NfTab {
  id: string
  node: TopologyNode
  view: 'logs' | 'info'
}

const METRICS_REFRESH_MS = 300

const SIDE_MIN = 400
const SIDE_MAX = 1600
const SIDE_DEFAULT = 800

// Clear any previously-cached zero/invalid values so stale bad data doesn't persist.
;['coach5g-sidepanel-width'].forEach(k => {
  const raw = localStorage.getItem(k)
  if (raw !== null && (Number(raw) <= 0 || isNaN(Number(raw)))) localStorage.removeItem(k)
})

function getSaved(key: string, def: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return def
    const v = Number(raw)
    return (isNaN(v) || v <= 0) ? def : v
  } catch { return def }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  const [nfTabs, setNfTabs] = useState<NfTab[]>([])
  const [activeNfTabId, setActiveNfTabId] = useState<string | null>(null)
  const [sidePanelOpen, setSidePanelOpen] = useState(false)
  const [sideWidth,   setSideWidth]   = useState(() => getSaved('coach5g-sidepanel-width', SIDE_DEFAULT))
  const { push } = useToast()
  const { openExecTab } = useOutletContext<TopologyOutletContext>()

  // ── Side panel drag ────────────────────────────────────────────────────────
  // DOM-direct updates during drag — setSideWidth called once on mouseup only.
  const sideCurrentWidthRef   = useRef(getSaved('coach5g-sidepanel-width', SIDE_DEFAULT))
  const sidePanelContainerRef = useRef<HTMLDivElement>(null)
  const sideDragStart         = useRef<{ x: number; w: number } | null>(null)

  // Keep ref in sync when state changes externally (e.g. node click sets 800px)
  useEffect(() => { sideCurrentWidthRef.current = sideWidth }, [sideWidth])

  const onSideMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    sideDragStart.current = { x: e.clientX, w: sideCurrentWidthRef.current }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sideDragStart.current) return
      const delta = sideDragStart.current.x - e.clientX   // dragging left handle: move left → wider
      const next  = Math.min(SIDE_MAX, Math.max(SIDE_MIN, sideDragStart.current.w + delta))
      sideCurrentWidthRef.current = next
      if (sidePanelContainerRef.current) sidePanelContainerRef.current.style.width = next + 'px'
    }
    const onUp = () => {
      if (!sideDragStart.current) return
      const w = sideCurrentWidthRef.current
      try { localStorage.setItem('coach5g-sidepanel-width', String(w)) } catch { /* ok */ }
      sideDragStart.current = null
      setSideWidth(w)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const { data: graph, isLoading, isError, refetch } = useTopology()

  // ── Active traffic polling ─────────────────────────────────────────────────
  const [trafficEdgeIds, setTrafficEdgeIds] = useState(new Set<string>())

  useEffect(() => {
    const id = setInterval(() => {
      fetch('/api/metrics/active')
        .then(r => r.json() as Promise<{ active: { pod: string; iface: string }[] }>)
        .then(({ active }) => {
          const set = new Set<string>()
          if (!graph) { setTrafficEdgeIds(set); return }
          for (const { pod, iface } of active) {
            for (const edge of graph.edges) {
              if (edge.interface === iface &&
                  graph.nodes.find(n => n.id === edge.source)?.podName === pod) {
                set.add(edge.id)
              }
            }
          }
          // N1 (wireless arcs): activate when any interface on the gNB pod is active
          const activePods = new Set(active.map(p => p.pod))
          for (const edge of graph.edges) {
            if (edge.interface === 'n1') {
              const srcPod = graph.nodes.find(n => n.id === edge.source)?.podName
              const dstPod = graph.nodes.find(n => n.id === edge.target)?.podName
              if ((srcPod && activePods.has(srcPod)) || (dstPod && activePods.has(dstPod))) {
                set.add(edge.id)
              }
            }
          }
          setTrafficEdgeIds(set)
        })
        .catch(() => {})
    }, METRICS_REFRESH_MS)
    return () => clearInterval(id)
  }, [graph])

  // Namespace display — derived from the API response, display-only.
  const displayNS   = graph?.namespaces ?? []
  const nsHeading   = displayNS.length > 1 ? 'Namespaces' : 'Namespace'
  const nsDisplay   = displayNS.length > 0 ? displayNS.join(' · ') : '—'
  // First namespace used for the TopologyCanvas localStorage position key.
  const canvasNS    = displayNS[0] ?? ''

  const handleNodeClick = useCallback((clickedNode: TopologyNode) => {
    // DN nodes are synthetic (no backing pod, containers, or interfaces -- see
    // topology.go's buildDNNodes), so SidePanel/Shell/logs would either show
    // an empty panel or, for Shell, attempt a guaranteed-to-fail exec call.
    if (clickedNode.nfType === 'DN') return
    setNfTabs(prev => {
      if (prev.find(t => t.id === clickedNode.id)) return prev
      return [...prev, { id: clickedNode.id, node: clickedNode, view: 'logs' }]
    })
    setActiveNfTabId(clickedNode.id)
    setSidePanelOpen(true)
    setSideWidth(800)
  }, [])

  const handleTabClose = useCallback((closedId: string) => {
    const remaining = nfTabs.filter(t => t.id !== closedId)
    setNfTabs(remaining)
    if (remaining.length === 0) {
      setSidePanelOpen(false)
      setActiveNfTabId(null)
    } else if (activeNfTabId === closedId) {
      setActiveNfTabId(remaining[remaining.length - 1].id)
    }
  }, [nfTabs, activeNfTabId])

  const handleEdgeClick = useCallback((edge: TopologyEdge, sourceNode: TopologyNode) => {
    push('info', `${edge.label || edge.interface}: ${sourceNode.displayName} → capture coming soon`)
  }, [push])

  const handleClosePanel = useCallback(() => {
    setSidePanelOpen(false)
    setNfTabs([])
    setActiveNfTabId(null)
  }, [])

  const activeNode = nfTabs.find(t => t.id === activeNfTabId)?.node ?? null

  const liveIndicator = !isLoading && !isError && !!graph


  return (
    <div className="flex flex-col h-full" style={{ background: '#0d1117' }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-3 px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid #30363d', background: '#161b22' }}
      >
        <span className="text-xs shrink-0" style={{ color: '#8b949e' }}>{nsHeading}</span>
        <span
          className="rounded px-2 py-1 text-sm font-mono"
          style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3' }}
        >
          {nsDisplay}
        </span>

        <div className="flex-1" />

        {/* Live indicator */}
        {liveIndicator ? (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            border: '1px solid #3fb950', borderRadius: 4,
            padding: '3px 10px', background: 'rgba(63,185,80,0.08)',
          }}>
            <div style={{ position: 'relative', width: 10, height: 10 }}>
              <div style={{
                position: 'absolute', inset: 0,
                borderRadius: '50%', border: '2px solid #3fb950',
                animation: 'ripple 1.5s ease-out infinite',
              }} />
              <div style={{
                position: 'absolute', inset: '2px',
                borderRadius: '50%', background: '#3fb950',
              }} />
            </div>
            <span style={{ color: '#3fb950', fontWeight: 'bold', fontSize: 13, letterSpacing: '0.05em' }}>LIVE</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="w-2 h-2 rounded-full" style={{ background: '#30363d' }} />
            <span style={{ color: '#8b949e' }}>loading</span>
          </div>
        )}

        <button
          onClick={() => refetch()}
          className="p-1.5 rounded"
          style={{ border: '1px solid #30363d', background: '#0d1117', color: '#8b949e' }}
          title="Refresh"
        >
          <IconRefresh className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Canvas */}
        <div className="flex-1 min-w-0 relative">
          {isLoading ? (
            <TopologySkeleton />
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: '#8b949e' }}>
              <span style={{ color: '#f85149' }}>Failed to load topology</span>
              <button
                onClick={() => refetch()}
                className="px-3 py-1 rounded text-xs"
                style={{ border: '1px solid #30363d', background: '#161b22', color: '#e6edf3' }}
              >
                Retry
              </button>
            </div>
          ) : !graph || graph.nodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: '#8b949e' }}>
              <span className="text-4xl opacity-30">⬡</span>
              <span>No NFs found in <strong style={{ color: '#e6edf3' }}>{nsDisplay}</strong></span>
              <span className="text-xs">Waiting for pods to come online…</span>
            </div>
          ) : (
            <TopologyCanvas
              graph={graph}
              onNodeClick={handleNodeClick}
              onEdgeClick={handleEdgeClick}
              selectedNodeId={activeNfTabId ?? undefined}
              namespace={canvasNS}
              sidePanelOpen={sidePanelOpen}
              trafficEdgeIds={trafficEdgeIds}
            />
          )}
        </div>

        {/* Side panel with drag handle — always visible when graph is loaded */}
        {sidePanelOpen && graph && (
          <div
            ref={sidePanelContainerRef}
            className="shrink-0 h-full flex"
            style={{ width: sideWidth, borderLeft: '1px solid #30363d' }}
          >
            {/* Drag handle — left border */}
            <div
              onMouseDown={onSideMouseDown}
              className="w-1 shrink-0 cursor-ew-resize transition-colors"
              style={{ background: '#30363d' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#58a6ff' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#30363d' }}
            />
            <div className="flex-1 min-w-0 h-full overflow-hidden">
              {activeNode ? (
                <SidePanel
                  node={activeNode}
                  allNodes={graph.nodes}
                  onClose={handleClosePanel}
                  tabs={nfTabs}
                  activeTabId={activeNfTabId}
                  onTabSelect={(id) => setActiveNfTabId(id)}
                  onTabClose={handleTabClose}
                  onOpenShell={openExecTab}
                />
              ) : (
                <div className="flex flex-col h-full" style={{ background: '#0d1117' }}>
                  <div className="flex items-center gap-2 px-3 py-2 shrink-0"
                    style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>
                    <span className="text-sm font-semibold flex-1" style={{ color: '#e6edf3' }}>NF Detail</span>
                    <div className="flex items-center gap-1">
                      <span className="text-xs px-2 py-0.5 rounded"
                        style={{ color: '#58a6ff', background: 'rgba(31,111,235,0.12)' }}>Logs</span>
                      <span className="text-xs px-2 py-0.5 rounded" style={{ color: '#6e7681' }}>Info</span>
                    </div>
                  </div>
                  <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: '#6e7681' }}>
                    <span className="text-3xl opacity-20">◫</span>
                    <span className="text-xs text-center px-4">Select an NF to view logs</span>
                    <span className="text-[10px] text-center px-6" style={{ color: '#30363d' }}>
                      Click a node in the topology canvas
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
