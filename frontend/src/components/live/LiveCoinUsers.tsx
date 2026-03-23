'use client';

import type { ViewerStatsPoint } from './hooks/useRealtimeCoinUsers';

interface LiveCoinUsersProps {
  latest: ViewerStatsPoint | null;
  history: ViewerStatsPoint[];
}

/**
 * インラインSVGミニグラフ — コイン有りユーザー数の推移
 */
function MiniGraph({ data, width = 240, height = 60 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return null;

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 8) - 4;
    return `${x},${y}`;
  });

  const polyline = points.join(' ');

  // Gradient fill area
  const areaPoints = [
    `0,${height}`,
    ...points,
    `${width},${height}`,
  ].join(' ');

  return (
    <svg width={width} height={height} className="block">
      <defs>
        <linearGradient id="coinGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#coinGrad)" />
      <polyline
        points={polyline}
        fill="none"
        stroke="#f59e0b"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Latest point dot */}
      {data.length > 0 && (() => {
        const lastX = (data.length - 1) * step;
        const lastY = height - ((data[data.length - 1] - min) / range) * (height - 8) - 4;
        return (
          <circle cx={lastX} cy={lastY} r="3" fill="#f59e0b" />
        );
      })()}
    </svg>
  );
}

export default function LiveCoinUsers({ latest, history }: LiveCoinUsersProps) {
  const coinUsersData = history.map((p) => p.coinUsers);

  // Time range label
  const timeRange = history.length >= 2
    ? `${formatTime(history[0].recordedAt)} - ${formatTime(history[history.length - 1].recordedAt)}`
    : '';

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--border-glass)' }}>
        <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
          視聴者ステータス
        </h3>
      </div>

      <div className="px-4 py-3 flex-1">
        {!latest ? (
          <div className="flex items-center justify-center h-20 text-sm" style={{ color: 'var(--text-muted)' }}>
            データ受信待ち...
          </div>
        ) : (
          <>
            {/* Main stats */}
            <div className="flex items-end gap-6 mb-4">
              {/* Coin users - primary */}
              <div>
                <div className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>
                  コイン有り
                </div>
                <div className="font-bold text-3xl tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                  {latest.coinUsers}
                  <span className="text-sm font-normal ml-1" style={{ color: 'var(--text-secondary)' }}>人</span>
                </div>
              </div>

              {/* Ultimate members */}
              <div>
                <div className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>
                  アルティメット
                </div>
                <div className="font-bold text-xl tabular-nums" style={{ color: 'var(--accent-purple)' }}>
                  {latest.ultimateMembers}
                  <span className="text-sm font-normal ml-1" style={{ color: 'var(--text-secondary)' }}>人</span>
                </div>
              </div>

              {/* Total viewers */}
              <div>
                <div className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>
                  総視聴者
                </div>
                <div className="font-bold text-xl tabular-nums" style={{ color: 'var(--accent-primary)' }}>
                  {latest.totalViewers}
                  <span className="text-sm font-normal ml-1" style={{ color: 'var(--text-secondary)' }}>人</span>
                </div>
              </div>
            </div>

            {/* Coin user ratio */}
            {latest.totalViewers > 0 && (
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    コイン有り率
                  </span>
                  <span className="text-xs font-bold" style={{ color: 'var(--accent-amber)' }}>
                    {((latest.coinUsers / latest.totalViewers) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min((latest.coinUsers / latest.totalViewers) * 100, 100)}%`,
                      background: 'linear-gradient(90deg, #f59e0b, #fbbf24)',
                    }}
                  />
                </div>
              </div>
            )}

            {/* Mini trend graph */}
            {coinUsersData.length >= 2 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    コイン有り推移
                  </span>
                  <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {timeRange}
                  </span>
                </div>
                <MiniGraph data={coinUsersData} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  });
}
