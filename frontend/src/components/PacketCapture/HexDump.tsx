import { useMemo } from 'react'
import type { Packet } from '@/types/packet'

interface Props {
  packet: Packet | null
  highlightOffset?: number
  highlightLength?: number
}

const BYTES_PER_ROW = 16

function toHex(b: number) {
  return b.toString(16).padStart(2, '0')
}

function isPrintable(b: number): boolean {
  return b >= 0x20 && b < 0x7f
}

interface ParsedRow {
  offset: number
  bytes: number[]
  hex: string[]
  ascii: string
}

function parseRows(raw: Uint8Array): ParsedRow[] {
  const rows: ParsedRow[] = []
  for (let i = 0; i < raw.length; i += BYTES_PER_ROW) {
    const chunk = Array.from(raw.slice(i, i + BYTES_PER_ROW))
    rows.push({
      offset: i,
      bytes: chunk,
      hex: chunk.map(toHex),
      ascii: chunk.map(b => (isPrintable(b) ? String.fromCharCode(b) : '.')).join(''),
    })
  }
  return rows
}

// Protocol decode tree from packet info
function parseProtocolTree(pkt: Packet) {
  const lines: { indent: number; text: string }[] = []

  lines.push({ indent: 0, text: `Frame: ${pkt.length} bytes — ${pkt.interfaceName}` })

  if (pkt.srcIP) {
    lines.push({ indent: 1, text: 'Internet Protocol Version 4' })
    lines.push({ indent: 2, text: `Src: ${pkt.srcIP}    Dst: ${pkt.dstIP}` })
  }

  const proto = pkt.protocol
  if (proto === 'TCP' || proto === 'HTTP/2') {
    lines.push({ indent: 1, text: 'Transmission Control Protocol' })
    lines.push({ indent: 2, text: `Src Port: ${pkt.srcPort}    Dst Port: ${pkt.dstPort}` })
    if (proto === 'HTTP/2') {
      lines.push({ indent: 1, text: 'Hypertext Transfer Protocol 2' })
      pkt.info.split('|').forEach(s => {
        lines.push({ indent: 2, text: s.trim() })
      })
    }
  } else if (proto === 'UDP' || proto === 'GTP-U' || proto === 'PFCP') {
    lines.push({ indent: 1, text: 'User Datagram Protocol' })
    lines.push({ indent: 2, text: `Src Port: ${pkt.srcPort}    Dst Port: ${pkt.dstPort}` })
    if (proto === 'GTP-U') {
      lines.push({ indent: 1, text: 'GPRS Tunneling Protocol User Plane' })
      lines.push({ indent: 2, text: pkt.info })
    } else if (proto === 'PFCP') {
      lines.push({ indent: 1, text: 'Packet Forwarding Control Protocol' })
      lines.push({ indent: 2, text: pkt.info })
    }
  } else if (proto === 'SCTP' || proto === 'NGAP') {
    lines.push({ indent: 1, text: 'Stream Control Transmission Protocol' })
    if (proto === 'NGAP') {
      lines.push({ indent: 1, text: 'Next Generation Application Protocol' })
      lines.push({ indent: 2, text: pkt.info })
    }
  }

  return lines
}

export default function HexDump({ packet, highlightOffset = -1, highlightLength = 0 }: Props) {
  const rows = useMemo(() => {
    if (!packet?.raw) return []
    return parseRows(packet.raw)
  }, [packet])

  const tree = useMemo(() => {
    if (!packet) return []
    return parseProtocolTree(packet)
  }, [packet])

  if (!packet) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm font-mono">
        Select a packet to inspect
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Protocol tree */}
      <div className="border-b border-border px-3 py-2 space-y-0.5 shrink-0 bg-bg-tertiary">
        {tree.map((line, i) => (
          <div
            key={i}
            className="font-mono text-xs flex items-baseline gap-1"
            style={{ paddingLeft: `${line.indent * 16}px` }}
          >
            {line.indent > 0 && (
              <span className="text-slate-600 select-none">▼</span>
            )}
            <span className={line.indent === 0 ? 'text-slate-300 font-semibold' : 'text-slate-400'}>
              {line.text}
            </span>
          </div>
        ))}
      </div>

      {/* Hex dump */}
      <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {rows.length === 0 ? (
          <div className="text-slate-600 italic">No raw bytes available (tshark decoded only)</div>
        ) : (
          rows.map(row => {
            const isHighlighted = highlightOffset >= 0 &&
              row.offset + row.bytes.length > highlightOffset &&
              row.offset < highlightOffset + highlightLength

            return (
              <div
                key={row.offset}
                className={`flex items-center gap-4 leading-[20px] ${isHighlighted ? 'bg-blue-600/10' : ''}`}
              >
                {/* Offset */}
                <span className="text-slate-600 w-10 text-right select-none">
                  {row.offset.toString(16).padStart(4, '0')}
                </span>

                {/* Hex bytes */}
                <span className="flex gap-1 w-[280px]">
                  {row.hex.map((h, i) => {
                    const absOffset = row.offset + i
                    const hi =
                      highlightOffset >= 0 &&
                      absOffset >= highlightOffset &&
                      absOffset < highlightOffset + highlightLength
                    return (
                      <span
                        key={i}
                        className={hi ? 'text-blue-300' : 'text-slate-300'}
                      >
                        {h}
                      </span>
                    )
                  })}
                  {/* Padding for incomplete rows */}
                  {Array.from({ length: BYTES_PER_ROW - row.bytes.length }).map((_, i) => (
                    <span key={`pad-${i}`} className="opacity-0">00</span>
                  ))}
                </span>

                {/* Separator */}
                <span className="text-slate-700">│</span>

                {/* ASCII */}
                <span className="text-slate-500 tracking-widest">
                  {row.ascii}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
