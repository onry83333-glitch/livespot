'use client';

import { useState, useEffect, useCallback } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

interface SyncHealthRow {
  cast_name: string;
  sync_type: string;
  last_sync_at: string | null;
  status: string;
  error_count: number;
  last_error: string | null;
  minutes_since_sync: number | null;
  auto_status: string;
}

interface SyncTypeInfo {
  label: string;
  icon: string;
  description: string;
}

type SyncAction = 'coin_sync' | 'spy_chat' | 'spy_viewer' | 'all';
type ActionStatus = 'idle' | 'running' | 'done' | 'error';

interface Props {
  supabase: SupabaseClient;
  accountId: string;
  castName: string;
}

// ============================================================
// Constants
// ============================================================

const SYNC_TYPES: Record<string, SyncTypeInfo> = {
  coin_sync:   { label: 'コイン同期',   icon: '🪙', description: 'Stripchat Earnings APIからコイン履歴を取得' },
  spy_chat:    { label: 'SPYチャット',   icon: '💬', description: 'リアルタイムチャット監視からのtip/gift' },
  spy_viewer:  { label: 'SPY視聴者',    icon: '👀', description: '視聴者リスト・リーグ・レベル' },
  screenshot:  { label: 'スクショ',     icon: '📸', description: '配信画面の定期キャプチャ' },
};

const STALE_THRESHOLD_HOURS = 24;
const STALE_THRESHOLD_MS = STALE_THRESHOLD_HOURS * 60 * 60 * 1000;

function formatElapsed(minutes: number | null): string {
  if (minutes === null || minutes < 0) return '未取得';
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${Math.round(minutes)}分前`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}時間前`;
  const days = hours / 24;
  return `${Math.round(days)}日前`;
}

function getStatusColor(autoStatus: string): string {
  switch (autoStatus) {
    case 'ok': return '#22c55e';
    case 'warn': return '#f59e0b';
    case 'error': return '#ef4444';
    default: return '#64748b';
  }
}

function getStatusBg(autoStatus: string): string {
  switch (autoStatus) {
    case 'ok': return 'rgba(34,197,94,0.1)';
    case 'warn': return 'rgba(245,158,11,0.1)';
    case 'error': return 'rgba(239,68,68,0.1)';
    default: return 'rgba(100,116,139,0.06)';
  }
}

// ============================================================
// Component
// ============================================================

