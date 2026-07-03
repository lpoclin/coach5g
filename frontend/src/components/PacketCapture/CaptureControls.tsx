import clsx from 'clsx'
import { IconPlay, IconStop, IconPause, IconDownload } from '@/components/common/icons'
import { api } from '@/services/api'
import type { CaptureSession } from '@/types/packet'
import type { TopologyNode } from '@/types/topology'

interface Props {
  session: CaptureSession | undefined
  allNodes: TopologyNode[]
  selectedNode: string
  selectedIface: string
  onNodeChange: (n: string) => void
  onIfaceChange: (i: string) => void
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
  onClear: () => void
}

const IFACES = ['eth0', 'n2', 'n3', 'n4', 'n6', 'n9', 'upfgtp', 'uesimtun0']

export default function CaptureControls({
  session,
  allNodes,
  selectedNode,
  selectedIface,
  onNodeChange,
  onIfaceChange,
  onStart,
  onStop,
  onPause,
  onResume,
  onClear,
}: Props) {
  const status = session?.status
  const isRunning = status === 'active'
  const isPaused = status === 'paused'
  const isConnecting = status === 'connecting'
  const isStopped = !status || status === 'stopped' || status === 'error'

  const handleExport = () => {
    if (session) {
      window.open(api.capture.exportUrl(session.id), '_blank')
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-border text-xs">
      {/* NF selector */}
      <span className="text-slate-500 shrink-0">NF</span>
      <select
        value={selectedNode}
        onChange={e => onNodeChange(e.target.value)}
        disabled={isRunning || isConnecting}
        className="bg-bg-card border border-border rounded px-2 py-0.5 text-slate-300 outline-none
                   disabled:opacity-40 text-xs font-mono"
      >
        <option value="">— select NF —</option>
        {allNodes.map(n => (
          <option key={n.id} value={n.id}>
            {n.nfType} · {n.podName}
          </option>
        ))}
      </select>

      {/* Interface selector */}
      <span className="text-slate-500 shrink-0">Interface</span>
      <select
        value={selectedIface}
        onChange={e => onIfaceChange(e.target.value)}
        disabled={isRunning || isConnecting}
        className="bg-bg-card border border-border rounded px-2 py-0.5 text-slate-300 outline-none
                   disabled:opacity-40 text-xs font-mono"
      >
        {IFACES.map(i => (
          <option key={i} value={i}>{i}</option>
        ))}
      </select>

      {/* Divider */}
      <div className="h-4 w-px bg-border mx-1 shrink-0" />

      {/* Capture buttons */}
      {isStopped && (
        <button
          onClick={onStart}
          disabled={!selectedNode}
          className={clsx('btn-primary text-xs gap-1', !selectedNode && 'opacity-40 cursor-not-allowed')}
        >
          <IconPlay className="w-3.5 h-3.5" /> Start
        </button>
      )}

      {(isRunning || isConnecting) && (
        <>
          <button onClick={onPause} className="btn-secondary text-xs">
            <IconPause className="w-3.5 h-3.5" /> Pause
          </button>
          <button onClick={onStop} className="btn-danger text-xs">
            <IconStop className="w-3.5 h-3.5" /> Stop
          </button>
        </>
      )}

      {isPaused && (
        <>
          <button onClick={onResume} className="btn-primary text-xs">
            <IconPlay className="w-3.5 h-3.5" /> Resume
          </button>
          <button onClick={onStop} className="btn-danger text-xs">
            <IconStop className="w-3.5 h-3.5" /> Stop
          </button>
        </>
      )}

      <button
        onClick={onClear}
        className="btn-secondary text-xs"
        disabled={!session}
      >
        Clear
      </button>

      {/* Export */}
      <button
        onClick={handleExport}
        disabled={!session}
        className="btn-secondary text-xs ml-auto gap-1"
        title="Download .pcap"
      >
        <IconDownload className="w-3.5 h-3.5" /> .pcap
      </button>
    </div>
  )
}
