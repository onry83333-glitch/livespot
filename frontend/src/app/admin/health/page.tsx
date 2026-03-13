'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Accordion } from '@/components/accordion';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';

/* ============================================================
   Types
   ============================================================ */
interface HealthCheck {
  id: string;
  label: string;
  icon: string;
  status: 'ok' | 'warn' | 'error' | 'loading';
  summary: string;
  details: string[];
}

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

const SYNC_TYPE_LABELS: Record<string, string> = {
  spy_chat: 'SPYチャット',
  spy_viewer: 'SPY視聴者',
  coin_sync: 'コイン同期',
  screenshot: 'スクリーンショット',
};

const SYNC_TYPE_ICONS: Record<string, string> = {
  spy_chat: '💬',
  spy_viewer: '👁',
  coin_sync: '💰',
  screenshot: '📸',
};

/** Supabase PostgrestError は Error インスタンスではないため .message を安全に取り出す */
function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/* ============================================================
   Page
   ============================================================ */
export default function HealthPage() {
  const { user } = useAuth();
  const sbRef = useRef(createClient());
  const sb = sbRef.current;

  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [syncHealth, setSyncHealth] = useState<SyncHealthRow[]>([]);
  const [syncHealthLoading, setSyncHealthLoading] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);

  // アカウントID取得（品質チェック・同期ヘルス共通）
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).then(({ data }) => {
      if (data?.[0]?.id) setAccountId(data[0].id);
    });
  }, [user, sb]);

  const runChecks = useCallback(async () => {
    if (!user || !accountId) return;
    setRunning(true);

    const results: HealthCheck[] = [];
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // --- 1. coin_transactions 蓄積状況 ---
    try {
      const { data: coinData, error } = await sb
        .from('coin_transactions')
        .select('cast_name, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(5000);

      if (error) throw error;

      const castMap = new Map<string, { count: number; minDate: string; maxDate: string }>();
      for (const row of coinData || []) {
        const cn = row.cast_name || '(unknown)';
        const existing = castMap.get(cn);
        if (!existing) {
          castMap.set(cn, { count: 1, minDate: row.created_at, maxDate: row.created_at });
        } else {
          existing.count++;
          if (row.created_at < existing.minDate) existing.minDate = row.created_at;
          if (row.created_at > existing.maxDate) existing.maxDate = row.created_at;
        }
      }

      const details: string[] = [];
      let hasStale = false;
      for (const [cn, info] of Array.from(castMap.entries())) {
        const maxDate = new Date(info.maxDate);
        const isStale = maxDate < oneDayAgo;
        if (isStale) hasStale = true;
        details.push(
          `${cn}: ${(info.count ?? 0).toLocaleString()}件 (${new Date(info.minDate).toLocaleDateString('ja-JP')} 〜 ${maxDate.toLocaleDateString('ja-JP')})${isStale ? ' ⚠️24h超' : ''}`
        );
      }

      results.push({
        id: 'coin',
        label: 'コイントランザクション蓄積状況',
        icon: '💰',
        status: castMap.size === 0 ? 'error' : hasStale ? 'warn' : 'ok',
        summary: castMap.size === 0
          ? 'データなし'
          : `${castMap.size}キャスト / ${(coinData || []).length.toLocaleString()}件`,
        details,
      });
    } catch (e: unknown) {
      results.push({
        id: 'coin',
        label: 'コイントランザクション蓄積状況',
        icon: '💰',
        status: 'error',
        summary: `エラー: ${getErrorMessage(e)}`,
        details: [],
      });
    }

    // --- 2. chat_logs overflow 検出 ---
    try {
      const { count, error } = await sb
        .from('chat_logs')
        .select('*', { count: 'exact', head: true })
        .eq('account_id', accountId);

      if (error) throw error;

      // tokens > 2147483647 でオーバーフロー検出
      const { count: overflowCount, error: overflowErr } = await sb
        .from('chat_logs')
        .select('*', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .gt('tokens', 2147483647);

      if (overflowErr) throw overflowErr;

      const hasOverflow = (overflowCount || 0) > 0;
      results.push({
        id: 'overflow',
        label: 'chat_logs オーバーフロー検出',
        icon: '🔢',
        status: hasOverflow ? 'error' : 'ok',
        summary: hasOverflow
          ? `${overflowCount}件のオーバーフロー検出`
          : `正常（合計 ${(count || 0).toLocaleString()}件）`,
        details: hasOverflow
          ? [`tokens > 2,147,483,647 のレコード: ${overflowCount}件`, '修正: UPDATE chat_logs SET tokens = 0 WHERE tokens > 2147483647;']
          : [`総レコード数: ${(count || 0).toLocaleString()}`],
      });
    } catch (e: unknown) {
      results.push({
        id: 'overflow',
        label: 'chat_logs オーバーフロー検出',
        icon: '🔢',
        status: 'error',
        summary: `エラー: ${getErrorMessage(e)}`,
        details: [],
      });
    }

    // --- 3. DM sent_via 分布 ---
    try {
      const { data: dmData, error } = await sb
        .from('dm_send_log')
        .select('sent_via, status, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(5000);

      if (error) throw error;

      const viaMap = new Map<string, number>();
      const statusMap = new Map<string, number>();
      let latestDm: string | null = null;
      for (const row of dmData || []) {
        const via = row.sent_via || '(不明)';
        viaMap.set(via, (viaMap.get(via) || 0) + 1);
        statusMap.set(row.status, (statusMap.get(row.status) || 0) + 1);
        if (!latestDm && row.created_at) latestDm = row.created_at;
      }

      const details: string[] = [];
      for (const [via, cnt] of Array.from(viaMap.entries())) details.push(`送信方法: ${via} → ${cnt}件`);
      for (const [st, cnt] of Array.from(statusMap.entries())) details.push(`ステータス: ${st} → ${cnt}件`);

      const latestDate = latestDm ? new Date(latestDm) : null;
      const isStale = latestDate ? latestDate < oneDayAgo : true;

      results.push({
        id: 'dm',
        label: 'DM送信 sent_via 分布',
        icon: '📨',
        status: (dmData || []).length === 0 ? 'warn' : isStale ? 'warn' : 'ok',
        summary: (dmData || []).length === 0
          ? 'DMデータなし'
          : `${(dmData || []).length}件 / 最新: ${latestDate ? latestDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '不明'}`,
        details,
      });
    } catch (e: unknown) {
      results.push({
        id: 'dm',
        label: 'DM送信 sent_via 分布',
        icon: '📨',
        status: 'error',
        summary: `エラー: ${getErrorMessage(e)}`,
        details: [],
      });
    }

    // --- 4. spy_viewers 最新データ ---
    try {
      const { data: viewerData, error } = await sb
        .from('spy_viewers')
        .select('cast_name, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(2000);

      if (error) throw error;

      const castViewerMap = new Map<string, { count: number; latest: string }>();
      for (const row of viewerData || []) {
        const cn = row.cast_name || '(unknown)';
        const existing = castViewerMap.get(cn);
        if (!existing) {
          castViewerMap.set(cn, { count: 1, latest: row.created_at });
        } else {
          existing.count++;
          if (row.created_at > existing.latest) existing.latest = row.created_at;
        }
      }

      const details: string[] = [];
      let hasStale = false;
      for (const [cn, info] of Array.from(castViewerMap.entries())) {
        const latestDate = new Date(info.latest);
        const isStale = latestDate < oneDayAgo;
        if (isStale) hasStale = true;
        details.push(
          `${cn}: ${info.count}件（最新: ${latestDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}）${isStale ? ' ⚠️24h超' : ''}`
        );
      }

      results.push({
        id: 'viewers',
        label: 'spy_viewers 最新データ',
        icon: '👁',
        status: castViewerMap.size === 0 ? 'warn' : hasStale ? 'warn' : 'ok',
        summary: castViewerMap.size === 0
          ? 'データなし'
          : `${castViewerMap.size}キャスト / ${(viewerData || []).length}件`,
        details,
      });
    } catch (e: unknown) {
      results.push({
        id: 'viewers',
        label: 'spy_viewers 最新データ',
        icon: '👁',
        status: 'error',
        summary: `エラー: ${getErrorMessage(e)}`,
        details: [],
      });
    }

    // --- 5. user_profiles セグメント分布 ---
    try {
      const { data: segData, error } = await sb
        .from('user_profiles')
        .select('cast_name, segment')
        .eq('account_id', accountId)
        .limit(50000);

      if (error) throw error;

      const castSegMap = new Map<string, Map<string, number>>();
      for (const row of segData || []) {
        const cn = row.cast_name || '(unknown)';
        if (!castSegMap.has(cn)) castSegMap.set(cn, new Map());
        const segMap = castSegMap.get(cn)!;
        const seg = row.segment || '(未分類)';
        segMap.set(seg, (segMap.get(seg) || 0) + 1);
      }

      const details: string[] = [];
      let hasNullSegment = false;
      for (const [cn, segMap] of Array.from(castSegMap.entries())) {
        const parts: string[] = [];
        for (const [seg, cnt] of Array.from(segMap.entries())) {
          parts.push(`${seg}:${cnt}`);
          if (seg === '(未分類)') hasNullSegment = true;
        }
        details.push(`${cn}: ${parts.join(', ')}`);
      }

      results.push({
        id: 'segments',
        label: 'paid_users セグメント分布',
        icon: '🎯',
        status: castSegMap.size === 0 ? 'warn' : hasNullSegment ? 'warn' : 'ok',
        summary: castSegMap.size === 0
          ? 'データなし'
          : `${castSegMap.size}キャスト / ${(segData || []).length}ユーザー`,
        details,
      });
    } catch (e: unknown) {
      results.push({
        id: 'segments',
        label: 'paid_users セグメント分布',
        icon: '🎯',
        status: 'error',
        summary: `エラー: ${getErrorMessage(e)}`,
        details: [],
      });
    }

    setChecks(results);
    setLastRun(new Date());
    setRunning(false);
  }, [user, sb, accountId]);

  // 同期ヘルスを取得
  const fetchSyncHealth = useCallback(async () => {
    if (!user || !accountId) return;
    setSyncHealthLoading(true);
    try {
      const { data, error } = await sb.rpc('get_sync_health', { p_account_id: accountId });
      if (error) throw error;
      setSyncHealth((data as SyncHealthRow[]) || []);
    } catch {
      setSyncHealth([]);
    }
    setSyncHealthLoading(false);
  }, [user, sb, accountId]);

  // 初回実行
  useEffect(() => { runChecks(); fetchSyncHealth(); }, [runChecks, fetchSyncHealth]);

  if (!user) return null;

  const statusBadge = (status: HealthCheck['status']) => {
    switch (status) {
      case 'ok':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">正常</span>;
      case 'warn':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/20">注意</span>;
      case 'error':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/20">異常</span>;
      case 'loading':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-400 border border-sky-500/20">チェック中...</span>;
    }
  };

  const okCount = checks.filter(c => c.status === 'ok').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const errorCount = checks.filter(c => c.status === 'error').length;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>管理 / 品質チェック</span>
          </div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            🏥 品質チェック
          </h1>
          {lastRun && (
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              最終実行: {lastRun.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
            </p>
          )}
          <Link href="/admin/data-quality" className="text-[11px] mt-1 hover:underline" style={{ color: 'var(--accent-primary)' }}>
            SPYデータ品質管理 →
          </Link>
        </div>
        <button
          onClick={() => { runChecks(); fetchSyncHealth(); }}
          disabled={running}
          className="btn-primary px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50"
        >
          {running ? (
            <>
              <span className="animate-spin">⏳</span>
              チェック中...
            </>
          ) : (
            <>🔄 Refresh</>
          )}
        </button>
      </div>

      {/* Summary badges */}
      {checks.length > 0 && (
        <div className="flex items-center gap-3">
          {okCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <span className="text-emerald-400 text-sm">✅</span>
              <span className="text-xs font-medium text-emerald-400">{okCount}件 正常</span>
            </div>
          )}
          {warnCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <span className="text-amber-400 text-sm">⚠️</span>
              <span className="text-xs font-medium text-amber-400">{warnCount}件 注意</span>
            </div>
          )}
          {errorCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
              <span className="text-rose-400 text-sm">🔴</span>
              <span className="text-xs font-medium text-rose-400">{errorCount}件 異常</span>
            </div>
          )}
        </div>
      )}

      <Accordion id="admin-health-checks" title="品質チェック結果" icon="🏥" badge={`${checks.length}件`} defaultOpen={true} lazy={false}>
      {/* Check cards */}
      {running && checks.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {checks.map(check => (
            <div key={check.id} className="glass-card p-5">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-lg">{check.icon}</span>
                  <h3 className="text-sm font-bold">{check.label}</h3>
                </div>
                {statusBadge(check.status)}
              </div>
              <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
                {check.summary}
              </p>
              {check.details.length > 0 && (
                <div className="glass-panel rounded-lg p-3 space-y-1">
                  {check.details.map((d, i) => (
                    <p key={i} className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                      {d}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      </Accordion>

      <Accordion id="admin-sync-health" title="Collector 同期ヘルス" icon="🔄" defaultOpen={false}>
      {/* Sync Health Section */}
      <div>
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
          🔄 Collector 同期ヘルス
        </h2>
        {syncHealthLoading ? (
          <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
        ) : syncHealth.length === 0 ? (
          <div className="glass-card p-5">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              同期ヘルスデータなし（Collectorが sync_health に書き込みを開始すると表示されます）
            </p>
          </div>
        ) : (
          <SyncHealthTable rows={syncHealth} />
        )}
      </div>
      </Accordion>
    </div>
  );
}

/* ============================================================
   Sync Health Table
   ============================================================ */
function SyncHealthTable({ rows }: { rows: SyncHealthRow[] }) {
  // キャスト名でグルーピング
  const castMap = new Map<string, SyncHealthRow[]>();
  for (const row of rows) {
    const existing = castMap.get(row.cast_name);
    if (existing) existing.push(row);
    else castMap.set(row.cast_name, [row]);
  }

  const formatMinutes = (m: number | null) => {
    if (m === null) return '不明';
    if (m < 60) return `${Math.round(m)}分前`;
    if (m < 1440) return `${Math.round(m / 60)}時間前`;
    return `${Math.round(m / 1440)}日前`;
  };

  const statusDot = (autoStatus: string) => {
    switch (autoStatus) {
      case 'ok':
        return <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />;
      case 'warn':
        return <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />;
      case 'error':
        return <span className="inline-block w-2 h-2 rounded-full bg-rose-400" />;
      default:
        return <span className="inline-block w-2 h-2 rounded-full bg-slate-500" />;
    }
  };

  const statusLabel = (autoStatus: string) => {
    switch (autoStatus) {
      case 'ok': return '正常';
      case 'warn': return '2h超';
      case 'error': return '異常';
      default: return '不明';
    }
  };

  return (
    <div className="space-y-3">
      {Array.from(castMap.entries()).map(([castName, typeRows]) => {
        const worstStatus = typeRows.some(r => r.auto_status === 'error')
          ? 'error'
          : typeRows.some(r => r.auto_status === 'warn')
            ? 'warn'
            : typeRows.some(r => r.auto_status === 'unknown')
              ? 'unknown'
              : 'ok';

        return (
          <div key={castName} className="glass-card p-4">
            <div className="flex items-center gap-2 mb-3">
              {statusDot(worstStatus)}
              <h3 className="text-sm font-bold">{castName}</h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full" style={{
                background: worstStatus === 'ok' ? 'rgba(34,197,94,0.15)' :
                  worstStatus === 'warn' ? 'rgba(245,158,11,0.15)' :
                  worstStatus === 'error' ? 'rgba(244,63,94,0.15)' : 'rgba(100,116,139,0.15)',
                color: worstStatus === 'ok' ? '#22c55e' :
                  worstStatus === 'warn' ? '#f59e0b' :
                  worstStatus === 'error' ? '#f43f5e' : '#94a3b8',
              }}>
                {statusLabel(worstStatus)}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {typeRows.map(row => (
                <div key={row.sync_type} className="glass-panel rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    {statusDot(row.auto_status)}
                    <span className="text-[11px] font-medium">
                      {SYNC_TYPE_ICONS[row.sync_type] || '📡'} {SYNC_TYPE_LABELS[row.sync_type] || row.sync_type}
                    </span>
                  </div>
                  <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {row.last_sync_at
                      ? formatMinutes(row.minutes_since_sync)
                      : '未同期'}
                  </p>
                  {row.error_count > 0 && (
                    <p className="text-[10px] mt-1" style={{ color: 'var(--accent-pink)' }}>
                      エラー {row.error_count}回
                    </p>
                  )}
                  {row.last_error && (
                    <p className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }} title={row.last_error}>
                      {row.last_error}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
