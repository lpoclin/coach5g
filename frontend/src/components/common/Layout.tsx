import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import CapturePage, { type CaptureTab } from '@/pages/CapturePage'
import TerminalPanel, { type TerminalPanelHandle } from '@/components/Terminal/TerminalPanel'
import type { TopologyGraph } from '@/types/topology'

const NAV_LINKS = [
  { to: '/',               label: 'Topology'       },
  { to: '/captures',       label: 'Captures'       },
  { to: '/infrastructure', label: 'Infrastructure' },
]

const TERM_MIN = 150
const TERM_MAX = 500
const TERM_DEFAULT = 200

function getSavedTermHeight(): number {
  try {
    const raw = localStorage.getItem('coach5g-terminal-height')
    if (raw === null) return TERM_DEFAULT
    const v = Number(raw)
    return (isNaN(v) || v <= 0) ? TERM_DEFAULT : v
  } catch { return TERM_DEFAULT }
}

// Addition 4 -- shape of the context Layout exposes to its routed child
// (TopologyPage/SidePanel) via react-router's useOutletContext(), so the
// "Shell" button can reach the terminal panel that now lives up here.
// See docs/TERMINAL_PANEL_HOISTING_ASSESSMENT.md.
export interface TopologyOutletContext {
  openExecTab: (namespace: string, pod: string, container: string, label: string) => void
}

export default function Layout() {
  const location                  = useLocation()
  const [searchParams]            = useSearchParams()
  const isCaptures                = location.pathname.startsWith('/captures')
  const isTopology                = location.pathname === '/'
  const queryClient               = useQueryClient()

  const [captureTabs,  setCaptureTabs]  = useState<CaptureTab[]>([])
  const [activeTabId,  setActiveTabId]  = useState<string | null>(null)
  const [splitMode,    setSplitMode]    = useState(false)

  // ── Terminal panel (hoisted from TopologyPage) ────────────────────────────
  // Lifted here so SSH/exec sessions survive route changes -- see
  // docs/TERMINAL_PANEL_HOISTING_ASSESSMENT.md. Stays mounted at all times;
  // visible only when isTopology (below), fully display:none'd elsewhere
  // without resetting termOpen, tabs, or height.
  const [termOpen,   setTermOpen]   = useState(true)
  const [termHeight, setTermHeight] = useState(getSavedTermHeight)
  const termCurrentHeightRef = useRef(getSavedTermHeight())
  const terminalBodyRef      = useRef<HTMLDivElement>(null)
  const termDragStart        = useRef<{ y: number; h: number } | null>(null)
  const terminalPanelRef     = useRef<TerminalPanelHandle>(null)

  const onTermMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    termDragStart.current = { y: e.clientY, h: termCurrentHeightRef.current }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!termDragStart.current) return
      const delta = termDragStart.current.y - e.clientY   // drag up → taller
      const next  = Math.min(TERM_MAX, Math.max(TERM_MIN, termDragStart.current.h + delta))
      termCurrentHeightRef.current = next
      if (terminalBodyRef.current) terminalBodyRef.current.style.height = next + 'px'
    }
    const onUp = () => {
      if (!termDragStart.current) return
      const h = termCurrentHeightRef.current
      try { localStorage.setItem('coach5g-terminal-height', String(h)) } catch { /* ok */ }
      termDragStart.current = null
      setTermHeight(h)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  // Addition 4 -- "Shell" button (SidePanel, reached via useOutletContext)
  // opens an exec tab in this terminal panel, forcing it open if collapsed.
  const openExecTab = useCallback((namespace: string, pod: string, container: string, label: string) => {
    if (!termOpen) setTermOpen(true)
    terminalPanelRef.current?.openExecTab({ namespace, pod, container }, label)
  }, [termOpen])

  const addTab = useCallback((pod: string, iface: string) => {
    setCaptureTabs(prev => {
      const existing = prev.find(t => t.pod === pod && t.iface === iface)
      if (existing) {
        setActiveTabId(existing.id)
        return prev
      }
      if (prev.length >= 8) return prev
      const id       = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const topology = queryClient.getQueryData<TopologyGraph>(['topology'])
      const node     = topology?.nodes?.find(n => n.podName === pod)
      const podDisplay = node?.displayName
        ?? pod.split('-')
             .filter((s: string) => !/^[0-9a-f]{5,}$/.test(s))
             .slice(0, 2)
             .join('-')
      const tab: CaptureTab = { id, pod, podDisplay, iface }
      setActiveTabId(id)
      return [...prev, tab]
    })
  }, [queryClient])

  // Open a tab when navigating to /captures?pod=X&interface=Y
  useEffect(() => {
    if (!isCaptures) return
    const pod   = searchParams.get('pod')
    const iface = searchParams.get('interface') ?? 'eth0'
    if (pod) addTab(pod, iface)
  }, [isCaptures, searchParams.get('pod'), searchParams.get('interface')]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg-primary">
      {/* Top navigation */}
      <header className="flex items-center gap-6 px-4 h-11 border-b border-border bg-bg-secondary shrink-0 z-20">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-2">
          <img src="/favicon.svg" alt="" className="w-6 h-6" />
          <span className="font-mono text-sm font-bold text-slate-100 tracking-tight select-none">
            COACH5G
          </span>
        </div>

        {/* Nav links */}
        <nav className="flex items-center gap-1">
          {NAV_LINKS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                clsx(
                  'px-3 py-1 rounded text-sm font-medium transition-colors duration-100',
                  isActive
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-600/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-bg-hover',
                )
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="flex-1" />
        <span className="text-xs text-slate-600 font-mono select-none">v0.1.0</span>
      </header>

      {/* Page content */}
      <main className="flex-1 overflow-hidden">
        {/* Topology / Infrastructure pages — hidden while on /captures */}
        <div style={{ display: isCaptures ? 'none' : 'flex', flexDirection: 'column', height: '100%' }}>
          <Outlet context={{ openExecTab }} />
        </div>

        {/* Captures — always mounted so WebSocket connections stay alive */}
        <div style={{ display: isCaptures ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
          <CapturePage
            tabs={captureTabs}
            activeTabId={activeTabId}
            splitMode={splitMode}
            onTabsChange={setCaptureTabs}
            onActiveTabChange={setActiveTabId}
            onSplitModeChange={setSplitMode}
          />
        </div>
      </main>

      {/* Terminal panel — always mounted so SSH/exec sessions survive route
          changes; visible only on / (Topology), fully display:none'd (never
          unmounted) on every other route so it never competes for space with
          /captures or /infrastructure. See
          docs/TERMINAL_PANEL_HOISTING_ASSESSMENT.md. */}
      <div className="shrink-0" style={{ display: isTopology ? 'block' : 'none' }}>
        {termOpen && (
          <div
            onMouseDown={onTermMouseDown}
            className="w-full cursor-ns-resize transition-colors"
            style={{ height: 4, background: '#30363d' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#58a6ff' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#30363d' }}
          />
        )}
        <TerminalPanel
          ref={terminalPanelRef}
          open={termOpen}
          onToggle={() => { if (isTopology) setTermOpen(v => !v) }}
          height={termHeight}
          bodyRef={terminalBodyRef}
        />
      </div>
    </div>
  )
}
