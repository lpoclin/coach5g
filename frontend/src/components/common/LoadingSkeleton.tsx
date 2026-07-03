import clsx from 'clsx'

interface SkeletonProps {
  className?: string
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={clsx(
        'animate-pulse rounded bg-bg-hover',
        className,
      )}
    />
  )
}

export function TopologySkeleton() {
  return (
    <div className="flex-1 p-4 flex flex-col gap-3">
      <div className="flex gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-24" />
        ))}
      </div>
      <div className="flex gap-3 ml-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-24" />
        ))}
      </div>
      <div className="flex gap-3 ml-16">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-24" />
        ))}
      </div>
      <div className="flex gap-3 ml-24">
        <Skeleton className="h-16 w-24" />
      </div>
    </div>
  )
}

export function NodeCardSkeleton() {
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Skeleton className="w-3 h-3 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-3 w-20" />
      <div className="flex gap-2">
        <Skeleton className="h-2 flex-1" />
        <Skeleton className="h-2 w-10" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-2 flex-1" />
        <Skeleton className="h-2 w-10" />
      </div>
    </div>
  )
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-2 items-center">
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  )
}
