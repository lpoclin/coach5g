import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const SSH_HOST = '192.168.18.210'
const DEFAULT_USER = 'unmsm'

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // In dev (Vite proxy or direct), api runs on port 8080
  const host = import.meta.env.DEV
    ? `${location.hostname}:8080`
    : location.host
  return `${proto}://${host}/ws/terminal`
}

// Addition 4 -- exec-per-pod terminal (GET /ws/exec/:namespace/:pod/:container).
// No login step: Kubernetes RBAC on the dedicated exec-only ServiceAccount is
// the sole authorization boundary, so the client just connects and streams.
// See docs/RISK_ASSESSMENT_ADDITIONS.md Addition 4 and
// docs/EXEC_IDENTITY_ASSESSMENT.md.
function execWsUrl(namespace: string, pod: string, container: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const host = import.meta.env.DEV
    ? `${location.hostname}:8080`
    : location.host
  return `${proto}://${host}/ws/exec/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/${encodeURIComponent(container)}`
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnState = 'login' | 'connecting' | 'connected' | 'error'

interface ExecTarget {
  namespace: string
  pod: string
  container: string
}

interface TabDef {
  id: number
  label: string
  connected: boolean
  kind: 'ssh' | 'exec'
  exec?: ExecTarget
}

export interface TerminalPanelHandle {
  openExecTab: (target: ExecTarget, label: string) => void
}

let _nextId = 1

// ─── TerminalInstance ─────────────────────────────────────────────────────────
// Each tab owns a single TerminalInstance. It manages its own WS connection,
// login state, and xterm lifecycle.

interface InstanceProps {
  tabId: number
  active: boolean
  panelOpen: boolean
  onConnected: (id: number) => void
  onDisconnected: (id: number) => void
}

function TerminalInstance({ tabId, active, panelOpen, onConnected, onDisconnected }: InstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const mountedRef = useRef(false)

  const [connState, setConnState] = useState<ConnState>('login')
  const [host, setHost] = useState(SSH_HOST)
  const [username, setUsername] = useState(DEFAULT_USER)
  const [password, setPassword] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  // ── Mount / unmount xterm when state reaches 'connected' ──────────────────
  useEffect(() => {
    if (connState !== 'connected' || !containerRef.current || mountedRef.current) return
    mountedRef.current = true

    const term = new Terminal({
      theme: {
        background:         '#0d1117',
        foreground:         '#f0f6fc',
        cursor:             '#58a6ff',
        cursorAccent:       '#0d1117',
        selectionBackground:'#264f78',
        black:   '#0d1117', red:     '#ff7b72', green:  '#3fb950', yellow: '#d29922',
        blue:    '#58a6ff', magenta: '#bc8cff', cyan:   '#39c5cf', white:  '#b1bac4',
        brightBlack:   '#6e7681', brightRed:     '#ffa198', brightGreen:  '#56d364',
        brightYellow:  '#e3b341', brightBlue:    '#79c0ff', brightMagenta:'#d2a8ff',
        brightCyan:    '#56d4dd', brightWhite:   '#f0f6fc',
      },
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace',
      fontSize:   13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback:  5000,
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current  = fit

    // Route keystrokes → WebSocket
    term.onData(data => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }))
      }
    })

    if (active && panelOpen) {
      requestAnimationFrame(() => fit.fit())
    }

    return () => {
      term.dispose()
      termRef.current  = null
      fitRef.current   = null
      mountedRef.current = false
    }
  }, [connState]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Resize when tab becomes active or panel opens ─────────────────────────
  useEffect(() => {
    if (!active || !panelOpen || !fitRef.current || !termRef.current) return
    const t = setTimeout(() => {
      fitRef.current?.fit()
      sendResize()
    }, 40)
    return () => clearTimeout(t)
  }, [active, panelOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── ResizeObserver on container ───────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current || !active) return
      fitRef.current.fit()
      sendResize()
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [active, connState]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cleanup WS on unmount ─────────────────────────────────────────────────
  useEffect(() => () => { wsRef.current?.close() }, [])

  function sendResize() {
    const term = termRef.current
    const ws   = wsRef.current
    if (!term || ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }

  const connect = useCallback(() => {
    if (!password) return
    setConnState('connecting')
    setErrorMsg('')

    const url = wsUrl()
    const ws = new WebSocket(url)
    wsRef.current = ws

    const user = username
    const pass = password
    setPassword('')  // wipe from React state immediately

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', host, user, password: pass }))
    }

    ws.onmessage = (ev) => {
      const msg: { type: string; data?: string; message?: string } = JSON.parse(ev.data)
      switch (msg.type) {
        case 'auth_ok':
          setConnState('connected')
          onConnected(tabId)
          break
        case 'auth_fail':
          setConnState('error')
          setErrorMsg(msg.message ?? 'Authentication failed')
          ws.close()
          break
        case 'output':
          termRef.current?.write(msg.data ?? '')
          break
      }
    }

    ws.onerror = () => {
      setConnState('error')
      setErrorMsg('WebSocket connection failed')
    }

    ws.onclose = () => {
      if (connState === 'connected' || mountedRef.current) {
        termRef.current?.write('\r\n\x1b[2m[session closed]\x1b[0m\r\n')
        onDisconnected(tabId)
      }
    }
  }, [host, username, password, tabId, onConnected, onDisconnected, connState])

  // ── Login / error form ─────────────────────────────────────────────────────
  if (connState !== 'connected' && connState !== 'connecting') {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: '#0d1117' }}>
        <div className="w-64 space-y-3">
          <p className="text-center text-[11px] font-mono" style={{ color: '#8b949e' }}>
            SSH — {host}
          </p>

          {errorMsg && (
            <p className="text-center text-[11px] px-3 py-1.5 rounded"
               style={{ color: '#f85149', background: '#1a0a0a', border: '1px solid #3d1a1a' }}>
              {errorMsg}
            </p>
          )}

          <div className="space-y-2">
            {/* Host */}
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-0.5" style={{ color: '#6e7681' }}>
                Host
              </label>
              <input
                value={host}
                onChange={e => setHost(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="w-full px-2 py-1 rounded text-xs font-mono outline-none"
                style={{
                  background: '#0d1117',
                  border: '1px solid #30363d',
                  color: '#e6edf3',
                }}
                onFocus={e => { e.target.style.borderColor = '#388bfd' }}
                onBlur={e => { e.target.style.borderColor = '#30363d' }}
              />
            </div>

            {/* Username */}
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-0.5" style={{ color: '#6e7681' }}>
                Username
              </label>
              <input
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                spellCheck={false}
                className="w-full px-2 py-1 rounded text-xs font-mono outline-none"
                style={{
                  background: '#0d1117',
                  border: '1px solid #30363d',
                  color: '#e6edf3',
                }}
                onFocus={e => { e.target.style.borderColor = '#388bfd' }}
                onBlur={e => { e.target.style.borderColor = '#30363d' }}
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-0.5" style={{ color: '#6e7681' }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') connect() }}
                autoComplete="current-password"
                className="w-full px-2 py-1 rounded text-xs font-mono outline-none"
                style={{
                  background: '#0d1117',
                  border: '1px solid #30363d',
                  color: '#e6edf3',
                }}
                onFocus={e => { e.target.style.borderColor = '#388bfd' }}
                onBlur={e => { e.target.style.borderColor = '#30363d' }}
              />
            </div>
          </div>

          <button
            onClick={connect}
            disabled={!host || !password || !username}
            className="w-full py-1.5 rounded text-xs font-mono transition-colors"
            style={{
              background: (!host || !password || !username) ? '#161b22' : '#1f6feb',
              border: '1px solid #30363d',
              color: (!host || !password || !username) ? '#6e7681' : '#f0f6fc',
              cursor: (!host || !password || !username) ? 'not-allowed' : 'pointer',
            }}
          >
            Connect
          </button>
        </div>
      </div>
    )
  }

  if (connState === 'connecting') {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: '#0d1117' }}>
        <span className="text-xs font-mono animate-pulse" style={{ color: '#8b949e' }}>
          Connecting to {host}…
        </span>
      </div>
    )
  }

  // connected — xterm mount target (always in DOM once connected)
  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ background: '#0d1117', padding: '2px 4px' }}
    />
  )
}

