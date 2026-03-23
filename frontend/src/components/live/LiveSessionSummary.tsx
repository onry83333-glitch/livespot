'use client';

import { COIN_RATE } from '@/lib/utils';

interface LiveSessionSummaryProps {
  todayRevenue: number;
  todayTipCount: number;
  peakViewerCount: number;
  newUserCount: number;
  returnUserCount: number;
}

export default function LiveSessionSummary({
  todayRevenue,
  todayTipCount,
  peakViewerCount,
  newUserCount,
  returnUserCount,
}: LiveSessionSummaryProps) {
  const jpy = Math.round(todayRevenue * COIN_RATE).toLocaleString();

  const stats = [
    { label: '累計売上', value: `${todayRevenue.toLocaleString()} tk (\u00A5${jpy})`, color: 'var(--accent-amber)' },
    { label: 'チップ回数', value: `${todayTipCount}回`, color: 'var(--accent-primary)' },
    { label: 'ピーク視聴者', value: `${peakViewerCount}人`, color: 'var(--accent-purple)' },
    { label: '新規来訪者', value: `${newUserCount}人`, color: '#60a5fa' },
    { label: '復帰来訪者', value: `${returnUserCount}人`, color: '#fbbf24' },
  ];

  return (
    <div
      className="flex items-center justify-around px-6 py-3"
      style={{
        background: 'rgba(15,23,42,0.6)',
        borderTop: '1px solid var(--border-glass)',
      }}
    >
      {stats.map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {s.label}
          </span>
          <span className="font-bold text-sm" style={{ color: s.color }}>
            {s.value}
          </span>
        </div>
      ))}
    </div>
  );
}
