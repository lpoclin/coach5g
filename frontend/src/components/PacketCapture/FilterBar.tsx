import { useState } from 'react'
import clsx from 'clsx'
import type { CaptureFilter, Protocol } from '@/types/packet'

const PROTOCOLS: (Protocol | '')[] = [
  '', 'GTP-U', 'PFCP', 'HTTP/2', 'SCTP', 'NGAP', 'NAS', 'DNS', 'TCP', 'UDP',
]

interface Props {
  filter: CaptureFilter
  onChange: (f: CaptureFilter) => void
  packetCount: number
  displayCount: number
  dropped: number
  bufferCount: number
  bufferMax: number
  isLive: boolean
}

export default function FilterBar({
  filter,
  onChange,
  packetCount,
  displayCount,
  dropped,
  bufferCount,
  bufferMax,
  isLive,
}: Props) {
  const [raw, setRaw] = useState('')

  const update = (partial: Partial<CaptureFilter>) => {
    onChange({ ...filter, ...partial })
  }

  const handleRawFilter = (v: string) => {
    setRaw(v)
    const lower = v.toLowerCase()
    const protocolMatch = PROTOCOLS.slice(1).find(p => lower === p?.toLowerCase())
    update({
      search: !protocolMatch ? v : '',
      protocol: protocolMatch ?? '',
    })
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-border text-xs">
      {/* Filter input */}
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <span className="text-slate-500 shrink-0">Filter:</span>
        <input
          type="text"
          value={raw || filter.search || (filter.protocol ?? '')}
          onChange={e => handleRawFilter(e.target.value)}
          placeholder="gtp · pfcp · src ip · http2 · free text…"
          className="flex-1 min-w-0 bg-bg-tertiary border border-border focus:border-blue-600/60 rounded
                     px-2 py-0.5 text-xs text-slate-300 placeholder-slate-600 outline-none font-mono"
        />
        {(filter.search || filter.protocol) && (
          <button
            onClick={() => { setRaw(''); update({ search: '', protocol: '' }) }}
            className="text-slate-500 hover:text-slate-300 shrink-0"
          >✕</button>
        )}
      </div>

      {/* Protocol quick filters */}
      <div className="hidden lg:flex items-center gap-1 shrink-0">
        {(['GTP-U', 'PFCP', 'HTTP/2', 'NGAP'] as Protocol[]).map(p => (
          <button
            key={p}
            onClick={() => {
              const next = filter.protocol === p ? '' : p
              setRaw(next)
              update({ protocol: next, search: '' })
            }}
            className={clsx(
              'px-1.5 py-0.5 rounded border text-[10px] font-mono transition-colors',
              filter.protocol === p
                ? 'border-blue-600/50 bg-blue-600/20 text-blue-400'
                : 'border-border text-slate-500 hover:text-slate-300 hover:border-slate-500',
            )}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-border shrink-0" />

      {/* Stats */}
      <div className="flex items-center gap-3 text-[10px] font-mono shrink-0">
        <span>
          <span className="text-slate-500">Pkts: </span>
          <span className="text-slate-300">{packetCount.toLocaleString()}</span>
        </span>
        <span>
          <span className="text-slate-500">Disp: </span>
          <span className="text-slate-300">{displayCount.toLocaleString()}</span>
        </span>
        {dropped > 0 && (
          <span className="text-red-400">Drop: {dropped}</span>
        )}
        <span>
          <span className="text-slate-500">Buf: </span>
          <span className="text-slate-300">
            {bufferCount.toLocaleString()}/{bufferMax.toLocaleString()}
          </span>
        </span>
        <span className={clsx('flex items-center gap-1', isLive ? 'text-green-400' : 'text-slate-500')}>
          <span className={clsx('w-1.5 h-1.5 rounded-full', isLive ? 'bg-green-400 animate-pulse' : 'bg-slate-600')} />
          {isLive ? 'LIVE' : 'STOPPED'}
        </span>
      </div>
    </div>
  )
}