// ─── ExecInstance ─────────────────────────────────────────────────────────────
// Kubernetes-exec counterpart to TerminalInstance. Same always-mounted,
// visibility-toggled lifecycle -- the tab body stays in the DOM (hidden, not
// unmounted) so the WebSocket survives switching tabs. Unlike SSH, there is
// no login form: the connection opens immediately and Kubernetes RBAC on the
// dedicated exec-only ServiceAccount is the sole authorization boundary
// (see docs/EXEC_IDENTITY_ASSESSMENT.md).

interface ExecInstanceProps {
  tabId: number
  active: boolean
  panelOpen: boolean
  target: ExecTarget
  onConnected: (id: number) => void
  onDisconnected: (id: number) => void
}

function ExecInstance({ tabId, active, panelOpen, target, onConnected, onDisconnected }: ExecInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const mountedRef = useRef(false)
  const connectedOnceRef = useRef(false)

  const [connState, setConnState] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [errorMsg, setErrorMsg] = useState('')

  // ── Mount / unmount xterm when state reaches 'connected' ──────────────────
  useEffect(() => {
    if (connState !== 'connected' || !containerRef.current || mountedRef.current) return
    mountedRef.current = true

    const term = new Terminal({
      theme: {
        background:         '#0d1117',
        foreground:         '#f0f6fc',
        cursor:             '#58a6ff',
        cursorAccent:       '#0d1117',
        selectionBackground:'#264f78',
        black:   '#0d1117', red:     '#ff7b72', green:  '#3fb950', yellow: '#d29922',
        blue:    '#58a6ff', magenta: '#bc8cff', cyan:   '#39c5cf', white:  '#b1bac4',
        brightBlack:   '#6e7681', brightRed:     '#ffa198', brightGreen:  '#56d364',
        brightYellow:  '#e3b341', brightBlue:    '#79c0ff', brightMagenta:'#d2a8ff',
        brightCyan:    '#56d4dd', brightWhite:   '#f0f6fc',
      },
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace',
      fontSize:   13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback:  5000,
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current  = fit

    term.onData(data => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }))
      }
    })

    if (active && panelOpen) {
      requestAnimationFrame(() => fit.fit())
    }

    return () => {
      term.dispose()
      termRef.current  = null
      fitRef.current   = null
      mountedRef.current = false
    }
  }, [connState]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Resize when tab becomes active or panel opens ─────────────────────────
  useEffect(() => {
    if (!active || !panelOpen || !fitRef.current || !termRef.current) return
    const t = setTimeout(() => {
      fitRef.current?.fit()
      sendResize()
    }, 40)
    return () => clearTimeout(t)
  }, [active, panelOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── ResizeObserver on container ───────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current || !active) return
      fitRef.current.fit()
      sendResize()
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [active, connState]) // eslint-disable-line react-hooks/exhaustive-deps

  function sendResize() {
    const term = termRef.current
    const ws   = wsRef.current
    if (!term || ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }

  // ── Connect immediately on mount (no login step) ───────────────────────────
  useEffect(() => {
    const ws = new WebSocket(execWsUrl(target.namespace, target.pod, target.container))
    wsRef.current = ws

    ws.onopen = () => {
      setConnState('connected')
      connectedOnceRef.current = true
      onConnected(tabId)
    }

    ws.onmessage = (ev) => {
      const msg: { type: string; data?: string } = JSON.parse(ev.data)
      if (msg.type === 'output') termRef.current?.write(msg.data ?? '')
    }

    ws.onerror = () => {
      if (!connectedOnceRef.current) {
        setConnState('error')
        setErrorMsg('WebSocket connection failed')
      }
    }

    ws.onclose = () => {
      if (connectedOnceRef.current) {
        termRef.current?.write('\r\n\x1b[2m[session closed]\x1b[0m\r\n')
        onDisconnected(tabId)
      } else {
        setConnState('error')
        setErrorMsg('Connection closed before session started')
      }
    }

    return () => { ws.close() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (connState === 'error') {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: '#0d1117' }}>
        <p className="text-center text-[11px] px-3 py-1.5 rounded font-mono"
           style={{ color: '#f85149', background: '#1a0a0a', border: '1px solid #3d1a1a' }}>
          {errorMsg}
        </p>
      </div>
    )
  }

  if (connState === 'connecting') {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: '#0d1117' }}>
        <span className="text-xs font-mono animate-pulse" style={{ color: '#8b949e' }}>
          Opening shell in {target.pod} ({target.container})…
        </span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ background: '#0d1117', padding: '2px 4px' }}
    />
  )
}

