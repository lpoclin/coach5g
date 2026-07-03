import { useCallback, useEffect, useReducer, useRef } from 'react'
import { WSManager } from '@/services/websocket'

export interface LogLine {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug' | 'unknown'
  message: string
  raw: string
}

export type LogLevel = 'all' | 'info' | 'warn' | 'error' | 'debug'

const MAX_LINES = 2_000
const ANSI_RE   = /\x1b\[[0-9;]*m/g

// parseRawLine splits the Loki-prepended timestamp (ISO\tlog_line) and cleans ANSI codes.
function parseRawLine(raw: string): { timestamp: string; level: LogLine['level']; message: string } {
  let timestamp = ''
  let line = raw

  const tab = raw.indexOf('\t')
  if (tab > 0) {
    timestamp = raw.substring(0, tab)
    line      = raw.substring(tab + 1)
  }

  // Strip ANSI color codes from the log line
  const cleaned = line.replace(ANSI_RE, '')

  // Fallback: extract timestamp from log line content
  if (!timestamp) {
    try {
      const obj = JSON.parse(cleaned) as Record<string, unknown>
      const t = obj.time ?? obj.timestamp ?? obj.ts ?? obj['@timestamp']
      if (typeof t === 'string') timestamp = t
      else if (typeof t === 'number') timestamp = new Date(t * 1000).toISOString()
    } catch { /* not JSON */ }
    if (!timestamp) {
      const m = cleaned.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?[+-]?\d*)/)
      timestamp = m ? m[1] : new Date().toISOString()
    }
  }

  // Level detection — covers free5GC [INFO] [WARN] [ERRO] [DEBU] and structured formats
  const l = cleaned.toLowerCase()
  let level: LogLine['level'] = 'unknown'
  if (l.includes('[erro]') || l.includes('[error]') || l.includes('"level":"error"') || l.includes('level=error')) level = 'error'
  else if (l.includes('[warn]') || l.includes('"level":"warn"') || l.includes('level=warn')) level = 'warn'
  else if (l.includes('[debu]') || l.includes('[dbug]') || l.includes('"level":"debug"') || l.includes('level=debug')) level = 'debug'
  else if (l.includes('[info]') || l.includes('"level":"info"') || l.includes('level=info')) level = 'info'

  return { timestamp, level, message: cleaned }
}

interface LogState {
  lines: LogLine[]
  search: string
  level: LogLevel
  autoScroll: boolean
  showTimestamps: boolean
  live: boolean
}

type Action =
  | { type: 'APPEND'; lines: LogLine[] }
  | { type: 'CLEAR' }
  | { type: 'SET_SEARCH'; search: string }
  | { type: 'SET_LEVEL'; level: LogLevel }
  | { type: 'SET_AUTO_SCROLL'; value: boolean }
  | { type: 'TOGGLE_TIMESTAMPS' }
  | { type: 'SET_LIVE'; value: boolean }

function reducer(state: LogState, action: Action): LogState {
  switch (action.type) {
    case 'APPEND': {
      const merged = [...state.lines, ...action.lines]
      return { ...state, lines: merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged }
    }
    case 'CLEAR':
      return { ...state, lines: [] }
    case 'SET_SEARCH':
      return { ...state, search: action.search }
    case 'SET_LEVEL':
      return { ...state, level: action.level }
    case 'SET_AUTO_SCROLL':
      return { ...state, autoScroll: action.value }
    case 'TOGGLE_TIMESTAMPS':
      return { ...state, showTimestamps: !state.showTimestamps }
    case 'SET_LIVE':
      return { ...state, live: action.value }
    default:
      return state
  }
}

const initial: LogState = {
  lines: [],
  search: '',
  level: 'all',
  autoScroll: true,
  showTimestamps: true,
  live: false,
}

export function useLogs(namespace: string, podName: string, enabled = true) {
  const [state, dispatch] = useReducer(reducer, initial)
  const mgrRef = useRef<WSManager | null>(null)

  useEffect(() => {
    if (!enabled || !namespace || !podName) return
    dispatch({ type: 'CLEAR' })

    const url = `/ws/logs/${encodeURIComponent(namespace)}/${encodeURIComponent(podName)}`
    const mgr = new WSManager(url)
    mgrRef.current = mgr

    // WSManager dispatches env.data (string[]) when subscribed to a specific type.
    // Each string may have a Loki timestamp prefix: "ISO_TS\tlog_line"
    mgr.onStateChange = (connected) => dispatch({ type: 'SET_LIVE', value: connected })

    mgr.on<string[]>('log_lines', (lines) => {
      const parsed: LogLine[] = lines.map(r => {
        const { timestamp, level, message } = parseRawLine(r)
        return { timestamp, level, message, raw: r }
      })
      dispatch({ type: 'APPEND', lines: parsed })
    })

    mgr.connect()
    return () => {
      mgr.close()
      mgrRef.current = null
    }
  }, [namespace, podName, enabled])

  const getFiltered = useCallback((): LogLine[] => {
    let lines = state.lines
    if (state.level !== 'all') {
      lines = lines.filter(l => l.level === state.level || l.level === 'unknown')
    }
    if (state.search) {
      const s = state.search.toLowerCase()
      lines = lines.filter(l => l.raw.toLowerCase().includes(s))
    }
    return lines
  }, [state.lines, state.level, state.search])

  return {
    lines: state.lines,
    getFiltered,
    search: state.search,
    level: state.level,
    autoScroll: state.autoScroll,
    showTimestamps: state.showTimestamps,
    live: state.live,
    setSearch: (s: string) => dispatch({ type: 'SET_SEARCH', search: s }),
    setLevel: (l: LogLevel) => dispatch({ type: 'SET_LEVEL', level: l }),
    setAutoScroll: (v: boolean) => dispatch({ type: 'SET_AUTO_SCROLL', value: v }),
    toggleTimestamps: () => dispatch({ type: 'TOGGLE_TIMESTAMPS' }),
    clear: () => dispatch({ type: 'CLEAR' }),
  }
}
