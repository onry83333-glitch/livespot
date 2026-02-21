'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';

interface SyncStatus {
  cast_name: string;
  last_synced_at: string | null;
  hours_since_sync: number;
  transaction_count: number;
  needs_sync: boolean;
}

export function CoinSyncAlert() {
  const { user } = useAuth();
  const [statuses, setStatuses] = useState<SyncStatus[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!user || fetchedRef.current) return;
    fetchedRef.current = true;

    const sb = createClient();
    sb.rpc('get_coin_sync_status').then(({ data, error }) => {
      if (!error && data) {
        setStatuses(data as SyncStatus[]);
      }
    });
  }, [user]);

  if (dismissed || !user) return null;

  const needsSync = statuses.filter(s => s.needs_sync);
  if (needsSync.length === 0) return null;

  const hasUrgent = needsSync.some(s => s.hours_since_sync >= 48);

  return (
    <div
      className="px-4 py-2.5 flex items-center gap-3 text-xs"
      style={{
        background: hasUrgent
          ? 'linear-gradient(90deg, rgba(244,63,94,0.12), rgba(244,63,94,0.04))'
          : 'linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.04))',
        borderBottom: `1px solid ${hasUrgent ? 'rgba(244,63,94,0.2)' : 'rgba(245,158,11,0.2)'}`,
      }}
    >
      <span>{hasUrgent ? '🔴' : '⚠️'}</span>
      <div className="flex-1 min-w-0">
        <span className="font-semibold" style={{ color: hasUrgent ? 'var(--accent-pink)' : 'var(--accent-amber)' }}>
          コイン同期が必要:
        </span>{' '}
        <span style={{ color: 'var(--text-secondary)' }}>
          {needsSync.map((s, i) => (
            <span key={s.cast_name}>
              {i > 0 && '、'}
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{s.cast_name}</span>
              <span style={{ color: s.hours_since_sync >= 48 ? 'var(--accent-pink)' : 'var(--accent-amber)' }}>
                （{s.hours_since_sync >= 999 ? '未同期' : `${s.hours_since_sync}h前`}）
              </span>
            </span>
          ))}
        </span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center transition-colors"
        style={{ color: 'var(--text-muted)' }}
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
      >
        ✕
      </button>
    </div>
  );
}
