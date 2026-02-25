'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/components/auth-provider';
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

  const runChecks = useCallback(async () => {
    if (!user) return;
    setRunning(true);

    const results: HealthCheck[] = [];
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // --- 1. coin_transactions 蓄積状況 ---
    try {
      const { data: coinData, error } = await sb
        .from('coin_transactions')
        .select('cast_name, created_at')
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
          `${cn}: ${info.count.toLocaleString()}件 (${new Date(info.minDate).toLocaleDateString('ja-JP')} 〜 ${maxDate.toLocaleDateString('ja-JP')})${isStale ? ' ⚠️24h超' : ''}`
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
        summary: `エラー: ${e instanceof Error ? e.message : String(e)}`,
        details: [],
      });
    }

    // --- 2. spy_messages overflow 検出 ---
    try {
      const { count, error } = await sb
        .from('spy_messages')
        .select('*', { count: 'exact', head: true });

      if (error) throw error;

      // tokens > 2147483647 でオーバーフロー検出
      const { count: overflowCount, error: overflowErr } = await sb
        .from('spy_messages')
        .select('*', { count: 'exact', head: true })
        .gt('tokens', 2147483647);

      if (overflowErr) throw overflowErr;

      const hasOverflow = (overflowCount || 0) > 0;
      results.push({
        id: 'overflow',
        label: 'spy_messages オーバーフロー検出',
        icon: '🔢',
        status: hasOverflow ? 'error' : 'ok',
        summary: hasOverflow
          ? `${overflowCount}件のオーバーフロー検出`
          : `正常（合計 ${(count || 0).toLocaleString()}件）`,
        details: hasOverflow
          ? [`tokens > 2,147,483,647 のレコード: ${overflowCount}件`, '修正: UPDATE spy_messages SET tokens = 0 WHERE tokens > 2147483647;']
          : [`総レコード数: ${(count || 0).toLocaleString()}`],
      });
    } catch (e: unknown) {
      results.push({
        id: 'overflow',
        label: 'spy_messages オーバーフロー検出',
        icon: '🔢',
        status: 'error',
        summary: `エラー: ${e instanceof Error ? e.message : String(e)}`,
        details: [],
      });
    }

    // --- 3. DM sent_via 分布 ---
    try {
      const { data: dmData, error } = await sb
        .from('dm_send_log')
        .select('sent_via, status, created_at')
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
        summary: `エラー: ${e instanceof Error ? e.message : String(e)}`,
        details: [],
      });
    }

    // --- 4. spy_viewers 最新データ ---
    try {
      const { data: viewerData, error } = await sb
        .from('spy_viewers')
        .select('cast_name, created_at')
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
        summary: `エラー: ${e instanceof Error ? e.message : String(e)}`,
        details: [],
      });
    }

    // --- 5. paid_users セグメント分布 ---
    try {
      const { data: segData, error } = await sb
        .from('paid_users')
        .select('cast_name, segment');

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
        summary: `エラー: ${e instanceof Error ? e.message : String(e)}`,
        details: [],
      });
    }

    setChecks(results);
    setLastRun(new Date());
    setRunning(false);
  }, [user, sb]);

  // 初回実行
  useEffect(() => { runChecks(); }, [runChecks]);

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
            <Link href="/admin/command-center" className="text-xs hover:underline" style={{ color: 'var(--text-muted)' }}>
              コマンドセンター
            </Link>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>/</span>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>品質チェック</span>
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
          onClick={runChecks}
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
    </div>
  );
}
