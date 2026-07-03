import { useRef, useEffect, useCallback, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import type { Packet } from '@/types/packet'
import { PROTOCOL_COLORS } from '@/types/packet'

interface Props {
  packets: Packet[]
  selectedIdx: number | null
  onSelect: (idx: number, pkt: Packet) => void
  autoScroll: boolean
}

const COL_WIDTHS = {
  no:       48,
  time:     100,
  src:      132,
  dst:      132,
  proto:    72,
  len:      56,
  info:     0, // flex-1
}

const Row = memo(function Row({
  pkt,
  idx,
  isSelected,
  onClick,
}: {
  pkt: Packet
  idx: number
  isSelected: boolean
  onClick: () => void
}) {
  const ts = new Date(pkt.timestampNs / 1_000_000).toISOString().slice(11, 23)
  const protoClass = PROTOCOL_COLORS[pkt.protocol] ?? 'proto-other'

  return (
    <div
      onClick={onClick}
      className={clsx(
        'flex items-center h-[22px] cursor-pointer select-none text-xs font-mono border-b border-border/30',
        isSelected
          ? 'bg-blue-600/20 border-blue-600/30'
          : 'hover:bg-bg-hover/60',
      )}
    >
      <span className="text-slate-600 text-right pr-2 shrink-0" style={{ width: COL_WIDTHS.no }}>
        {idx + 1}
      </span>
      <span className="text-slate-500 shrink-0 pr-2" style={{ width: COL_WIDTHS.time }}>
        {ts}
      </span>
      <span className="text-slate-300 shrink-0 pr-2 truncate" style={{ width: COL_WIDTHS.src }}>
        {pkt.srcIP}
        {pkt.srcPort ? `:${pkt.srcPort}` : ''}
      </span>
      <span className="text-slate-300 shrink-0 pr-2 truncate" style={{ width: COL_WIDTHS.dst }}>
        {pkt.dstIP}
        {pkt.dstPort ? `:${pkt.dstPort}` : ''}
      </span>
      <span className={clsx('shrink-0 pr-2 font-semibold', protoClass)} style={{ width: COL_WIDTHS.proto }}>
        {pkt.protocol}
      </span>
      <span className="text-slate-500 shrink-0 pr-2 text-right" style={{ width: COL_WIDTHS.len }}>
        {pkt.length}
      </span>
      <span className={clsx('flex-1 min-w-0 truncate pr-2', protoClass)} title={pkt.info}>
        {pkt.info}
      </span>
    </div>
  )
})

export default function PacketTable({ packets, selectedIdx, onSelect, autoScroll }: Props) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: packets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 30,
  })

  useEffect(() => {
    if (autoScroll && packets.length > 0) {
      virtualizer.scrollToIndex(packets.length - 1, { align: 'end' })
    }
  }, [packets.length, autoScroll, virtualizer])

  const handleSelect = useCallback(
    (idx: number, pkt: Packet) => onSelect(idx, pkt),
    [onSelect],
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center h-7 bg-bg-secondary border-b border-border text-[10px] font-semibold text-slate-500 uppercase tracking-wide shrink-0">
        <span className="pr-2 text-right shrink-0" style={{ width: COL_WIDTHS.no }}>No.</span>
        <span className="pr-2 shrink-0"           style={{ width: COL_WIDTHS.time }}>Time</span>
        <span className="pr-2 shrink-0"           style={{ width: COL_WIDTHS.src }}>Source</span>
        <span className="pr-2 shrink-0"           style={{ width: COL_WIDTHS.dst }}>Destination</span>
        <span className="pr-2 shrink-0"           style={{ width: COL_WIDTHS.proto }}>Protocol</span>
        <span className="pr-2 shrink-0 text-right" style={{ width: COL_WIDTHS.len }}>Len</span>
        <span className="flex-1 pr-2">Info</span>
      </div>

      {/* Virtual rows */}
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(item => {
            const pkt = packets[item.index]!
            return (
              <div
                key={item.key}
                style={{
                  position: 'absolute',
                  top: item.start,
                  width: '100%',
                  height: item.size,
                }}
              >
                <Row
                  pkt={pkt}
                  idx={item.index}
                  isSelected={selectedIdx === item.index}
                  onClick={() => handleSelect(item.index, pkt)}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
