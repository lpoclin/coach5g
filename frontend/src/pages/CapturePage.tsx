import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react'
import React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'

// ─── Types ───────────────────────────────────────────────────────────────────

interface WirePkt {
  ts: string  // nanosecond integer sent as JSON string to avoid JS float64 precision loss
  src_ip: string
  dst_ip: string
  src_port: number
  dst_port: number
  protocol: string
  length: number
  info: string
  iface: string
  pod: string
  ns: string
  node: string
  raw?: string  // base64-encoded raw bytes from tshark (if available)
}

interface LivePacket {
  no: number
  ts: string  // nanosecond integer as string — exact value used for decode URL, Number(ts) for display
  srcIP: string
  dstIP: string
  srcPort: number
  dstPort: number
  protocol: string
  length: number
  info: string
  iface: string
  pod: string
  rawHex?: string  // hex string, populated only if raw bytes available
}

type ConnStatus = 'idle' | 'connecting' | 'live' | 'paused' | 'error' | 'stopped'
type EmptyState = 'starting' | 'waiting' | 'active'

// ─── Constants ────────────────────────────────────────────────────────────────

const RING_MAX         = 10_000
const MAX_CAPTURE_TABS = 8
const PROTOCOLS = ['All', 'GTP-U', 'PFCP', 'HTTP', 'HTTP/2', 'NGAP', 'SCTP', 'DNS', 'TCP', 'UDP'] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Relative time since capture start: "seconds.microseconds" per Wireshark format.
 *  ts is the nanosecond string from the server; Number() is used for display arithmetic only. */
function fmtRelTime(ts: string, startNs: number): string {
  const tsNs = Number(ts)
  if (startNs === 0 || tsNs < startNs) return '0.000000'
  const deltaNs = tsNs - startNs
  const s  = Math.floor(deltaNs / 1_000_000_000)
  const us = Math.floor((deltaNs % 1_000_000_000) / 1_000)
  return `${s}.${String(us).padStart(6, '0')}`
}

/** Absolute UTC time HH:MM:SS.ffffff — BigInt arithmetic to avoid float64 precision loss. */
function fmtAbsTime(tsNs: string): string {
  const ns  = BigInt(tsNs)
  const ms  = Number(ns / 1_000_000n)
  const d   = new Date(ms)
  const hh  = d.getUTCHours().toString().padStart(2, '0')
  const mm  = d.getUTCMinutes().toString().padStart(2, '0')
  const ss  = d.getUTCSeconds().toString().padStart(2, '0')
  const us  = Math.floor(Number(ns % 1_000_000_000n) / 1000).toString().padStart(6, '0')
  return `${hh}:${mm}:${ss}.${us}`
}

/** Arrival time in HH:MM:SS.ffffff — used in detail panel; Number() is sufficient for display. */
function fmtArrival(ts: string): string {
  const tsNs = Number(ts)
  const d  = new Date(tsNs / 1_000_000)
  const hh = d.getUTCHours().toString().padStart(2, '0')
  const mm = d.getUTCMinutes().toString().padStart(2, '0')
  const ss = d.getUTCSeconds().toString().padStart(2, '0')
  const us = Math.floor((tsNs % 1_000_000_000) / 1_000).toString().padStart(6, '0')
  return `${hh}:${mm}:${ss}.${us}`
}

/** Convert a time input string "HH:MM:SS" to nanoseconds, using referenceTsNs for the date. */
function timeInputToNs(timeStr: string, referenceTsNs: string): bigint {
  const refMs   = Number(BigInt(referenceTsNs) / 1_000_000n)
  const refDate = new Date(refMs)
  const [h, m, s] = timeStr.split(':').map(Number)
  const result = new Date(refDate)
  result.setUTCHours(h, m, s, 0)
  return BigInt(result.getTime()) * 1_000_000n
}

/** Row background per protocol (dark theme tints per spec) */
function rowBg(proto: string, selected: boolean): string {
  if (selected) return '#1e3a5f'
  switch (proto) {
    case 'SCTP':   return 'rgba(234,179,8,0.15)'
    case 'GTP-U':  return 'rgba(34,197,94,0.15)'
    case 'HTTP/2': return 'rgba(168,85,247,0.15)'
    case 'HTTP':   return 'rgba(59,130,246,0.15)'
    case 'PFCP':   return 'rgba(59,130,246,0.15)'
    case 'TCP':    return 'rgba(255,255,255,0.04)'
    case 'ARP':    return 'rgba(6,182,212,0.15)'
    case 'UDP':    return 'rgba(249,115,22,0.10)'
    default:       return 'transparent'
  }
}

/** Protocol column text color */
function protoColor(p: string): string {
  switch (p) {
    case 'GTP-U':  return '#22c55e'
    case 'PFCP':   return '#3b82f6'
    case 'HTTP/2': return '#a855f7'
    case 'HTTP':   return '#3b82f6'
    case 'NGAP':   return '#eab308'
    case 'SCTP':   return '#eab308'
    case 'DNS':    return '#22c55e'
    case 'TCP':    return '#94a3b8'
    case 'UDP':    return '#f97316'
    case 'ARP':    return '#06b6d4'
    default:       return '#6b7280'
  }
}

/**
 * Returns the transport protocol that carries the given app protocol,
 * per RFC / 3GPP encapsulation specs.
 * Returns null when the protocol IS the transport (TCP, UDP, SCTP),
 * to avoid rendering a duplicate layer.
 */
function transportFor(proto: string): 'TCP' | 'UDP' | 'SCTP' | null {
  switch (proto.toUpperCase()) {
    case 'HTTP': case 'HTTP/2': case 'TLS': case 'HTTPS':
      return 'TCP'
    case 'GTP-U': case 'PFCP': case 'DNS': case 'DHCP': case 'VXLAN':
      return 'UDP'
    case 'NGAP': case 'S1AP': case 'X2AP': case 'M3AP':
      return 'SCTP'
    // Pure transport protocols: no separate carrier layer
    default:
      return null
  }
}

/** IP protocol number string for the network layer "Protocol:" field */
function ipProtoStr(transport: 'TCP' | 'UDP' | 'SCTP' | null, proto: string): string {
  if (transport === 'TCP'  || proto === 'TCP')  return 'TCP (6)'
  if (transport === 'UDP'  || proto === 'UDP')  return 'UDP (17)'
  if (transport === 'SCTP' || proto === 'SCTP') return 'SCTP (132)'
  return proto
}

// ─── Info-string heuristic parser ────────────────────────────────────────────

interface InfoField { key: string; value: string }

/**
 * Extracts protocol fields by heuristically parsing the tshark info string.
 * All returned fields are labeled "(from info)" in the UI — they are not from
 * raw packet bytes and may be incomplete.
 */
