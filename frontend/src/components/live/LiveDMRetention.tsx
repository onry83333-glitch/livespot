'use client';

interface LiveDMRetentionProps {
  dmSentCount: number;
  visitedUsers: string[];
}

export default function LiveDMRetention({ dmSentCount, visitedUsers }: LiveDMRetentionProps) {
  const cvr = dmSentCount > 0
    ? ((visitedUsers.length / dmSentCount) * 100).toFixed(1)
    : '0.0';

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--border-glass)' }}>
        <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
          DMリテンション
        </h3>
      </div>

      <div className="px-4 py-3 flex-1">
        {/* Summary stats */}
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>DM</span>
          <span className="font-bold text-lg" style={{ color: 'var(--accent-primary)' }}>
            {dmSentCount}人
          </span>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>中</span>
          <span className="font-bold text-lg" style={{ color: 'var(--accent-green)' }}>
            {visitedUsers.length}人
          </span>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>来訪</span>
        </div>

        {/* CVR bar */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>CVR</span>
            <span className="font-bold text-sm" style={{ color: 'var(--accent-green)' }}>
              {cvr}%
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(parseFloat(cvr), 100)}%`,
                background: 'linear-gradient(90deg, #22c55e, #4ade80)',
              }}
            />
          </div>
        </div>

        {/* Visited user list */}
        {visitedUsers.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>来訪済み:</span>
            <div className="flex flex-wrap gap-1">
              {visitedUsers.map((name) => (
                <span
                  key={name}
                  className="text-[11px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'rgba(34,197,94,0.1)',
                    color: '#4ade80',
                  }}
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
