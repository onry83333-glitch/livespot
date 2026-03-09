'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';

interface SyncStatus {
  cast_name: string;
  last_synced_at: string | null;
  hours_since_sync: number;
  transaction_count: number;
  needs_sync: boolean;
}

const DISMISS_KEY = 'livespot_coin_sync_dismissed';
const REFRESH_INTERVAL = 10 * 60 * 1000; // 10分

function getDismissedUntil(): number {
  if (typeof window === 'undefined') return 0;
  try {
    return parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
  } catch {
    return 0;
  }
}

function formatSyncTime(hoursAgo: number): string {
  if (hoursAgo >= 999) return '未同期';
  if (hoursAgo < 1) return `${Math.round(hoursAgo * 60)}分前`;
  if (hoursAgo < 24) return `${Math.round(hoursAgo)}時間前`;
  const days = Math.floor(hoursAgo / 24);
  const hrs = Math.round(hoursAgo % 24);
  return `${days}日${hrs}時間前`;
}

export function CoinSyncAlert() {
  const { user } = useAuth();
  const [statuses, setStatuses] = useState<SyncStatus[]>([]);
  const [dismissed, setDismissed] = useState(() => getDismissedUntil() > Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!user) return;
    const sb = createClient();
    const { data, error } = await sb.rpc('get_coin_sync_status');
    if (!error && data) {
      setStatuses(data as SyncStatus[]);
    }
  }, [user]);

  // 初回 + 10分リフレッシュ
  useEffect(() => {
    fetchStatus();
    timerRef.current = setInterval(fetchStatus, REFRESH_INTERVAL);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchStatus]);

  // dismissは1時間有効
  const handleDismiss = () => {
    const until = Date.now() + 60 * 60 * 1000; // 1h
    localStorage.setItem(DISMISS_KEY, String(until));
    setDismissed(true);
  };

  // dismiss期限チェック
  useEffect(() => {
    if (dismissed && getDismissedUntil() <= Date.now()) {
      setDismissed(false);
    }
  }, [statuses, dismissed]);

  if (dismissed || !user) return null;

  const needsSync = statuses.filter(s => s.needs_sync);
  if (needsSync.length === 0) return null;

  const hasCritical = needsSync.some(s => s.hours_since_sync >= 48);
  const maxHours = Math.max(...needsSync.map(s => s.hours_since_sync));

  return (
    <div
      className="px-4 py-2.5 flex items-center gap-3 text-xs"
      style={{
        background: hasCritical
          ? 'linear-gradient(90deg, rgba(244,63,94,0.15), rgba(244,63,94,0.04))'
          : 'linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.04))',
        borderBottom: `1px solid ${hasCritical ? 'rgba(244,63,94,0.25)' : 'rgba(245,158,11,0.2)'}`,
      }}
    >
      <span className="text-sm">{hasCritical ? '🔴' : '⚠️'}</span>
      <div className="flex-1 min-w-0">
        <span
          className="font-semibold"
          style={{ color: hasCritical ? 'var(--accent-pink)' : 'var(--accent-amber)' }}
        >
          {hasCritical ? 'コイン同期停止' : 'コイン同期が必要'}
          {needsSync.length > 1 && ` (${needsSync.length}キャスト)`}:
        </span>{' '}
        <span style={{ color: 'var(--text-secondary)' }}>
          {needsSync
            .sort((a, b) => b.hours_since_sync - a.hours_since_sync)
            .map((s, i) => (
              <span key={s.cast_name}>
                {i > 0 && '、'}
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {s.cast_name}
                </span>
                <span
                  style={{
                    color: s.hours_since_sync >= 48 ? 'var(--accent-pink)' : 'var(--accent-amber)',
                  }}
                >
                  （{formatSyncTime(s.hours_since_sync)}）
                </span>
              </span>
            ))}
        </span>
        {maxHours >= 48 && (
          <span
            className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold"
            style={{
              background: 'rgba(244,63,94,0.2)',
              color: 'var(--accent-pink)',
            }}
          >
            緊急
          </span>
        )}
      </div>
      <button
        onClick={handleDismiss}
        className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center transition-colors"
        style={{ color: 'var(--text-muted)' }}
        title="1時間非表示"
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
      >
        ✕
      </button>
    </div>
  );
}