// ─── TerminalPanel ────────────────────────────────────────────────────────────

export interface TerminalPanelProps {
  open: boolean
  onToggle: () => void
  height?: number        // controlled by parent drag handle
  bodyRef?: React.RefObject<HTMLDivElement | null>  // for DOM-direct resize during drag
}

function TerminalPanel({ open, onToggle, height = 260, bodyRef }: TerminalPanelProps, ref: React.ForwardedRef<TerminalPanelHandle>) {
  const [tabs, setTabs] = useState<TabDef[]>([{ id: _nextId++, label: 'Terminal 1', connected: false, kind: 'ssh' }])
  const [activeId, setActiveId] = useState<number>(tabs[0].id)

  const addTab = useCallback(() => {
    const id = _nextId++
    const label = `Terminal ${id}`
    setTabs(prev => [...prev, { id, label, connected: false, kind: 'ssh' }])
    setActiveId(id)
    if (!open) onToggle()
  }, [open, onToggle])

  // Addition 4 -- opens a new exec tab targeting a specific pod/container.
  // No tab-count ceiling: same unbounded `tabs` array addTab above already
  // uses, so exec tabs are subject to the identical (lack of a) limit.
  const openExecTab = useCallback((target: ExecTarget, label: string) => {
    const id = _nextId++
    setTabs(prev => [...prev, { id, label, connected: false, kind: 'exec', exec: target }])
    setActiveId(id)
    if (!open) onToggle()
  }, [open, onToggle])

  useImperativeHandle(ref, () => ({ openExecTab }), [openExecTab])

  const closeTab = useCallback((id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setTabs(prev => {
      if (prev.length === 1) return prev  // keep at least one
      const next = prev.filter(t => t.id !== id)
      setActiveId(cur => cur === id ? (next.at(-1)?.id ?? next[0].id) : cur)
      return next
    })
  }, [])

  const handleConnected = useCallback((id: number) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, connected: true } : t))
  }, [])

  const handleDisconnected = useCallback((id: number) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, connected: false } : t))
  }, [])

  // ── Keyboard shortcut: Ctrl+` ─────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        onToggle()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onToggle])

  return (
    <div
      className="shrink-0 flex flex-col"
      style={{ background: '#0d1117' }}
    >
      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div
        className="flex items-center shrink-0 select-none"
        style={{
          height: 30,
          background: '#161b22',
          borderBottom: open ? '1px solid #30363d' : 'none',
        }}
      >
        {/* Tab list */}
        <div className="flex items-center flex-1 overflow-x-auto min-w-0 h-full">
          {tabs.map(tab => {
            const isActive = tab.id === activeId
            return (
              <button
                key={tab.id}
                onClick={() => { setActiveId(tab.id); if (!open) onToggle() }}
                className="flex items-center gap-1.5 px-3 h-full text-[11px] font-mono shrink-0 transition-colors"
                style={{
                  background:  isActive && open ? '#0d1117' : 'transparent',
                  borderRight: '1px solid #30363d',
                  color:       isActive && open ? '#e6edf3' : '#6e7681',
                }}
              >
                {/* Status dot */}
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: tab.connected ? '#3fb950' : '#6e7681' }}
                />
                {tab.label}
                {tabs.length > 1 && (
                  <span
                    onClick={e => closeTab(tab.id, e)}
                    className="ml-0.5 text-[10px] leading-none hover:text-red-400 transition-colors"
                    style={{ color: '#6e7681' }}
                  >
                    ×
                  </span>
                )}
              </button>
            )
          })}

          {/* New tab button */}
          <button
            onClick={addTab}
            className="px-2 h-full text-xs transition-colors"
            style={{ color: '#6e7681' }}
            onMouseEnter={e => { (e.target as HTMLElement).style.color = '#e6edf3' }}
            onMouseLeave={e => { (e.target as HTMLElement).style.color = '#6e7681' }}
            title="New terminal (Ctrl+`)"
          >
            +
          </button>
        </div>

        {/* Panel toggle */}
        <button
          onClick={onToggle}
          className="px-3 h-full text-xs transition-colors shrink-0"
          style={{ color: '#6e7681', borderLeft: '1px solid #30363d' }}
          onMouseEnter={e => { (e.target as HTMLElement).style.color = '#e6edf3' }}
          onMouseLeave={e => { (e.target as HTMLElement).style.color = '#6e7681' }}
          title={open ? 'Collapse (Ctrl+`)' : 'Expand (Ctrl+`)'}
          aria-label={open ? 'Collapse terminal panel' : 'Expand terminal panel'}
        >
          {open ? '▼' : '▲'}
        </button>
      </div>

      {/* ── Terminal body ───────────────────────────────────────────────────── */}
      {/* Always render TerminalInstances so WS connections survive tab switches */}
      <div ref={bodyRef} style={{ height: open ? height : 0, overflow: 'hidden', position: 'relative' }}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            style={{
              position:   'absolute',
              inset:      0,
              visibility: tab.id === activeId ? 'visible' : 'hidden',
            }}
          >
            {tab.kind === 'exec' && tab.exec ? (
              <ExecInstance
                tabId={tab.id}
                active={tab.id === activeId}
                panelOpen={open}
                target={tab.exec}
                onConnected={handleConnected}
                onDisconnected={handleDisconnected}
              />
            ) : (
              <TerminalInstance
                tabId={tab.id}
                active={tab.id === activeId}
                panelOpen={open}
                onConnected={handleConnected}
                onDisconnected={handleDisconnected}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default forwardRef(TerminalPanel)