function parseInfoFields(protocol: string, info: string): InfoField[] {
  if (!info) return []
  const f = (key: string, value: string): InfoField => ({ key, value })
  const out: InfoField[] = []
  const p = protocol.toUpperCase()

  // ── TCP flags / seq / ack (also present in HTTP, HTTP/2 info from tshark) ──
  if (p === 'TCP' || p === 'HTTP' || p === 'HTTP/2') {
    const flags = info.match(/\[([A-Z]{2,3}(?:[,\s]+[A-Z]{2,3})*)\]/)
    if (flags) out.push(f('Flags', flags[1]))
    const seq = info.match(/\bSeq=(\d+)/)
    if (seq)   out.push(f('Sequence Number', seq[1]))
    const ack = info.match(/\bAck=(\d+)/)
    if (ack)   out.push(f('Acknowledgment Number', ack[1]))
    const win = info.match(/\bWin=(\d+)/)
    if (win)   out.push(f('Window', win[1]))
    const len = info.match(/\bLen=(\d+)/)
    if (len)   out.push(f('Data Length', len[1] + ' bytes'))
  }

  // ── HTTP/2 frame type / stream ──
  if (p === 'HTTP/2') {
    const frame = info.match(/\b(HEADERS|DATA|SETTINGS|PING|GOAWAY|RST_STREAM|WINDOW_UPDATE|PUSH_PROMISE|CONTINUATION)(?:\[(\d+)\])?/)
    if (frame) {
      out.push(f('Frame Type', frame[1]))
      if (frame[2]) out.push(f('Stream ID', frame[2]))
    }
    const status = info.match(/:status:\s*(\d+)/)
    if (status) out.push(f(':status', status[1]))
    const method = info.match(/:method:\s*(\S+)/)
    if (method) out.push(f(':method', method[1]))
    const path   = info.match(/:path:\s*(\S+)/)
    if (path)   out.push(f(':path', path[1]))
  }

  // ── SCTP chunk type (applies to SCTP and NGAP) ──
  if (p === 'SCTP' || p === 'NGAP' || p === 'S1AP' || p === 'X2AP') {
    const chunk = info.match(/\b(HEARTBEAT(?:_ACK)?|DATA|INIT(?:_ACK)?|SACK|SHUTDOWN(?:_ACK)?|COOKIE_ECHO|COOKIE_ACK|ERROR|ABORT)\b/)
    if (chunk) out.push(f('Chunk Type', chunk[1]))
    const clen = info.match(/\bLen=(\d+)/)
    if (clen)  out.push(f('Chunk Length', clen[1] + ' bytes'))
  }

  // ── GTP-U ──
  if (p === 'GTP-U') {
    const msg = info.match(/^(G-PDU|Echo Request|Echo Response|Supported Extension Headers Notification)/)
    if (msg)  out.push(f('Message Type', msg[1]))
    const teid = info.match(/\bTEID=0x([0-9a-fA-F]+)/i)
    if (teid) out.push(f('TEID', '0x' + teid[1].toUpperCase()))
    // Inner packet: "{IPv4} src → dst (proto)" from tshark
    const inner = info.match(/\{(IPv[46])\}\s+([\d.:a-fA-F]+)\s*[→>]\s*([\d.:a-fA-F]+)\s*\((\w+)\)/)
    if (inner) {
      out.push(f('Inner ' + inner[1] + ' Source', inner[2]))
      out.push(f('Inner ' + inner[1] + ' Destination', inner[3]))
      out.push(f('Inner Protocol', inner[4]))
    }
  }

  // ── PFCP ──
  if (p === 'PFCP') {
    const parts = info.split(/\s+Seq:/)
    if (parts[0]?.trim()) out.push(f('Message Type', parts[0].trim()))
    const seq  = info.match(/\bSeq:\s*(\d+)/)
    if (seq)   out.push(f('Sequence Number', seq[1]))
    const seid = info.match(/\bSEID:\s*(0x[\da-fA-F]+|\d+)/i)
    if (seid)  out.push(f('SEID', seid[1]))
  }

  // ── DNS ──
  if (p === 'DNS') {
    const isResp = /response/i.test(info)
    out.push(f('Message Type', isResp ? 'Standard query response' : 'Standard query'))
    const txId = info.match(/\b0x([0-9a-fA-F]{4})\b/)
    if (txId) out.push(f('Transaction ID', '0x' + txId[1].toUpperCase()))
    const q = info.match(/\b(A|AAAA|CNAME|PTR|MX|NS|SRV|TXT)\s+([\w._-]+)/)
    if (q) { out.push(f('Query Type', q[1])); out.push(f('Query Name', q[2])) }
    if (isResp) {
      const a4 = info.match(/\bA\s+([\d.]+)\s*$/)
      if (a4)   out.push(f('Answer', a4[1]))
      const a6 = info.match(/\bAAAA\s+([\da-fA-F:]+)\s*$/)
      if (a6)   out.push(f('Answer', a6[1]))
    }
  }

  // ── ARP ──
  if (p === 'ARP') {
    if (/request/i.test(info))      out.push(f('Opcode', 'Request (1)'))
    else if (/reply/i.test(info))   out.push(f('Opcode', 'Reply (2)'))
  }

  return out
}

