import { useCallback, useReducer, useRef } from 'react'
import { WSManager } from '@/services/websocket'
import type { Packet, CaptureSession, CaptureFilter } from '@/types/packet'

const RING_SIZE = 5_000

interface CaptureState {
  sessions: Map<string, CaptureSession>
  packets: Map<string, Packet[]>  // sessionId → ring buffer
  filters: Map<string, CaptureFilter>
  selected: string | null
}

type Action =
  | { type: 'ADD_SESSION'; session: CaptureSession }
  | { type: 'REMOVE_SESSION'; id: string }
  | { type: 'SET_STATUS'; id: string; status: CaptureSession['status'] }
  | { type: 'ADD_PACKETS'; id: string; packets: Packet[] }
  | { type: 'CLEAR_PACKETS'; id: string }
  | { type: 'SET_FILTER'; id: string; filter: CaptureFilter }
  | { type: 'SELECT'; id: string | null }

function reducer(state: CaptureState, action: Action): CaptureState {
  switch (action.type) {
    case 'ADD_SESSION': {
      const sessions = new Map(state.sessions)
      sessions.set(action.session.id, action.session)
      const packets = new Map(state.packets)
      packets.set(action.session.id, [])
      const filters = new Map(state.filters)
      filters.set(action.session.id, {})
      return { ...state, sessions, packets, filters, selected: action.session.id }
    }
    case 'REMOVE_SESSION': {
      const sessions = new Map(state.sessions)
      sessions.delete(action.id)
      const packets = new Map(state.packets)
      packets.delete(action.id)
      const filters = new Map(state.filters)
      filters.delete(action.id)
      const selected = state.selected === action.id
        ? (sessions.keys().next().value ?? null)
        : state.selected
      return { ...state, sessions, packets, filters, selected }
    }
    case 'SET_STATUS': {
      const sessions = new Map(state.sessions)
      const s = sessions.get(action.id)
      if (!s) return state
      sessions.set(action.id, { ...s, status: action.status })
      return { ...state, sessions }
    }
    case 'ADD_PACKETS': {
      const packets = new Map(state.packets)
      const existing = packets.get(action.id) ?? []
      const merged = [...existing, ...action.packets]
      // Ring buffer: keep last RING_SIZE
      packets.set(action.id, merged.length > RING_SIZE ? merged.slice(-RING_SIZE) : merged)
      // Update packet count
      const sessions = new Map(state.sessions)
      const s = sessions.get(action.id)
      if (s) sessions.set(action.id, { ...s, packetCount: merged.length })
      return { ...state, packets, sessions }
    }
    case 'CLEAR_PACKETS': {
      const packets = new Map(state.packets)
      packets.set(action.id, [])
      const sessions = new Map(state.sessions)
      const s = sessions.get(action.id)
      if (s) sessions.set(action.id, { ...s, packetCount: 0 })
      return { ...state, packets, sessions }
    }
    case 'SET_FILTER': {
      const filters = new Map(state.filters)
      filters.set(action.id, action.filter)
      return { ...state, filters }
    }
    case 'SELECT':
      return { ...state, selected: action.id }
    default:
      return state
  }
}

const initialState: CaptureState = {
  sessions: new Map(),
  packets: new Map(),
  filters: new Map(),
  selected: null,
}

export function usePacketCapture() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const wsRefs = useRef<Map<string, WSManager>>(new Map())
  const pausedRef = useRef<Set<string>>(new Set())

  const startCapture = useCallback(
    (podName: string, namespace: string, node: string, interfaceName: string) => {
      const id = `${namespace}/${podName}/${interfaceName}/${Date.now()}`
      const session: CaptureSession = {
        id,
        podName,
        namespace,
        node,
        interfaceName,
        startedAt: Date.now(),
        status: 'connecting',
        packetCount: 0,
      }
      dispatch({ type: 'ADD_SESSION', session })

      const url = `/ws/packets/${encodeURIComponent(node)}/${encodeURIComponent(podName)}/${encodeURIComponent(interfaceName)}`
      const mgr = new WSManager(url)
      wsRefs.current.set(id, mgr)

      mgr.onStateChange = (connected) => {
        dispatch({ type: 'SET_STATUS', id, status: connected ? 'active' : 'connecting' })
      }

      mgr.on<Packet[]>('packets', (pkts) => {
        if (!pausedRef.current.has(id)) {
          dispatch({ type: 'ADD_PACKETS', id, packets: pkts })
        }
      })

      mgr.connect()
      return id
    },
    [],
  )

  const stopCapture = useCallback((id: string) => {
    wsRefs.current.get(id)?.close()
    wsRefs.current.delete(id)
    dispatch({ type: 'REMOVE_SESSION', id })
  }, [])

  const pauseCapture = useCallback((id: string) => {
    pausedRef.current.add(id)
    dispatch({ type: 'SET_STATUS', id, status: 'paused' })
  }, [])

  const resumeCapture = useCallback((id: string) => {
    pausedRef.current.delete(id)
    dispatch({ type: 'SET_STATUS', id, status: 'active' })
  }, [])

  const clearCapture = useCallback((id: string) => {
    dispatch({ type: 'CLEAR_PACKETS', id })
  }, [])

  const setFilter = useCallback((id: string, filter: CaptureFilter) => {
    dispatch({ type: 'SET_FILTER', id, filter })
  }, [])

  const selectSession = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT', id })
  }, [])

  const getFilteredPackets = useCallback(
    (id: string): Packet[] => {
      const packets = state.packets.get(id) ?? []
      const filter = state.filters.get(id) ?? {}
      if (!filter.protocol && !filter.srcIP && !filter.dstIP && !filter.port && !filter.search) {
        return packets
      }
      return packets.filter((p) => {
        if (filter.protocol && p.protocol !== filter.protocol) return false
        if (filter.srcIP && !p.srcIP.includes(filter.srcIP)) return false
        if (filter.dstIP && !p.dstIP.includes(filter.dstIP)) return false
        if (filter.port && p.srcPort !== filter.port && p.dstPort !== filter.port) return false
        if (filter.search && !p.info.toLowerCase().includes(filter.search.toLowerCase())) return false
        return true
      })
    },
    [state.packets, state.filters],
  )

  return {
    sessions: state.sessions,
    selected: state.selected,
    startCapture,
    stopCapture,
    pauseCapture,
    resumeCapture,
    clearCapture,
    setFilter,
    selectSession,
    getFilteredPackets,
    getFilter: (id: string) => state.filters.get(id) ?? {},
    getSession: (id: string) => state.sessions.get(id),
  }
}
