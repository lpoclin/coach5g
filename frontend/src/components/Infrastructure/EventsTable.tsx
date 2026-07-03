import clsx from 'clsx'
import type { K8sEvent } from '@/types/k8s'

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

export default function EventsTable({ events }: { events: K8sEvent[] }) {
  if (!events.length) {
    return <div className="text-slate-600 text-sm text-center py-4">No recent events</div>
  }

  return (
    <div className="space-y-0.5">
      {events.map((ev, i) => (
        <div
          key={ev.name + i}
          className={clsx(
            'flex items-start gap-2 px-2 py-1.5 rounded text-xs hover:bg-bg-hover/50 transition-colors',
          )}
        >
          {/* Type icon */}
          <span
            className={clsx(
              'shrink-0 mt-px',
              ev.type === 'Warning' ? 'text-yellow-400' : 'text-slate-500',
            )}
          >
            {ev.type === 'Warning' ? '⚠' : '·'}
          </span>

          {/* Time */}
          <span className="text-slate-600 shrink-0 w-8 text-right font-mono">
            {timeAgo(ev.lastTime)}
          </span>

          {/* Namespace + object */}
          <span className="text-slate-500 shrink-0 w-24 truncate font-mono">
            {ev.namespace}
          </span>
          <span className="text-slate-400 shrink-0 w-28 truncate font-mono">
            {ev.involvedObject.name}
          </span>

          {/* Reason */}
          <span
            className={clsx(
              'shrink-0 font-semibold w-28 truncate',
              ev.type === 'Warning' ? 'text-yellow-400' : 'text-slate-400',
            )}
          >
            {ev.reason}
          </span>

          {/* Message */}
          <span className="text-slate-500 flex-1 min-w-0 truncate" title={ev.message}>
            {ev.message}
          </span>

          {/* Count */}
          {ev.count > 1 && (
            <span className="text-slate-600 shrink-0 font-mono">×{ev.count}</span>
          )}
        </div>
      ))}
    </div>
  )
}