/** base64 → lowercase hex string */
function base64ToHex(b64: string): string {
  try {
    const bin = atob(b64)
    return Array.from(bin, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  } catch { return '' }
}

// ─── Decode panel — protocol tree components ──────────────────────────────────

function Layer({
  label, sublabel, children, defaultOpen = true,
}: {
  label: string; sublabel?: string; children: ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="select-text">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-start gap-1.5 w-full px-2 py-0.5 text-left hover:bg-white/5"
      >
        <span className="mt-px shrink-0 text-[9px]" style={{ color: '#58a6ff' }}>
          {open ? '▼' : '▶'}
        </span>
        <span className="font-bold text-[11px]" style={{ color: '#79c0ff', fontFamily: 'Inter, system-ui, sans-serif' }}>
          {label}
          {sublabel && <span className="font-normal ml-1" style={{ color: '#8b949e' }}>{sublabel}</span>}
        </span>
      </button>
      {open && <div className="pl-5">{children}</div>}
    </div>
  )
}

function Field({ label, value, fromInfo }: { label: string; value: string; fromInfo?: boolean }) {
  return (
    <div className="flex gap-1 px-2 py-px text-[11px] hover:bg-white/5 select-text">
      <span className="shrink-0 font-medium"
        style={{ color: '#8b949e', minWidth: 190, fontFamily: 'Inter, system-ui, sans-serif' }}>
        {label}:
      </span>
      <span className="break-all font-mono" style={{ color: '#f0f6fc' }}>
        {value}
        {fromInfo && <span className="ml-1 text-[9px]" style={{ color: '#6e7681' }}>(from info)</span>}
      </span>
    </div>
  )
}

// ─── Decode tree ──────────────────────────────────────────────────────────────

function DecodeTree({ pkt, startNs }: { pkt: LivePacket; startNs: number }) {
  const isIPv6   = pkt.srcIP.includes(':')
  const ipVer    = isIPv6 ? '6' : '4'
  const proto    = pkt.protocol.toUpperCase()
  const transport = transportFor(pkt.protocol)   // null for TCP/UDP/SCTP themselves

  // Determine actual transport (for TCP/UDP/SCTP themselves, they are the transport)
  const actualTransport: 'TCP' | 'UDP' | 'SCTP' | null =
    proto === 'TCP'  ? 'TCP'  :
    proto === 'UDP'  ? 'UDP'  :
    proto === 'SCTP' ? 'SCTP' :
    transport

  const allFields    = parseInfoFields(pkt.protocol, pkt.info)

  // Partition fields: TCP-level vs SCTP-chunk-level vs app-level
  const tcpKeys   = new Set(['Flags', 'Sequence Number', 'Acknowledgment Number', 'Window', 'Data Length'])
  const sctpKeys  = new Set(['Chunk Type', 'Chunk Length'])
  const tcpFields  = allFields.filter(f => tcpKeys.has(f.key))
  const sctpFields = allFields.filter(f => sctpKeys.has(f.key))
  const appFields  = allFields.filter(f => !tcpKeys.has(f.key) && !sctpKeys.has(f.key))

  // Separate GTP-U inner fields
  const innerFields = appFields.filter(f => f.key.startsWith('Inner '))
  const gtpAppFields = appFields.filter(f => !f.key.startsWith('Inner ') && f.key !== 'Message Type' && f.key !== 'TEID')
  const gtpMsgField  = appFields.find(f => f.key === 'Message Type')
  const gtpTeidField = appFields.find(f => f.key === 'TEID')

  // True when the protocol has a distinct app layer above the transport
  const hasAppLayer = transport !== null

  return (
    <div className="font-mono text-[11px] overflow-y-auto h-full" style={{ background: '#0d1117' }}>

      {/* ── Frame ── */}
      <Layer label={`Frame ${pkt.no}: ${pkt.length} bytes on wire, ${pkt.length} bytes captured`}>
        <Field label="Arrival Time"   value={fmtArrival(pkt.ts)} />
        <Field label="Epoch Time"     value={(Number(pkt.ts) / 1e9).toFixed(9) + ' seconds'} />
        <Field label="Relative Time"  value={fmtRelTime(pkt.ts, startNs) + ' seconds'} />
        <Field label="Interface"      value={pkt.iface} />
        <Field label="Frame Length"   value={`${pkt.length} bytes (${pkt.length * 8} bits)`} />
        <Field label="Capture Length" value={`${pkt.length} bytes (${pkt.length * 8} bits)`} />
        <Field label="Pod"            value={pkt.pod} />
      </Layer>

      {/* ── Network layer ── */}
      <Layer
        label={`Internet Protocol Version ${ipVer},`}
        sublabel={`Src: ${pkt.srcIP}, Dst: ${pkt.dstIP}`}
      >
        <Field label="Version"             value={ipVer} />
        <Field label="Source Address"      value={pkt.srcIP} />
        <Field label="Destination Address" value={pkt.dstIP} />
        {actualTransport && (
          <Field label="Protocol" value={ipProtoStr(actualTransport, pkt.protocol)} />
        )}
      </Layer>

      {/* ── Transport layer ──
          For TCP/UDP/SCTP protocols the transport IS the protocol — show combined.
          For app protocols (GTP-U, HTTP/2, …), show transport ports then the app layer. */}
      {actualTransport === 'TCP' && (
        <Layer
          label="Transmission Control Protocol,"
          sublabel={`Src Port: ${pkt.srcPort || '?'}, Dst Port: ${pkt.dstPort || '?'}`}
        >
          <Field label="Source Port"      value={pkt.srcPort ? String(pkt.srcPort) : '(not available)'} />
          <Field label="Destination Port" value={pkt.dstPort ? String(pkt.dstPort) : '(not available)'} />
          {tcpFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
        </Layer>
      )}

      {actualTransport === 'UDP' && (
        <Layer
          label="User Datagram Protocol,"
          sublabel={`Src Port: ${pkt.srcPort || '?'}, Dst Port: ${pkt.dstPort || '?'}`}
        >
          <Field label="Source Port"      value={pkt.srcPort ? String(pkt.srcPort) : '(not available)'} />
          <Field label="Destination Port" value={pkt.dstPort ? String(pkt.dstPort) : '(not available)'} />
        </Layer>
      )}

      {actualTransport === 'SCTP' && (
        <Layer
          label="Stream Control Transmission Protocol,"
          sublabel={`Src Port: ${pkt.srcPort || '?'}, Dst Port: ${pkt.dstPort || '?'}`}
        >
          <Field label="Source Port"      value={pkt.srcPort ? String(pkt.srcPort) : '(not available)'} />
          <Field label="Destination Port" value={pkt.dstPort ? String(pkt.dstPort) : '(not available)'} />
          {/* SCTP chunk — only shown when SCTP is the top protocol OR for NGAP transport */}
          {sctpFields.length > 0 && (
            <Layer label={`SCTP Chunk: ${sctpFields.find(f => f.key === 'Chunk Type')?.value ?? 'DATA'}`}>
              {sctpFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
            </Layer>
          )}
        </Layer>
      )}

      {/* ── Application / tunneling layer (only when protocol ≠ transport) ── */}

      {/* GTP-U — 3GPP TS 29.281 */}
      {proto === 'GTP-U' && (
        <Layer label="GPRS Tunneling Protocol User Plane">
          <Field label="Version"       value="1" />
          <Field label="Protocol Type" value="GTP (1)" />
          {gtpMsgField  && <Field label="Message Type" value={gtpMsgField.value}  fromInfo />}
          {gtpTeidField && <Field label="TEID"         value={gtpTeidField.value} fromInfo />}
          {innerFields.length > 0 && (
            <Layer label="Encapsulated User Plane Packet" sublabel="(from info string)">
              {innerFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
              {gtpAppFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
            </Layer>
          )}
        </Layer>
      )}

      {/* PFCP — 3GPP TS 29.244 */}
      {proto === 'PFCP' && (
        <Layer label="Packet Forwarding Control Protocol">
          <Field label="Version" value="1" />
          {appFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
        </Layer>
      )}

      {/* HTTP/2 — RFC 7540 / RFC 9113 */}
      {proto === 'HTTP/2' && (
        <Layer label="HyperText Transfer Protocol 2">
          {appFields.filter(f => !tcpKeys.has(f.key)).map(f =>
            <Field key={f.key} label={f.key} value={f.value} fromInfo />
          )}
          {pkt.info && !appFields.length && <Field label="Info" value={pkt.info} />}
        </Layer>
      )}

      {/* HTTP — RFC 7230 */}
      {(proto === 'HTTP') && hasAppLayer && (
        <Layer label="Hypertext Transfer Protocol">
          {appFields.filter(f => !tcpKeys.has(f.key)).map(f =>
            <Field key={f.key} label={f.key} value={f.value} fromInfo />
          )}
          {pkt.info && <Field label="Info" value={pkt.info} />}
        </Layer>
      )}

      {/* NGAP / S1AP / X2AP — over SCTP */}
      {(proto === 'NGAP' || proto === 'S1AP' || proto === 'X2AP') && (
        <Layer label={
          proto === 'NGAP' ? 'Next Generation Application Protocol (NGAP)' :
          proto === 'S1AP' ? 'S1 Application Protocol (S1AP)' : 'X2 Application Protocol (X2AP)'
        }>
          {pkt.info && <Field label="Info" value={pkt.info} fromInfo />}
        </Layer>
      )}

      {/* DNS — RFC 1035 */}
      {proto === 'DNS' && (
        <Layer label="Domain Name System">
          {appFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
        </Layer>
      )}

      {/* ARP — RFC 826 */}
      {proto === 'ARP' && (
        <Layer label="Address Resolution Protocol">
          {appFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
          {pkt.info && <Field label="Info" value={pkt.info} />}
        </Layer>
      )}

      {/* Generic fallback for unknown protocols */}
      {!['TCP','UDP','SCTP','HTTP','HTTP/2','GTP-U','PFCP','NGAP','S1AP','X2AP','DNS','ARP'].includes(proto) && (
        <Layer label={pkt.protocol}>
          {allFields.map(f => <Field key={f.key} label={f.key} value={f.value} fromInfo />)}
          {pkt.info && <Field label="Info" value={pkt.info} />}
        </Layer>
      )}
    </div>
  )
}

// ─── sharkd protocol tree ─────────────────────────────────────────────────────

interface SharkdTreeNode {
  l:  string           // label — render verbatim, exactly as Wireshark shows it
  t?: string           // type: 'proto' | 'url' | 'framenum' | ...
  f?: string           // Wireshark display filter name, shown as title tooltip
  s?: number           // severity
  h?: [number, number] // [start_byte, byte_length] for hex-panel highlighting
  e?: number           // protocol/field ID integer (sharkd internal)
  n?: SharkdTreeNode[] // children array
}

interface DecodeApiResponse {
  sharkd:  boolean
  result?: { tree: SharkdTreeNode[]; bytes: string }
  bytes?:  string  // raw hex when sharkd=false but bytes are available
  error?:  string
}

function SharkdNodeItem({
  node, depth, onSelect, selectedRange,
}: {
  node: SharkdTreeNode
  depth: number
  onSelect: (range: [number, number] | null) => void
  selectedRange: [number, number] | null
}) {
  const hasChildren = Array.isArray(node.n) && node.n.length > 0
  const [expanded, setExpanded] = useState(false)

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (import.meta.env.DEV) {
      console.log('toggle clicked', node.l, 'hasChildren:', hasChildren)
    }
    if (hasChildren) setExpanded(v => !v)
  }

  const select = () => {
    if (node.h) onSelect(node.h)
  }

  const isSelected = selectedRange != null && node.h != null &&
    selectedRange[0] === node.h[0] && selectedRange[1] === node.h[1]

  if (import.meta.env.DEV) {
    console.log('node:', node.l, 'n:', node.n, 'hasChildren:', hasChildren)
  }

  return (
    <div>
      <div
        onClick={select}
        title={node.f}
        style={{
          paddingLeft: depth * 16,
          cursor: node.h ? 'pointer' : 'default',
          background: isSelected ? '#1e3a5f' : 'transparent',
          fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
          fontSize: 13,
          color: '#f0f6fc',
          whiteSpace: 'pre',
          lineHeight: '20px',
        }}
        className="hover:bg-white/5"
      >
        <span onClick={toggle} style={{ cursor: hasChildren ? 'pointer' : 'default' }}>
          {hasChildren ? (expanded ? '▼ ' : '▶ ') : '  '}
        </span>
        {node.l}
      </div>
      {expanded && hasChildren && node.n!.map((child, i) => (
        <SharkdNodeItem
          key={i}
          node={child}
          depth={depth + 1}
          onSelect={onSelect}
          selectedRange={selectedRange}
        />
      ))}
    </div>
  )
}

// ─── Hex dump panel (Wireshark format, with byte-range highlight) ─────────────

function HexPanel({
  hexStr, highlight,
}: {
  hexStr?: string
  highlight?: [number, number] | null  // [start_byte, byte_length]
}) {
  if (!hexStr) {
    return (
      <div
        className="flex items-center justify-center h-full text-center px-4"
        style={{
          color: '#6e7681', background: '#0d1117',
          fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
        }}
      >
        <div className="space-y-1">
          <div style={{ color: '#30363d', fontSize: 20 }}>⬡</div>
          <div>Raw bytes not available from tshark output</div>
          <div style={{ color: '#30363d', fontSize: 10 }}>
            Upgrade api-server image to include tshark for sharkd decode
          </div>
        </div>
      </div>
    )
  }

  // sharkd returns "bytes" as Base64, not hex.
  // Confirmed: atob("vCQRW0WG") = "\xbc\x24\x11\x5b\x45\x86" ✓
  const binary = atob(hexStr)
  const bytes: number[] = []
  for (let i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i))
  }

  const inHl = (idx: number): boolean =>
    highlight != null && idx >= highlight[0] && idx < highlight[0] + highlight[1]

  return (
    <div
      className="overflow-y-auto h-full"
      style={{ background: '#0d1117', fontFamily: '"JetBrains Mono", "Cascadia Code", monospace', fontSize: 12 }}
    >
      {Array.from({ length: Math.ceil(bytes.length / 16) }, (_, ri) => {
        const off   = ri * 16
        const chunk = bytes.slice(off, off + 16)
        return (
          <div
            key={off}
            className="flex whitespace-nowrap hover:bg-white/5"
            style={{ padding: '1px 12px', lineHeight: '20px' }}
          >
            {/* Column 1: 4-digit hex offset */}
            <span style={{ color: '#8b949e', userSelect: 'none', minWidth: 48 }}>
              {off.toString(16).padStart(4, '0')}
            </span>

            {/* Column 2: hex bytes, space-separated, extra space after byte 8 */}
            <span style={{ marginRight: 12 }}>
              {chunk.map((b, j) => {
                const idx = off + j
                const hl  = inHl(idx)
                return (
                  <span key={j}>
                    <span style={{
                      color: '#f0f6fc',
                      background: hl ? 'rgba(88,166,255,0.35)' : undefined,
                    }}>
                      {b.toString(16).padStart(2, '0')}
                    </span>
                    {/* space after each byte except the last; double space after byte 8 */}
                    {j < chunk.length - 1 && (
                      <span style={{ userSelect: 'none', whiteSpace: 'pre' }}>
                        {j === 7 ? '  ' : ' '}
                      </span>
                    )}
                  </span>
                )
              })}
            </span>

            {/* Column 3: ASCII — printable char (0x20-0x7e) or dim dot */}
            <span>
              {chunk.map((b, j) => {
                const idx       = off + j
                const hl        = inHl(idx)
                const printable = b >= 0x20 && b <= 0x7e
                return (
                  <span key={j} style={{
                    color:      printable ? '#f0f6fc' : '#6b7280',
                    background: hl ? 'rgba(88,166,255,0.35)' : undefined,
                  }}>
                    {printable ? String.fromCharCode(b) : '.'}
                  </span>
                )
              })}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Decode panel (resizable height, left tree / right hex, sharkd fetch) ────

function DecodePanel({
  pkt, startNs, onClose,
}: {
  pkt: LivePacket; startNs: number; onClose: () => void
}) {
  const [panelH,    setPanelH]    = useState(300)
  const [splitPct,  setSplitPct]  = useState(55)
  const [decodeData, setDecodeData] = useState<DecodeApiResponse | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [highlight, setHighlight] = useState<[number, number] | null>(null)
  const hRef        = useRef<{ y0: number; h0: number } | null>(null)
  const sRef        = useRef<{ x0: number; pct0: number; w: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Fetch sharkd decode whenever the selected packet (by ts) changes
  useEffect(() => {
    if (!pkt.pod || !pkt.iface || !pkt.ts) return
    let cancelled = false
    setLoading(true)
    setDecodeData(null)
    setHighlight(null)

    const url = `/api/packet/decode?pod=${encodeURIComponent(pkt.pod)}&interface=${encodeURIComponent(pkt.iface)}&ts=${pkt.ts}`
    fetch(url)
      .then(r => r.json() as Promise<DecodeApiResponse>)
      .then(d => {
        if (import.meta.env.DEV) {
          console.log('full sharkd result:', JSON.stringify(d?.result).slice(0, 2000))
        }
        if (!cancelled) { setDecodeData(d); setLoading(false) }
      })
      .catch(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [pkt.ts, pkt.pod, pkt.iface])

  // Panel height resize — drag the top border handle
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      if (!hRef.current) return
      const next = Math.max(150, Math.min(Math.floor(window.innerHeight * 0.7),
        hRef.current.h0 + (hRef.current.y0 - e.clientY)))
      setPanelH(next)
    }
    const up = () => { hRef.current = null }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
  }, [])

  // Vertical split resize — drag the 4px divider between tree and hex
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      if (!sRef.current) return
      const pct = sRef.current.pct0 + ((e.clientX - sRef.current.x0) / sRef.current.w) * 100
      setSplitPct(Math.max(25, Math.min(75, pct)))
    }
    const up = () => { sRef.current = null }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
  }, [])

  const useSharkd = decodeData?.sharkd === true && decodeData.result != null
  const hexStr    = useSharkd
    ? decodeData!.result!.bytes
    : (decodeData?.bytes ?? pkt.rawHex)

  const sharkdBadge = useSharkd
    ? <span style={{ background: '#1a3f1a', color: '#3fb950', border: '1px solid #2ea043',
        fontSize: 9, padding: '1px 4px', borderRadius: 3 }}>sharkd</span>
    : decodeData && !decodeData.sharkd
      ? <span style={{ background: '#2a1a0a', color: '#d29922', border: '1px solid #9a6700',
          fontSize: 9, padding: '1px 4px', borderRadius: 3 }}>basic decode</span>
      : null

  return (
    <div className="shrink-0 flex flex-col" style={{ height: panelH + 28, background: '#0d1117' }}>

      {/* ── Header / drag handle ─────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-3 shrink-0 cursor-ns-resize select-none"
        style={{ height: 28, background: '#161b22', borderTop: '2px solid #30363d' }}
        onMouseDown={e => { e.preventDefault(); hRef.current = { y0: e.clientY, h0: panelH } }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderTopColor = '#388bfd' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderTopColor = '#30363d' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold" style={{ color: '#58a6ff' }}>PACKET DECODE</span>
          <span className="text-[10px]" style={{ color: '#6e7681' }}>
            Frame {pkt.no} — {pkt.protocol} — {pkt.length} bytes — {fmtArrival(pkt.ts)}
          </span>
          {sharkdBadge}
          {loading && (
            <span className="text-[9px] animate-pulse" style={{ color: '#8b949e' }}>fetching…</span>
          )}
        </div>
        <button
          onClick={e => { e.stopPropagation(); onClose() }}
          onMouseDown={e => e.stopPropagation()}
          className="text-sm px-1 hover:text-red-400"
          style={{ color: '#6e7681' }}
        >
          ×
        </button>
      </div>

      {/* ── Left: protocol tree  |  divider  |  Right: hex dump ─────────── */}
      <div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden">

        {/* Protocol tree — sharkd real tree or info-string fallback */}
        <div style={{ width: `${splitPct}%`, minWidth: 0, overflow: 'hidden', background: '#1a1d2e' }}>
          {loading ? (
            <div className="flex items-center justify-center h-full text-[11px] animate-pulse"
              style={{ color: '#8b949e' }}>
              Waiting for sharkd…
            </div>
          ) : useSharkd ? (
            <div className="overflow-y-auto h-full">
              {decodeData!.result!.tree.map((n, i) => (
                <SharkdNodeItem
                  key={i}
                  node={n}
                  depth={0}
                  onSelect={r => setHighlight(r)}
                  selectedRange={highlight}
                />
              ))}
            </div>
          ) : (
            <DecodeTree pkt={pkt} startNs={startNs} />
          )}
        </div>

        {/* Draggable vertical divider */}
        <div
          className="shrink-0 cursor-ew-resize"
          style={{ width: 4, background: '#30363d' }}
          onMouseDown={e => {
            e.preventDefault()
            sRef.current = { x0: e.clientX, pct0: splitPct, w: containerRef.current?.clientWidth ?? 800 }
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#58a6ff' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#30363d' }}
        />

        {/* Hex dump */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <HexPanel hexStr={hexStr} highlight={highlight} />
        </div>
      </div>
    </div>
  )
}

// ─── WebSocket URL helper ─────────────────────────────────────────────────────

function wsUrl(pod: string, iface: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const host  = import.meta.env.DEV ? `${location.hostname}:8080` : location.host
  return `${proto}://${host}/ws/packets?pod=${encodeURIComponent(pod)}&interface=${encodeURIComponent(iface)}`
}

// ─── CaptureTab ───────────────────────────────────────────────────────────────

export interface CaptureTab {
  id: string
  pod: string
  podDisplay: string
  iface: string
}

// ─── CaptureTabPanel ─────────────────────────────────────────────────────────

function CaptureTabPanel({
  tab,
  ringBufferSize,
  splitMode,
  onStatusChange,
  onSetActive,
}: {
  tab: CaptureTab
  ringBufferSize: number
  splitMode: boolean
  onStatusChange: (s: ConnStatus) => void
  onSetActive: (id: string) => void
}) {
  const [packets,   setPackets]   = useState<LivePacket[]>([])
  const [captureTs, setCaptureTs] = useState(0)
  const counterRef  = useRef(0)
  const wsRef       = useRef<WebSocket | null>(null)
  const pausedRef   = useRef(false)
  const bufferRef   = useRef<LivePacket[]>([])
  const tableRef    = useRef<HTMLDivElement>(null)

  const [paused,       setPaused]      = useState(false)
  const [protoFilter,  setProtoFilter] = useState<string>('All')
  const [search,       setSearch]      = useState('')
  const [selectedNo,   setSelectedNo]  = useState<number | null>(null)
  const [rangeFrom,    setRangeFrom]   = useState('')
  const [rangeTo,      setRangeTo]     = useState('')
  const [status,       setStatus]      = useState<ConnStatus>('idle')
  const [emptyState,   setEmptyState]  = useState<EmptyState>('starting')

  const currentTabKey = `${tab.pod}/${tab.iface}`

  const reportStatus = useCallback((s: ConnStatus) => {
    setStatus(s)
    onStatusChange(s)
  }, [onStatusChange])

  // WebSocket lifecycle
  useEffect(() => {
    reportStatus('connecting')
    setPackets([])
    setCaptureTs(0)
    counterRef.current = 0
    bufferRef.current  = []
    pausedRef.current  = false
    setPaused(false)
    setSelectedNo(null)

    const ws = new WebSocket(wsUrl(tab.pod, tab.iface))
    wsRef.current = ws
    ws.onopen  = () => reportStatus('live')
    ws.onerror = () => reportStatus('error')
    ws.onclose = () => {
      setStatus(prev => {
        const next = prev === 'paused' ? 'paused' : 'stopped'
        onStatusChange(next)
        return next
      })
    }
    ws.onmessage = (ev: MessageEvent<string>) => {
      const msg = JSON.parse(ev.data) as { type: string; data: WirePkt | WirePkt[] }
      if (msg.type !== 'packets' && msg.type !== 'packet') return
      const items = Array.isArray(msg.data) ? msg.data : [msg.data]
      if (!items.length) return
      const parsed: LivePacket[] = items.map(p => ({
        no: ++counterRef.current, ts: p.ts,
        srcIP: p.src_ip, dstIP: p.dst_ip,
        srcPort: p.src_port, dstPort: p.dst_port,
        protocol: p.protocol, length: p.length,
        info: p.info, iface: p.iface, pod: p.pod,
        rawHex: p.raw ? base64ToHex(p.raw) : undefined,
      }))
      if (parsed.some(p => !p.info.endsWith('(raw)'))) setEmptyState(prev => prev !== 'active' ? 'active' : prev)
      setCaptureTs(prev => prev === 0 && parsed.length > 0 ? Number(parsed[0].ts) : prev)
      if (pausedRef.current) {
        bufferRef.current = [...bufferRef.current, ...parsed].slice(-RING_MAX)
      } else {
        setPackets(prev => { const n = [...prev, ...parsed]; return n.length > RING_MAX ? n.slice(-RING_MAX) : n })
      }
    }
    return () => { ws.close(); wsRef.current = null }
  }, [tab.pod, tab.iface]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setEmptyState('starting') }, [currentTabKey])

  useEffect(() => {
    if (emptyState !== 'starting') return
    const t = setTimeout(() => {
      setEmptyState(prev => prev === 'starting' ? 'waiting' : prev)
    }, 3000)
    return () => clearTimeout(t)
  }, [emptyState, currentTabKey])

  // Filtered view
  const displayed = useMemo(() => {
    let list = packets.filter(p => !p.info.endsWith('(raw)'))
    if (protoFilter !== 'All') {
      if (protoFilter === 'HTTP') {
        list = list.filter(p =>
          p.protocol === 'HTTP' ||
          p.protocol.startsWith('HTTP/1') ||
          p.protocol === 'SSDP' ||
          p.info.includes('HTTP/1.1') ||
          p.info.includes('HTTP/1.0')
        )
      } else {
        list = list.filter(p => p.protocol === protoFilter)
      }
    }
    if (search) {
      const s = search.toLowerCase()
      list = list.filter(p =>
        p.srcIP.includes(s) || p.dstIP.includes(s) ||
        p.info.toLowerCase().includes(s) || p.protocol.toLowerCase().includes(s))
    }
    return list
  }, [packets, protoFilter, search])

  // Export range
  const derivedFrom = useMemo(() =>
    displayed.length > 0 ? fmtAbsTime(displayed[0].ts).slice(0, 8) : '', [displayed])
  const derivedTo = useMemo(() =>
    displayed.length > 0 ? fmtAbsTime(displayed[displayed.length - 1].ts).slice(0, 8) : '', [displayed])
  useEffect(() => { setRangeFrom(''); setRangeTo('') }, [tab.pod, tab.iface])

  const effectiveFrom  = rangeFrom || derivedFrom
  const effectiveTo    = rangeTo   || derivedTo
  const refTsNs        = displayed.length > 0 ? displayed[0].ts : '0'
  const rangeExportUrl = tab.pod && tab.iface && effectiveFrom && effectiveTo && refTsNs !== '0'
    ? `/api/packets/export?pod=${encodeURIComponent(tab.pod)}&interface=${encodeURIComponent(tab.iface)}&start=${timeInputToNs(effectiveFrom, refTsNs)}&end=${timeInputToNs(effectiveTo, refTsNs)}`
    : undefined

  // Virtual scroll
  const virtualizer = useVirtualizer({
    count: displayed.length,
    getScrollElement: () => tableRef.current,
    estimateSize: () => 22,
    overscan: 30,
  })
  useEffect(() => {
    if (!paused && displayed.length > 0) virtualizer.scrollToIndex(displayed.length - 1, { align: 'end' })
  }, [displayed.length, paused, virtualizer])

  // Controls
  const handlePause = useCallback(() => {
    pausedRef.current = true; setPaused(true); reportStatus('paused')
  }, [reportStatus])

  const handleResume = useCallback(() => {
    const buf = bufferRef.current
    bufferRef.current = []; pausedRef.current = false; setPaused(false)
    if (buf.length > 0) setPackets(prev => { const n = [...prev, ...buf]; return n.length > RING_MAX ? n.slice(-RING_MAX) : n })
    reportStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'live' : 'stopped')
  }, [reportStatus])

  const handleClear = useCallback(() => {
    setPackets([]); setCaptureTs(0)
    bufferRef.current = []; counterRef.current = 0; setSelectedNo(null)
    wsRef.current?.send(JSON.stringify({ type: 'clear' }))
  }, [])

  const selectedPkt = useMemo(
    () => selectedNo !== null ? (packets.find(p => p.no === selectedNo) ?? null) : null,
    [selectedNo, packets])

  // Status badge
  const statusBadge = () => {
    if (status === 'live') return (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full font-bold text-xs tracking-widest"
        style={{ background: '#0d2a14', border: '2px solid #3fb950', color: '#3fb950' }}>
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ background: '#3fb950' }} />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5"
            style={{ background: '#3fb950' }} />
        </span>
        LIVE
      </span>
    )
    if (status === 'paused')     return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#2d2a0a', border: '1px solid #d29922', color: '#d29922' }}>⏸ PAUSED</span>
    if (status === 'connecting') return <span className="px-2 py-1 rounded text-xs font-bold animate-pulse" style={{ background: '#0d1f3c', border: '1px solid #388bfd', color: '#58a6ff' }}>Connecting…</span>
    if (status === 'error')      return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#2d0a0a', border: '1px solid #f85149', color: '#f85149' }}>ERROR</span>
    if (status === 'stopped')    return <span className="px-2 py-1 rounded text-xs font-bold" style={{ background: '#161b22', border: '1px solid #6e7681', color: '#6e7681' }}>STOPPED</span>
    return <span className="px-2 py-1 rounded text-xs" style={{ color: '#6e7681' }}>IDLE</span>
  }

  return (
    <div className="flex flex-col h-full text-xs" style={{ background: '#0d1117', color: '#e6edf3' }}
      onClick={() => onSetActive(tab.id)}>

      {/* TOP BAR */}
      <div className="flex items-center gap-2 px-4 py-2 shrink-0"
        style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>
        <div className="flex items-center gap-1.5">
          {splitMode && (
            <span style={{
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: 12, fontWeight: 'bold', color: '#f0f6fc',
              background: 'rgba(88,166,255,0.1)', border: '1px solid #30363d',
              borderRadius: 4, padding: '2px 8px', maxWidth: 120,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'inline-block',
            }}>
              {tab.podDisplay}:{tab.iface}
            </span>
          )}
          {paused ? (
            <button onClick={handleResume} className="px-2 py-1 rounded text-xs"
              style={{ background: '#238636', color: '#f0f6fc', border: '1px solid #2ea043' }}>
              ▶ Resume
            </button>
          ) : (
            <button onClick={handlePause} className="px-2 py-1 rounded text-xs"
              style={{ background: '#21262d', color: status === 'live' ? '#c26363' : '#e6edf3', border: `1px solid ${status === 'live' ? '#c26363' : '#30363d'}` }}>
              ⏸ Pause
            </button>
          )}
          <button onClick={handleClear} className="px-2 py-1 rounded text-xs"
            style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d' }}>
            🗑 Clear
          </button>
        </div>
        <div className="w-px h-5 shrink-0" style={{ background: '#30363d' }} />
        <div className="flex items-center gap-2">
          {(['30s', '5min', '1h'] as const).map(lbl => (
            <a key={lbl}
              href={`/api/packets/export?pod=${encodeURIComponent(tab.pod)}&interface=${encodeURIComponent(tab.iface)}&duration=${lbl}`}
              download className="px-1.5 py-1 rounded text-xs"
              style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d', textDecoration: 'none' }}
              title={`Download pcap — last ${lbl}`}>
              ⬇ {lbl}
            </a>
          ))}
          <div className="w-px h-5 shrink-0" style={{ background: '#30363d' }} />
          <span className="text-xs" style={{ color: '#6e7681' }}>From:</span>
          <input type="time" step="1" value={effectiveFrom} onChange={e => setRangeFrom(e.target.value)}
            className="rounded px-1 py-0.5 text-xs tabular-nums w-24"
            style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3' }} />
          <span className="text-xs" style={{ color: '#6e7681' }}>→</span>
          <input type="time" step="1" value={effectiveTo} onChange={e => setRangeTo(e.target.value)}
            className="rounded px-1 py-0.5 text-xs tabular-nums w-24"
            style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3' }} />
          <a href={rangeExportUrl} download className="px-1.5 py-0.5 rounded text-xs"
            style={{
              background: '#21262d', color: rangeExportUrl ? '#8b949e' : '#4a4a4a',
              border: '1px solid #30363d', textDecoration: 'none',
              cursor: rangeExportUrl ? 'pointer' : 'not-allowed',
              pointerEvents: rangeExportUrl ? 'auto' : 'none',
            }}
            title={rangeExportUrl ? 'Download pcap for selected range' : 'Waiting for packets'}>
            ⬇ Range
          </a>
        </div>
        <div className="flex-1" />
        <div className="flex items-center shrink-0">
          {statusBadge()}
        </div>
      </div>

      {/* FILTER BAR */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 shrink-0"
        style={{ background: '#0d1117', borderBottom: '1px solid #21262d' }}>
        {PROTOCOLS.map(p => (
          <button key={p} onClick={() => setProtoFilter(p)}
            className="px-2 py-0.5 rounded font-mono text-xs transition-colors"
            style={{
              background: protoFilter === p ? '#1f6feb' : '#161b22',
              color:      protoFilter === p ? '#e6edf3' : '#8b949e',
              border:    `1px solid ${protoFilter === p ? '#388bfd' : '#30363d'}`,
            }}>
            {p}
          </button>
        ))}
        <div className="flex-1" />
        <input type="text" placeholder="🔍 IP, info…" value={search}
          onChange={e => setSearch(e.target.value)}
          className="rounded px-2 py-0.5 outline-none text-xs w-44"
          style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3' }} />
      </div>

      {/* MAIN AREA — single scroll container; header sticky-top so it stays visible on vertical scroll */}
      <div className="flex flex-col flex-1 min-h-0">
        <div ref={tableRef} className="flex-1 overflow-y-auto overflow-x-auto font-mono"
          style={{ background: '#0d1117' }}>
          {/* Column header — sticky vertically, scrolls with content horizontally */}
          <div className="flex items-center gap-2 px-3 py-1 font-mono text-[10px] uppercase"
            style={{
              background: '#161b22', color: '#6e7681', borderBottom: '1px solid #21262d',
              minWidth: 820, position: 'sticky', top: 0, zIndex: 10,
            }}>
            <span className="w-10 shrink-0 text-right">No.</span>
            <span className="w-32 shrink-0">Time (UTC)</span>
            <span className="w-36 shrink-0">Source</span>
            <span className="w-36 shrink-0">Destination</span>
            <span className="w-20 shrink-0">Protocol</span>
            <span className="w-12 shrink-0 text-right">Length</span>
            <span className="flex-1">Info</span>
          </div>
          {/* Empty state — 3 phases: starting → waiting → active (filter miss) */}
          {displayed.length === 0 && (emptyState === 'starting' ? (
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',
              justifyContent:'center',height:'160px',gap:'10px',color:'#8b949e'}}>
              <div style={{width:16,height:16,border:'2px solid #30363d',
                borderTopColor:'#58a6ff',borderRadius:'50%',
                animation:'spin 0.8s linear infinite'}}/>
              <span style={{fontSize:13}}>Starting capture...</span>
            </div>
          ) : emptyState === 'waiting' ? (
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',
              justifyContent:'center',height:'160px',gap:'8px',color:'#6e7681'}}>
              <span style={{fontSize:20}}>⊙</span>
              <span style={{fontSize:13}}>Waiting for traffic on {tab.iface}</span>
              <span style={{fontSize:11,color:'#484f58'}}>
                tshark is ready, no packets on this interface yet
              </span>
            </div>
          ) : (
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',
              height:'80px',color:'#6e7681',fontSize:13}}>
              No packets match the current filter
            </div>
          ))}
          {/* Virtual rows — minWidth:'100%' lets rows grow wider than the container when
              Info text is long; overflow is visible so the scroll container tracks it */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 820 }}>
            {virtualizer.getVirtualItems().map(item => {
              const pkt        = displayed[item.index]!
              const isSelected = pkt.no === selectedNo
              return (
                <div key={item.key}
                  onClick={() => setSelectedNo(prev => prev === pkt.no ? null : pkt.no)}
                  style={{
                    position: 'absolute', top: item.start, minWidth: '100%', height: item.size,
                    background: rowBg(pkt.protocol, isSelected),
                    borderLeft: isSelected ? '3px solid #58a6ff' : '3px solid transparent',
                  }}
                  className="flex items-center gap-2 px-3 cursor-pointer hover:brightness-125">
                  <span className="w-10 shrink-0 text-right select-text" style={{ color: '#6e7681' }}>{pkt.no}</span>
                  <span className="w-32 shrink-0 tabular-nums select-text" style={{ color: '#8b949e' }}>{fmtAbsTime(pkt.ts)}</span>
                  <span className="w-36 shrink-0 truncate select-text">{pkt.srcIP}</span>
                  <span className="w-36 shrink-0 truncate select-text">{pkt.dstIP}</span>
                  <span className="w-20 shrink-0 font-bold select-text" style={{ color: protoColor(pkt.protocol) }}>{pkt.protocol}</span>
                  <span className="w-12 shrink-0 text-right select-text" style={{ color: '#6e7681' }}>{pkt.length}</span>
                  <span className="shrink-0 select-text" style={{ color: '#c9d1d9', whiteSpace: 'nowrap' }}>{pkt.info}</span>
                </div>
              )
            })}
          </div>
        </div>
        {selectedPkt && (
          <DecodePanel pkt={selectedPkt} startNs={captureTs} onClose={() => setSelectedNo(null)} />
        )}
      </div>

      {/* STATUS BAR */}
      <div className="flex items-center gap-4 px-4 py-1 shrink-0 font-mono"
        style={{ background: '#161b22', borderTop: '1px solid #30363d', color: '#8b949e' }}>
        <span>Pkts: <strong style={{ color: '#e6edf3' }}>{packets.length}</strong></span>
        <span style={{ color: '#30363d' }}>│</span>
        <span>Shown: <strong style={{ color: '#e6edf3' }}>{displayed.length}</strong></span>
        <span style={{ color: '#30363d' }}>│</span>
        <span>Buf: <strong style={{ color: '#e6edf3' }}>{packets.length}</strong>/{ringBufferSize.toLocaleString()}</span>
      </div>
    </div>
  )
}

// ─── CapturePage ──────────────────────────────────────────────────────────────

export default function CapturePage({
  tabs,
  activeTabId,
  splitMode,
  onTabsChange,
  onActiveTabChange,
  onSplitModeChange,
}: {
  tabs: CaptureTab[]
  activeTabId: string | null
  splitMode: boolean
  onTabsChange: (tabs: CaptureTab[]) => void
  onActiveTabChange: (id: string | null) => void
  onSplitModeChange: (v: boolean) => void
}) {
  const [ringBufferSize, setRingBufferSize] = useState(10_000)
  const [tabStatuses,    setTabStatuses]    = useState<Record<string, ConnStatus>>({})
  const [showAdd,        setShowAdd]        = useState(false)
  const [newPod,         setNewPod]         = useState('')
  const [newIface,       setNewIface]       = useState('eth0')
  const [splitWidths,    setSplitWidths]    = useState<number[]>([])
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef<{ idx: number; x0: number; totalW: number; widths: number[] } | null>(null)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((cfg: { ringBufferSize: number }) => setRingBufferSize(cfg.ringBufferSize))
      .catch(() => {})
  }, [])

  const { data: nodes = [] } = useQuery({
    queryKey: ['topology-nodes-any'],
    queryFn:  () => api.topology.get().then(g => g.nodes),
    staleTime: 30_000,
  })

  // Reset to equal widths when tab count changes
  useEffect(() => {
    if (tabs.length > 0) setSplitWidths(tabs.map(() => 100 / tabs.length))
  }, [tabs.length])

  // Split drag resize
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      if (!splitDragRef.current) return
      const { idx, x0, totalW, widths } = splitDragRef.current
      const delta = ((e.clientX - x0) / totalW) * 100
      const MIN = 15
      const next = [...widths]
      next[idx]     = Math.max(MIN, Math.min(widths[idx] + delta, widths[idx] + widths[idx + 1] - MIN))
      next[idx + 1] = widths[idx] + widths[idx + 1] - next[idx]
      setSplitWidths(next)
    }
    const up = () => { splitDragRef.current = null }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
  }, [])

  const effectiveWidths = splitWidths.length === tabs.length
    ? splitWidths
    : tabs.map(() => 100 / tabs.length)

  const selectedAddNode  = (nodes as any[]).find(n => n.podName === newPod)
  const addNodeIfaces    = (selectedAddNode?.interfaces.map((i: any) => i.interface as string)) ?? ['eth0']

  const handleStatusChange = useCallback((id: string, s: ConnStatus) => {
    setTabStatuses(prev => ({ ...prev, [id]: s }))
  }, [])

  const addTab = useCallback((pod: string, iface: string) => {
    const existing = tabs.find(t => t.pod === pod && t.iface === iface)
    if (existing) { onActiveTabChange(existing.id); return }
    if (tabs.length >= MAX_CAPTURE_TABS) return
    const node       = (nodes as any[]).find(n => n.podName === pod)
    const podDisplay = node?.displayName ?? pod.split('-').filter((s: string) => s !== 'free5gc' && !/^[0-9a-f]{5,}$/.test(s)).slice(0, 2).join('-')
    const id         = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    onTabsChange([...tabs, { id, pod, podDisplay, iface }])
    onActiveTabChange(id)
  }, [tabs, nodes, onTabsChange, onActiveTabChange])

  const closeTab = useCallback((id: string) => {
    const idx     = tabs.findIndex(t => t.id === id)
    const newTabs = tabs.filter(t => t.id !== id)
    onTabsChange(newTabs)
    if (activeTabId === id) {
      const next = newTabs[Math.min(idx, newTabs.length - 1)]
      onActiveTabChange(next?.id ?? null)
    }
  }, [tabs, activeTabId, onTabsChange, onActiveTabChange])

  const dotColor = (id: string) => {
    const s = tabStatuses[id]
    if (s === 'live')                       return '#3fb950'
    if (s === 'paused')                     return '#8b949e'
    if (s === 'error' || s === 'stopped')   return '#f85149'
    return '#6e7681'
  }

  return (
    <div className="flex flex-col h-full" style={{ background: '#0d1117' }}>

      {/* ── Tab bar ── */}
      <div className="flex items-center shrink-0 overflow-x-auto"
        style={{ background: '#0d1117', borderBottom: '1px solid #30363d', minHeight: 36 }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId
          return (
            <div key={tab.id}
              onClick={() => onActiveTabChange(tab.id)}
              className="group flex items-center gap-1.5 px-3 py-2 cursor-pointer shrink-0"
              style={{
                background:   isActive ? '#1e3a5f' : '#161b22',
                borderRight:  '1px solid #30363d',
                borderBottom: isActive ? '2px solid #58a6ff' : '2px solid transparent',
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = '#1c2128'
                const btn = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.tab-close-btn')
                if (btn) { btn.style.color = '#f0f6fc'; btn.style.opacity = '1' }
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = '#161b22'
                const btn = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.tab-close-btn')
                if (btn) { btn.style.color = '#8b949e'; btn.style.opacity = '0.6' }
              }}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dotColor(tab.id) }} />
              <span className="text-xs font-mono whitespace-nowrap"
                style={{ color: isActive ? '#e6edf3' : '#8b949e' }}>
                {tab.podDisplay}:{tab.iface}
              </span>
              <button
                onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                className="tab-close-btn"
                style={{
                  marginLeft: 4, color: '#8b949e', opacity: 0.6,
                  fontSize: 14, fontWeight: 'bold', padding: '2px 5px',
                  borderRadius: 3, transition: 'all 0.1s', background: 'transparent',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLElement
                  el.style.color = '#ef4444'
                  el.style.background = 'rgba(239,68,68,0.15)'
                  el.style.opacity = '1'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLElement
                  el.style.color = '#f0f6fc'
                  el.style.background = 'transparent'
                  el.style.opacity = '1'
                }}>
                ×
              </button>
            </div>
          )
        })}

        {/* Add tab button */}
        <button
          onClick={() => { if (tabs.length < MAX_CAPTURE_TABS) setShowAdd(v => !v) }}
          title={tabs.length >= MAX_CAPTURE_TABS ? `Maximum ${MAX_CAPTURE_TABS} tabs reached` : 'Add capture tab'}
          className="flex items-center shrink-0"
          style={{
            color:        tabs.length >= MAX_CAPTURE_TABS ? '#4a4a4a' : '#58a6ff',
            cursor:       tabs.length >= MAX_CAPTURE_TABS ? 'not-allowed' : 'pointer',
            fontSize:     16,
            fontWeight:   'bold',
            padding:      '2px 8px',
            borderRadius: 4,
            transition:   'color 0.1s, background 0.1s',
            background:   'transparent',
          }}
          onMouseEnter={e => {
            if (tabs.length >= MAX_CAPTURE_TABS) return
            const el = e.currentTarget as HTMLElement
            el.style.background = 'rgba(88,166,255,0.15)'
            el.style.color = '#79c0ff'
          }}
          onMouseLeave={e => {
            if (tabs.length >= MAX_CAPTURE_TABS) return
            const el = e.currentTarget as HTMLElement
            el.style.background = 'transparent'
            el.style.color = '#58a6ff'
          }}>
          +
        </button>

        <div className="flex-1" />

        {/* Split toggle — only shown when 2+ tabs exist */}
        {tabs.length > 1 && (
          <button
            onClick={() => onSplitModeChange(!splitMode)}
            className="flex items-center gap-1.5 px-3 py-1.5 mx-2 rounded text-xs"
            style={{
              background: splitMode ? '#1f6feb' : '#21262d',
              border:     `1px solid ${splitMode ? '#388bfd' : '#30363d'}`,
              color:      splitMode ? '#e6edf3' : '#8b949e',
            }}
            title={splitMode ? 'Exit split view' : 'Enter split view'}>
            {splitMode ? '□ Single' : '⊞ Split'}
          </button>
        )}
      </div>

      {/* ── Add tab row ── */}
      {showAdd && (
        <div className="flex items-center gap-2 px-4 py-2 shrink-0"
          style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>
          <select value={newPod} onChange={e => { setNewPod(e.target.value); setNewIface('eth0') }}
            className="text-xs rounded px-2 py-1 outline-none"
            style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3', maxWidth: 240 }}>
            <option value="">— Select NF —</option>
            {(nodes as any[]).filter(n => n.nfType !== 'DN').map(n => (
              <option key={n.id} value={n.podName}>{n.displayName} · {n.podName}</option>
            ))}
          </select>
          <select value={newIface} onChange={e => setNewIface(e.target.value)}
            className="text-xs rounded px-2 py-1 outline-none"
            style={{ background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3' }}>
            {addNodeIfaces.map((i: string) => <option key={i} value={i}>{i}</option>)}
          </select>
          <button
            disabled={!newPod}
            onClick={() => { if (newPod) { addTab(newPod, newIface); setShowAdd(false); setNewPod('') } }}
            className="px-3 py-1 rounded text-xs"
            style={{
              background: newPod ? '#238636' : '#21262d',
              color:      newPod ? '#f0f6fc' : '#4a4a4a',
              border:     '1px solid #30363d',
            }}>
            ▶ Start
          </button>
          <button onClick={() => { setShowAdd(false); setNewPod('') }}
            className="px-2 py-1 rounded text-xs"
            style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d' }}>
            Cancel
          </button>
        </div>
      )}

      {/* ── Panels ── */}
      {tabs.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3"
          style={{ color: '#6e7681' }}>
          <span className="text-4xl opacity-20">📡</span>
          <span className="text-sm">No capture sessions open</span>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 rounded text-sm"
            style={{ background: '#238636', color: '#f0f6fc', border: '1px solid #2ea043' }}>
            + New Capture
          </button>
        </div>
      ) : (
        <div ref={splitContainerRef} className="flex flex-1 min-h-0 overflow-hidden">
          {tabs.flatMap((tab, idx) => {
            const visible = splitMode || tab.id === activeTabId
            const w = effectiveWidths[idx] ?? (100 / tabs.length)
            const elements = [
              <div key={tab.id} style={{
                display:       visible ? 'flex' : 'none',
                flexDirection: 'column',
                width:         splitMode ? `${w}%` : '100%',
                minWidth:      splitMode ? 300 : undefined,
                overflow:      'hidden',
                flexShrink:    splitMode ? 0 : undefined,
              }}>
                <CaptureTabPanel
                  tab={tab}
                  ringBufferSize={ringBufferSize}
                  splitMode={splitMode}
                  onStatusChange={s => handleStatusChange(tab.id, s)}
                  onSetActive={id => onActiveTabChange(id)}
                />
              </div>,
            ]
            if (splitMode && idx < tabs.length - 1) {
              elements.push(
                <div key={`divider-${idx}`}
                  className="shrink-0 cursor-ew-resize"
                  style={{ width: 4, background: '#30363d' }}
                  onMouseDown={e => {
                    e.preventDefault()
                    splitDragRef.current = {
                      idx,
                      x0: e.clientX,
                      totalW: splitContainerRef.current?.clientWidth ?? window.innerWidth,
                      widths: [...effectiveWidths],
                    }
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#58a6ff' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#30363d' }}
                />
              )
            }
            return elements
          })}
        </div>
      )}
    </div>
  )
}
