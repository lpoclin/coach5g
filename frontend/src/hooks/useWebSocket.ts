import { useEffect, useRef, useState, useCallback } from 'react'
import { WSManager } from '@/services/websocket'

export type WSStatus = 'connecting' | 'open' | 'closed' | 'error'

interface Options<T> {
  onMessage: (data: T) => void
  messageType?: string
  enabled?: boolean
}

export function useWebSocket<T = unknown>(url: string, opts: Options<T>) {
  const { onMessage, messageType = '*', enabled = true } = opts
  const [status, setStatus] = useState<WSStatus>('connecting')
  const mgrRef = useRef<WSManager | null>(null)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    if (!enabled) return

    const mgr = new WSManager(url)
    mgrRef.current = mgr

    mgr.onStateChange = (connected) => {
      setStatus(connected ? 'open' : 'connecting')
    }

    const handler = (data: T) => onMessageRef.current(data)
    mgr.on<T>(messageType, handler)
    mgr.connect()
    setStatus('connecting')

    return () => {
      mgr.off(messageType, handler)
      mgr.close()
      mgrRef.current = null
    }
  }, [url, messageType, enabled])

  const send = useCallback((payload: unknown) => {
    mgrRef.current?.send(payload)
  }, [])

  return { status, send }
}
