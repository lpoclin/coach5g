import { useRef, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import type { LogLine } from '@/hooks/useLogs'

interface Props {
  lines: LogLine[]
  showTimestamps: boolean
  autoScroll: boolean
  search?: string
  onPauseScroll: () => void
  onResumeScroll: () => void
}

const LEVEL_COLORS: Record<string, string> = {
  error:   'text-red-400',
  warn:    'text-yellow-400',
  debug:   'text-slate-600',
  info:    'text-slate-300',
  unknown: 'text-slate-400',
}

function highlight(text: string, search: string): React.ReactNode {
  if (!search) return text
  const idx = text.toLowerCase().indexOf(search.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-400/30 text-yellow-200 rounded-sm">{text.slice(idx, idx + search.length)}</mark>
      {text.slice(idx + search.length)}
    </>
  )
}

export default function LogPanel({
  lines,
  showTimestamps,
  autoScroll,
  search = '',
  onPauseScroll,
  onResumeScroll,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 18,
    overscan: 25,
  })

  useEffect(() => {
    if (autoScroll && lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: 'end' })
    }
  }, [lines.length, autoScroll, virtualizer])

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto bg-bg-primary"
      onMouseEnter={onPauseScroll}
      onMouseLeave={onResumeScroll}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => {
          const line = lines[item.index]!
          return (
            <div
              key={item.key}
              style={{
                position: 'absolute',
                top: item.start,
                width: '100%',
                height: item.size,
              }}
              className="flex items-baseline gap-2 px-2 hover:bg-bg-hover/40 text-xs font-mono"
            >
              {showTimestamps && (
                <span className="text-slate-600 shrink-0 text-[10px] font-mono">
                  {line.timestamp.slice(11, 19)}
                </span>
              )}
              <span className={clsx(
                'shrink-0 w-10 text-right',
                LEVEL_COLORS[line.level] ?? 'text-slate-400',
              )}>
                {line.level !== 'unknown' ? line.level.slice(0, 4).toUpperCase() : '    '}
              </span>
              <span className={clsx('flex-1 min-w-0 break-all leading-[18px]', LEVEL_COLORS[line.level] ?? 'text-slate-400')}>
                {highlight(
                  line.message.length > 400 ? line.message.slice(0, 400) + '…' : line.message,
                  search,
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
