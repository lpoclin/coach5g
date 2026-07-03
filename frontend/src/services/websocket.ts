export interface WSEnvelope<T = unknown> {
  type: string
  data: T
}

type Handler<T = unknown> = (data: T) => void

export class WSManager {
  private ws: WebSocket | null = null
  private readonly url: string
  private handlers = new Map<string, Handler[]>()
  private backoffMs = 1_000
  private readonly maxBackoffMs = 30_000
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private _closed = false
  private _connected = false
  onStateChange?: (connected: boolean) => void

  constructor(url: string) {
    // Resolve relative paths: /ws/... → ws://host/ws/...
    if (url.startsWith('/')) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      this.url = `${proto}://${location.host}${url}`
    } else {
      this.url = url
    }
  }

  connect() {
    if (this._closed) return
    try {
      const ws = new WebSocket(this.url)
      this.ws = ws

      ws.onopen = () => {
        this.backoffMs = 1_000
        this._connected = true
        this.onStateChange?.(true)
      }

      ws.onmessage = ({ data }: MessageEvent<string>) => {
        try {
          const env = JSON.parse(data) as WSEnvelope
          const handlers = this.handlers.get(env.type)
          handlers?.forEach(h => h(env.data))
          // Wildcard handlers
          this.handlers.get('*')?.forEach(h => h(env))
        } catch {
          // non-JSON frames: pass raw to '*'
          this.handlers.get('*')?.forEach(h => h(data))
        }
      }

      ws.onclose = () => {
        this._connected = false
        this.onStateChange?.(false)
        if (!this._closed) {
          this.reconnectTimer = setTimeout(() => {
            this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
            this.connect()
          }, this.backoffMs)
        }
      }

      ws.onerror = () => ws.close()
    } catch {
      if (!this._closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs)
      }
    }
  }

  on<T>(type: string, handler: Handler<T>) {
    if (!this.handlers.has(type)) this.handlers.set(type, [])
    this.handlers.get(type)!.push(handler as Handler)
  }

  off<T>(type: string, handler: Handler<T>) {
    const list = this.handlers.get(type)
    if (list) {
      const idx = list.indexOf(handler as Handler)
      if (idx !== -1) list.splice(idx, 1)
    }
  }

  send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  get connected() {
    return this._connected
  }

  close() {
    this._closed = true
    clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}

// Singleton map: one WSManager per URL
const managers = new Map<string, WSManager>()

export function getWSManager(url: string): WSManager {
  if (!managers.has(url)) {
    const mgr = new WSManager(url)
    mgr.connect()
    managers.set(url, mgr)
  }
  return managers.get(url)!
}

export function closeWSManager(url: string) {
  const mgr = managers.get(url)
  if (mgr) {
    mgr.close()
    managers.delete(url)
  }
}
