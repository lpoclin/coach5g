import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import { api } from '@/services/api'
import { Skeleton } from '@/components/common/LoadingSkeleton'
import type { ClusterTimeSeries } from '@/types/k8s'

type Range = '1h' | '6h' | '24h'

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Chart({
  data,
  dataKey,
  color,
  label,
}: {
  data: { time: string; value: number }[]
  dataKey: string
  color: string
  label: string
}) {
  const last = data[data.length - 1]?.value ?? 0

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400 font-semibold uppercase tracking-wide">{label}</span>
        <span className="font-mono text-sm font-bold" style={{ color }}>
          {last.toFixed(1)}%
        </span>
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <AreaChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2d4a" vertical={false} />
          <XAxis
            dataKey="time"
            tick={{ fill: '#475569', fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fill: '#475569', fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            width={24}
            tickFormatter={v => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              background: '#0f1629',
              border: '1px solid #1e2d4a',
              borderRadius: 6,
              fontSize: 11,
              color: '#e2e8f0',
            }}
            labelStyle={{ color: '#94a3b8' }}
            formatter={(v: number) => [`${v.toFixed(1)}%`, label]}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#grad-${dataKey})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function TimeSeriesChart() {
  const [range, setRange] = useState<Range>('1h')

  const { data, isLoading } = useQuery<ClusterTimeSeries>({
    queryKey: ['timeseries', range],
    queryFn: () => api.metrics.timeseries(range),
    refetchInterval: 30_000,
  })

  const cpuData = (data?.cpuPercent ?? []).map(p => ({
    time: formatTime(p.timestamp),
    value: p.value,
  }))
  const ramData = (data?.memoryPercent ?? []).map(p => ({
    time: formatTime(p.timestamp),
    value: p.value,
  }))

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="label">Cluster utilization</span>
        <div className="flex items-center gap-1">
          {(['1h', '6h', '24h'] as Range[]).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`text-xs px-2 py-0.5 rounded ${
                range === r
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </>
      ) : (
        <>
          <Chart data={cpuData} dataKey="value" color="#3b82f6" label="CPU %" />
          <Chart data={ramData} dataKey="value" color="#a855f7" label="RAM %" />
        </>
      )}
    </div>
  )
}
