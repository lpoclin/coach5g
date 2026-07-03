import type { LogLevel } from '@/hooks/useLogs'

interface Props {
  search: string
  level: LogLevel
  onSearch: (s: string) => void
  onLevel: (l: LogLevel) => void
  showTimestamps: boolean
  onToggleTimestamps: () => void
  autoScroll: boolean
  onToggleAutoScroll: () => void
  lineCount: number
  filteredCount: number
}

const LEVELS: LogLevel[] = ['all', 'info', 'warn', 'error', 'debug']

export default function LogFilter({
  search,
  level,
  onSearch,
  onLevel,
  showTimestamps,
  onToggleTimestamps,
  autoScroll,
  onToggleAutoScroll,
  lineCount,
  filteredCount,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-border text-xs shrink-0">
      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={e => onSearch(e.target.value)}
        placeholder="Search logs…"
        className="flex-1 min-w-0 bg-bg-card border border-border focus:border-blue-600/60 rounded
                   px-2 py-0.5 text-xs text-slate-300 placeholder-slate-600 outline-none font-mono"
      />

      {/* Level filter */}
      <div className="flex items-center gap-1 shrink-0">
        {LEVELS.map(l => (
          <button
            key={l}
            onClick={() => onLevel(l)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
              level === l
                ? l === 'error'   ? 'bg-red-900/40 text-red-400 border border-red-800/60'
                  : l === 'warn'  ? 'bg-yellow-900/40 text-yellow-400 border border-yellow-800/60'
                  : l === 'debug' ? 'bg-slate-700/40 text-slate-400 border border-slate-600/60'
                  : 'bg-blue-600/20 text-blue-400 border border-blue-600/40'
                : 'text-slate-600 hover:text-slate-400'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Toggles */}
      <button
        onClick={onToggleTimestamps}
        className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
          showTimestamps ? 'text-blue-400' : 'text-slate-600 hover:text-slate-400'
        }`}
        title="Toggle timestamps"
      >
        TS
      </button>
      <button
        onClick={onToggleAutoScroll}
        className={`text-[10px] px-1.5 py-0.5 rounded transition-colors flex items-center gap-1 ${
          autoScroll ? 'text-green-400' : 'text-slate-600 hover:text-slate-400'
        }`}
        title="Auto-scroll"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${autoScroll ? 'bg-green-400' : 'bg-slate-600'}`} />
        AUTO
      </button>

      {/* Stats */}
      <span className="text-[10px] font-mono text-slate-600 shrink-0">
        {filteredCount === lineCount
          ? `${lineCount.toLocaleString()} lines`
          : `${filteredCount.toLocaleString()} / ${lineCount.toLocaleString()}`}
      </span>
    </div>
  )
}
