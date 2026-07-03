import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import CapturePage, { type CaptureTab } from '@/pages/CapturePage'
import type { TopologyGraph } from '@/types/topology'

const NAV_LINKS = [
  { to: '/',               label: 'Topology'       },
  { to: '/captures',       label: 'Captures'       },
  { to: '/infrastructure', label: 'Infrastructure' },
]

export default function Layout() {
  const location                  = useLocation()
  const [searchParams]            = useSearchParams()
  const isCaptures                = location.pathname.startsWith('/captures')
  const queryClient               = useQueryClient()

  const [captureTabs,  setCaptureTabs]  = useState<CaptureTab[]>([])
  const [activeTabId,  setActiveTabId]  = useState<string | null>(null)
  const [splitMode,    setSplitMode]    = useState(false)

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
          <svg className="w-6 h-6" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="6" fill="none" stroke="#3b82f6" strokeWidth="2"/>
            <circle cx="16" cy="8"  r="2.5" fill="#22c55e"/>
            <circle cx="22" cy="12" r="2.5" fill="#f97316"/>
            <circle cx="22" cy="20" r="2.5" fill="#a855f7"/>
            <circle cx="16" cy="24" r="2.5" fill="#22c55e"/>
            <circle cx="10" cy="20" r="2.5" fill="#3b82f6"/>
            <circle cx="10" cy="12" r="2.5" fill="#3b82f6"/>
            <line x1="16" y1="10.5" x2="16" y2="14"   stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="20" y1="13"   x2="18" y2="14.5" stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="20" y1="19"   x2="18" y2="17.5" stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="16" y1="21.5" x2="16" y2="18"   stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="12" y1="19"   x2="14" y2="17.5" stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="12" y1="13"   x2="14" y2="14.5" stroke="#3b82f6" strokeWidth="1.5"/>
          </svg>
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
          <Outlet />
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
    </div>
  )
}
