'use client';

import { useRef, useEffect } from 'react';

const LEAGUE_COLORS: Record<string, string> = {
  grey: '#888888',
  bronze: '#de884a',
  silver: '#c0c0c0',
  gold: '#ffcc00',
  diamond: '#b9f2ff',
  royal: '#ff1a1a',
  legend: '#9933ff',
};

const VIP_LEAGUES = new Set(['legend', 'royal', 'diamond']);

export type UserCategory = 'new' | 'repeater' | 'return';

export interface LiveUser {
  userName: string;
  category: UserCategory;
  daysSince: number | null;       // null = first visit
  firstPaidDate: string | null;   // null = no payment history
  totalTip: number;
  enteredAt: string;
  league: string | null;
  level: number | null;
}

interface LiveUserFeedProps {
  users: LiveUser[];
}

function categoryLabel(cat: UserCategory): { text: string; bg: string; color: string } {
  switch (cat) {
    case 'new':
      return { text: '新規', bg: 'rgba(59,130,246,0.15)', color: '#60a5fa' };
    case 'repeater':
      return { text: 'リピ', bg: 'rgba(34,197,94,0.15)', color: '#4ade80' };
    case 'return':
      return { text: '復帰', bg: 'rgba(245,158,11,0.15)', color: '#fbbf24' };
  }
}

function getNameColor(league: string | null): string {
  if (!league) return 'var(--text-primary)';
  return LEAGUE_COLORS[league] ?? 'var(--text-primary)';
}

export default function LiveUserFeed({ users }: LiveUserFeedProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [users.length]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: '1px solid var(--border-glass)' }}>
        <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
          ユーザーフィード
        </h3>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {users.length}人検出
        </span>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-1" style={{ maxHeight: 'calc(100vh - 320px)' }}>
        {users.length === 0 && (
          <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'var(--text-muted)' }}>
            配信中のユーザー入室を検出中...
          </div>
        )}

        {users.map((u, idx) => {
          const cat = categoryLabel(u.category);
          const isVip = u.league ? VIP_LEAGUES.has(u.league) : false;
          const isNew = idx >= users.length - 3; // last 3 entries get highlight animation

          return (
            <div
              key={`${u.userName}-${u.enteredAt}`}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-1 ${isNew ? 'anim-fade' : ''}`}
              style={{
                background: isNew
                  ? 'rgba(56,189,248,0.06)'
                  : 'transparent',
                border: isVip
                  ? '1px solid rgba(255,204,0,0.3)'
                  : '1px solid transparent',
              }}
            >
              {/* Category tag */}
              <span
                className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                style={{ background: cat.bg, color: cat.color }}
              >
                {cat.text}
              </span>

              {/* Return icon */}
              {u.category === 'return' && <span className="shrink-0">⭐</span>}

              {/* Username */}
              <span
                className="font-semibold text-sm truncate"
                style={{ color: getNameColor(u.league), maxWidth: '140px' }}
              >
                {u.userName}
              </span>

              {/* Days since info */}
              <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                {u.category === 'new'
                  ? '初来訪'
                  : u.daysSince != null
                    ? `${u.daysSince}日ぶり`
                    : ''}
              </span>

              {/* Tip info */}
              <span className="text-[11px] ml-auto shrink-0" style={{ color: 'var(--text-secondary)' }}>
                {u.firstPaidDate
                  ? `初課金: ${u.firstPaidDate.slice(5)}`
                  : '未課金'}
              </span>

              {u.totalTip > 0 && (
                <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--accent-amber)' }}>
                  {u.totalTip.toLocaleString()}tk
                </span>
              )}

              {/* Time */}
              <span className="text-[10px] tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>
                {new Date(u.enteredAt).toLocaleTimeString('ja-JP', {
                  timeZone: 'Asia/Tokyo',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
