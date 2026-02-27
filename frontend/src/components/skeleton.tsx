/**
 * P0-3: 統一スケルトンローダーコンポーネント
 */

export function SkeletonLine({ width = '100%', height = '1rem' }: { width?: string; height?: string }) {
  return (
    <div
      className="skeleton-pulse rounded"
      style={{ width, height, background: 'rgba(148, 163, 184, 0.08)' }}
    />
  );
}

export function SkeletonCard() {
  return (
    <div className="glass-card p-6 space-y-4">
      <SkeletonLine width="40%" height="1.25rem" />
      <SkeletonLine width="70%" />
      <SkeletonLine width="55%" />
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="glass-card p-4 space-y-3">
      {/* Header */}
      <div className="flex gap-4 pb-3" style={{ borderBottom: '1px solid var(--border-glass)' }}>
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonLine key={i} width={i === 0 ? '30%' : '20%'} height="0.875rem" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 py-2">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonLine key={c} width={c === 0 ? '30%' : '20%'} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonKPI({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(count, 4)}, 1fr)` }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="glass-card p-5 space-y-3">
          <SkeletonLine width="50%" height="0.75rem" />
          <SkeletonLine width="60%" height="1.75rem" />
          <SkeletonLine width="40%" height="0.625rem" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonPageLayout() {
  return (
    <div className="space-y-6 p-6 anim-fade">
      {/* Page header */}
      <div className="space-y-2">
        <SkeletonLine width="200px" height="1.5rem" />
        <SkeletonLine width="300px" height="0.875rem" />
      </div>
      {/* KPI cards */}
      <SkeletonKPI count={4} />
      {/* Table */}
      <SkeletonTable rows={6} cols={4} />
    </div>
  );
}

export function SkeletonDetailLayout() {
  return (
    <div className="space-y-6 p-6 anim-fade">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="skeleton-pulse rounded-full" style={{ width: 48, height: 48, background: 'rgba(148, 163, 184, 0.08)' }} />
        <div className="space-y-2">
          <SkeletonLine width="180px" height="1.25rem" />
          <SkeletonLine width="120px" height="0.75rem" />
        </div>
      </div>
      {/* Tabs */}
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonLine key={i} width="80px" height="2rem" />
        ))}
      </div>
      {/* Content */}
      <SkeletonKPI count={3} />
      <SkeletonCard />
    </div>
  );
}