export default function DataSyncPanel({ supabase, accountId, castName }: Props) {
  const [healthRows, setHealthRows] = useState<SyncHealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionStatus, setActionStatus] = useState<Record<string, ActionStatus>>({});
  const [actionMessages, setActionMessages] = useState<Record<string, string>>({});
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Fallback timestamps from direct queries
  const [fallbackTimes, setFallbackTimes] = useState<Record<string, string | null>>({
    coin_sync: null,
    spy_chat: null,
    spy_viewer: null,
    screenshot: null,
  });

  // ============================================================
  // Data fetching
  // ============================================================

  const fetchSyncHealth = useCallback(async () => {
    setLoading(true);

    // 1) Try sync_health RPC (may not exist on all deployments)
    const { data: healthData, error: rpcErr } = await supabase.rpc('get_sync_health', { p_account_id: accountId });

    const castRows = (!rpcErr && healthData)
      ? ((healthData || []) as SyncHealthRow[]).filter((r) => r.cast_name === castName)
      : [];
    setHealthRows(castRows);

    // 2) Always query actual tables for fresh timestamps (RPC may be missing or stale)
    const hasCoin = castRows.some((r) => r.sync_type === 'coin_sync' && r.last_sync_at);
    const hasSpy = castRows.some((r) => r.sync_type === 'spy_chat' && r.last_sync_at);
    const hasViewer = castRows.some((r) => r.sync_type === 'spy_viewer' && r.last_sync_at);

    const fb: Record<string, string | null> = { coin_sync: null, spy_chat: null, spy_viewer: null, screenshot: null };

    if (!hasCoin) {
      const { data: coinData } = await supabase
        .from('coin_transactions')
        .select('synced_at')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .order('synced_at', { ascending: false })
        .limit(1);
      fb.coin_sync = coinData?.[0]?.synced_at || null;
    }

    if (!hasSpy) {
      // Use spy_messages (primary chat data), not chat_logs (v2 table with minimal data)
      const { data: spyData } = await supabase
        .from('spy_messages')
        .select('created_at')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .order('created_at', { ascending: false })
        .limit(1);
      fb.spy_chat = spyData?.[0]?.created_at || null;
    }

    if (!hasViewer) {
      const { data: viewerData } = await supabase
        .from('spy_viewers')
        .select('last_seen_at')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .order('last_seen_at', { ascending: false })
        .limit(1);
      fb.spy_viewer = viewerData?.[0]?.last_seen_at || null;
    }

    // Screenshot: check cast_screenshots for latest
    {
      const { data: ssData } = await supabase
        .from('cast_screenshots')
        .select('created_at')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .order('created_at', { ascending: false })
        .limit(1);
      fb.screenshot = ssData?.[0]?.created_at || null;
    }

    setFallbackTimes(fb);
    setLastRefresh(new Date());
    setLoading(false);
  }, [supabase, accountId, castName]);

  useEffect(() => {
    if (!accountId || !castName) return;
    fetchSyncHealth();
  }, [fetchSyncHealth, accountId, castName]);

  // ============================================================
  // Build display data
  // ============================================================

  const displayItems = (['coin_sync', 'spy_chat', 'spy_viewer', 'screenshot'] as const).map((syncType) => {
    const row = healthRows.find((r) => r.sync_type === syncType);
    const typeInfo = SYNC_TYPES[syncType];

    if (row) {
      return {
        syncType,
        ...typeInfo,
        lastSyncAt: row.last_sync_at,
        minutesSince: row.minutes_since_sync,
        autoStatus: row.auto_status,
        errorCount: row.error_count,
        lastError: row.last_error,
      };
    }

    // Fallback
    const fbTime = fallbackTimes[syncType] || null;
    const minutesSince = fbTime ? (Date.now() - new Date(fbTime).getTime()) / 60000 : null;
    const autoStatus = fbTime === null
      ? 'unknown'
      : minutesSince !== null && minutesSince > 120
        ? 'warn'
        : 'ok';

    return {
      syncType,
      ...typeInfo,
      lastSyncAt: fbTime,
      minutesSince,
      autoStatus,
      errorCount: 0,
      lastError: null,
    };
  });

  // Stale alert: any sync type > 60 hours
  const staleItems = displayItems.filter((item) => {
    if (!item.lastSyncAt) return false;
    const elapsed = Date.now() - new Date(item.lastSyncAt).getTime();
    return elapsed > STALE_THRESHOLD_MS;
  });
  const hasStaleData = staleItems.length > 0;
  const oldestStaleHours = staleItems.length > 0
    ? Math.max(...staleItems.map((s) => (s.minutesSince || 0) / 60))
    : 0;

  // ============================================================
  // Manual sync actions
  // ============================================================

  const triggerSync = useCallback(async (action: SyncAction) => {
    const types = action === 'all'
      ? ['coin_sync', 'spy_chat', 'spy_viewer']
      : [action];

    for (const t of types) {
      setActionStatus((prev) => ({ ...prev, [t]: 'running' }));
      setActionMessages((prev) => ({ ...prev, [t]: '' }));
    }

    const GUIDANCE: Record<string, string> = {
      coin_sync: 'Chrome拡張のEarningsページでコイン同期を実行してください',
      spy_chat: 'Collectorが自動収集中。Chrome拡張でSPY監視も可能です',
      spy_viewer: 'Collectorが自動収集中。配信中のみ視聴者リストを取得します',
    };

    for (const syncType of types) {
      setActionStatus((prev) => ({ ...prev, [syncType]: 'done' }));
      setActionMessages((prev) => ({
        ...prev,
        [syncType]: GUIDANCE[syncType] || '同期はバックグラウンドで実行されます',
      }));
    }

    // Refresh to show latest data
    setTimeout(() => fetchSyncHealth(), 500);
  }, [fetchSyncHealth]);

  // ============================================================
  // Render
  // ============================================================

  return (
    <div className="space-y-3">
      {/* Stale data warning banner */}
      {hasStaleData && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs border"
          style={{
            background: oldestStaleHours >= 120 ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)',
            borderColor: oldestStaleHours >= 120 ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)',
            color: oldestStaleHours >= 120 ? '#fca5a5' : '#fcd34d',
          }}
        >
          <span>{oldestStaleHours >= 120 ? '🔴' : '⚠️'}</span>
          <span>
            {staleItems.map((s) => SYNC_TYPES[s.syncType]?.label || s.syncType).join('・')}が
            <strong> {Math.round(oldestStaleHours)}時間以上</strong> 更新されていません。
            同期を実行してください。
          </span>
          <button
            onClick={() => triggerSync('all')}
            className="ml-auto text-[10px] px-3 py-1 rounded-md font-bold transition-all"
            style={{
              background: 'rgba(255,255,255,0.1)',
              color: 'inherit',
              border: '1px solid rgba(255,255,255,0.15)',
            }}
          >
            一括同期
          </button>
        </div>
      )}

      {/* Sync status panel */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold">🔄 データ同期</h3>
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                更新: {lastRefresh.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button
              onClick={fetchSyncHealth}
              disabled={loading}
              className="text-[10px] px-2 py-1 rounded transition-all"
              style={{
                background: 'rgba(56,189,248,0.08)',
                color: 'var(--accent-primary)',
                border: '1px solid rgba(56,189,248,0.15)',
              }}
            >
              {loading ? '...' : '↻ 更新'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>同期状態を取得中...</span>
          </div>
        ) : (
          <div className="space-y-2">
            {displayItems.map((item) => {
              const status = actionStatus[item.syncType] || 'idle';
              const statusMsg = actionMessages[item.syncType] || '';

              return (
                <div
                  key={item.syncType}
                  className="flex items-center justify-between py-2.5 px-3 rounded-lg transition-all"
                  style={{
                    background: getStatusBg(item.autoStatus),
                    border: `1px solid ${getStatusColor(item.autoStatus)}22`,
                  }}
                >
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    {/* Status dot */}
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: getStatusColor(item.autoStatus) }}
                    />
                    {/* Icon + label */}
                    <span className="text-xs">{item.icon}</span>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {item.label}
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {item.lastSyncAt
                          ? formatElapsed(item.minutesSince)
                          : '同期記録なし'}
                        {item.errorCount > 0 && (
                          <span style={{ color: '#ef4444' }}> (エラー{item.errorCount}回)</span>
                        )}
                      </div>
                      {/* Action feedback */}
                      {statusMsg && (
                        <div className="text-[9px] mt-0.5" style={{
                          color: status === 'error' ? '#fca5a5' : status === 'done' ? '#86efac' : 'var(--text-muted)',
                        }}>
                          {statusMsg}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Sync button per type */}
                  {item.syncType !== 'screenshot' && (
                    <button
                      onClick={() => triggerSync(item.syncType as SyncAction)}
                      disabled={status === 'running'}
                      className="text-[10px] px-2.5 py-1 rounded-md transition-all flex-shrink-0"
                      style={{
                        background: status === 'running'
                          ? 'rgba(100,100,100,0.2)'
                          : status === 'done'
                            ? 'rgba(34,197,94,0.15)'
                            : 'rgba(56,189,248,0.1)',
                        color: status === 'done' ? '#22c55e' : 'var(--accent-primary)',
                        border: `1px solid ${status === 'done' ? 'rgba(34,197,94,0.2)' : 'rgba(56,189,248,0.15)'}`,
                        opacity: status === 'running' ? 0.6 : 1,
                      }}
                    >
                      {status === 'running' ? (
                        <span className="flex items-center gap-1">
                          <span className="animate-spin w-3 h-3 border border-sky-400 border-t-transparent rounded-full" />
                          実行中
                        </span>
                      ) : status === 'done' ? (
                        '✓ 完了'
                      ) : (
                        '同期'
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* All-sync button */}
        {!loading && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(56,189,248,0.08)' }}>
            <button
              onClick={() => triggerSync('all')}
              disabled={Object.values(actionStatus).some((s) => s === 'running')}
              className="w-full text-xs px-4 py-2 rounded-lg font-semibold transition-all"
              style={{
                background: 'linear-gradient(135deg, rgba(56,189,248,0.15), rgba(167,139,250,0.15))',
                color: 'var(--accent-primary)',
                border: '1px solid rgba(56,189,248,0.2)',
              }}
            >
              🔄 全データを一括同期
            </button>
            <p className="text-[9px] mt-1 text-center" style={{ color: 'var(--text-muted)' }}>
              コイン同期はChrome拡張で実行。SPYチャット/視聴者はCollectorが自動収集中。
            </p>
          </div>
        )}

        {/* Error details (expandable) */}
        {displayItems.some((d) => d.lastError) && (
          <details className="mt-2">
            <summary className="text-[10px] cursor-pointer" style={{ color: 'var(--text-muted)' }}>
              エラー詳細
            </summary>
            <div className="mt-1 space-y-1">
              {displayItems
                .filter((d) => d.lastError)
                .map((d) => (
                  <div key={d.syncType} className="text-[9px] px-2 py-1 rounded"
                    style={{ background: 'rgba(239,68,68,0.08)', color: '#fca5a5' }}>
                    {d.icon} {d.label}: {d.lastError}
                  </div>
                ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
