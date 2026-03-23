'use client';

import { COIN_RATE } from '@/lib/utils';

interface LiveStatusBarProps {
  isLive: boolean;
  elapsedSeconds: number;
  viewerCount: number;
  todayRevenue: number;
  isConnected: boolean;
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function LiveStatusBar({
  isLive,
  elapsedSeconds,
  viewerCount,
  todayRevenue,
  isConnected,
}: LiveStatusBarProps) {
  const jpy = Math.round(todayRevenue * COIN_RATE).toLocaleString();

  return (
    <div
      className="flex items-center justify-between px-6 py-3 rounded-xl"
      style={{
        background: 'linear-gradient(135deg, rgba(15,23,42,0.8), rgba(30,41,59,0.6))',
        borderBottom: '1px solid var(--border-glass)',
      }}
    >
      {/* LIVE indicator + elapsed */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-3 h-3 rounded-full"
            style={{
              background: isLive ? '#ef4444' : '#6b7280',
              boxShadow: isLive ? '0 0 8px rgba(239,68,68,0.6)' : 'none',
              animation: isLive ? 'pulse 2s infinite' : 'none',
            }}
          />
          <span className="font-bold text-lg" style={{ color: isLive ? '#ef4444' : 'var(--text-muted)' }}>
            {isLive ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
        <span
          className="font-mono text-xl font-semibold tabular-nums"
          style={{ color: 'var(--text-primary)' }}
        >
          {formatElapsed(elapsedSeconds)}
        </span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: '18px' }}>👥</span>
          <span className="font-semibold text-lg" style={{ color: 'var(--accent-primary)' }}>
            {viewerCount.toLocaleString()}人
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: '18px' }}>💰</span>
          <span className="font-semibold text-lg" style={{ color: 'var(--accent-amber)' }}>
            {todayRevenue.toLocaleString()} tk
          </span>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            (\u00A5{jpy})
          </span>
        </div>
        {/* Connection status */}
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: isConnected ? '#22c55e' : '#ef4444' }}
          />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {isConnected ? 'Realtime' : '切断'}
          </span>
        </div>
      </div>
    </div>
  );
}
