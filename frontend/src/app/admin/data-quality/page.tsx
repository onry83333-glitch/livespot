'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Accordion } from '@/components/accordion';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';

interface QualityCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error' | 'loading';
  summary: string;
  details: string[];
  count: number;
}

export default function DataQualityPage() {
  const { user } = useAuth();
  const sbRef = useRef(createClient());
  const sb = sbRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [checks, setChecks] = useState<QualityCheck[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [rpcAvailable, setRpcAvailable] = useState<boolean | null>(null);

  // アカウントIDを動的取得
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  const runChecks = useCallback(async () => {
    if (!user || !accountId) return;
    setRunning(true);

    // Try RPC first
    const { data: rpcResult, error: rpcError } = await sb.rpc('check_spy_data_quality', {
      p_account_id: accountId,
    });

    if (!rpcError && rpcResult && typeof rpcResult === 'object') {
      setRpcAvailable(true);
      // Parse RPC result into QualityCheck[]
      const rpcChecks = (rpcResult as { checks?: Array<{ id: string; label: string; status: string; count: number; details: unknown }> }).checks || [];
      const parsed: QualityCheck[] = rpcChecks.map((c) => ({
        id: c.id,
        label: c.label,
        status: (c.status as QualityCheck['status']) || 'ok',
        count: c.count || 0,
        summary: `${c.count || 0}件`,
        details: formatRpcDetails(c.id, c.details),
      }));
      setChecks(parsed);
      setLastRun(new Date());
      setRunning(false);
      return;
    }

    // Fallback: client-side checks
    setRpcAvailable(false);
    const results: QualityCheck[] = [];
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // --- CHECK 1: Gap Detection (5min+ gaps in recent messages) ---
    try {
      const { data: recentMsgs } = await sb
        .from('chat_logs')
        .select('cast_name, timestamp, message_type')
        .eq('account_id', accountId)
        .in('message_type', ['chat', 'tip'])
        .gte('timestamp', oneDayAgo.toISOString())
        .order('cast_name')
        .order('timestamp', { ascending: true })
        .limit(5000);

      const gapMap = new Map<string, { count: number; maxMin: number }>();
      const msgs = recentMsgs || [];
      for (let i = 1; i < msgs.length; i++) {
        if (msgs[i].cast_name !== msgs[i - 1].cast_name) continue;
        const diff = (new Date(msgs[i].timestamp).getTime() - new Date(msgs[i - 1].timestamp).getTime()) / 60000;
        if (diff > 5) {
          const prev = gapMap.get(msgs[i].cast_name) || { count: 0, maxMin: 0 };
          prev.count++;
          if (diff > prev.maxMin) prev.maxMin = diff;
          gapMap.set(msgs[i].cast_name, prev);
        }
      }

      const details: string[] = [];
      for (const [cn, info] of Array.from(gapMap.entries())) {
        details.push(`${cn}: ${info.count}回 (最大 ${Math.round(info.maxMin)}分)`);
      }

      results.push({
        id: 'gap_detection',
        label: 'メッセージギャップ検出 (5分+)',
        status: gapMap.size > 0 ? 'warn' : 'ok',
        count: gapMap.size,
        summary: gapMap.size > 0 ? `${gapMap.size}キャストにギャップあり` : 'ギャップなし',
        details,
      });
    } catch (e) {
      results.push({ id: 'gap_detection', label: 'メッセージギャップ検出 (5分+)', status: 'error', count: 0, summary: String(e), details: [] });
    }

    // --- CHECK 2: Duplicate Detection ---
    try {
      const { data: dupMsgs } = await sb
        .from('chat_logs')
        .select('cast_name, timestamp, username, message')
        .eq('account_id', accountId)
        .gte('timestamp', sevenDaysAgo.toISOString())
        .order('timestamp', { ascending: false })
        .limit(8000);

      const seen = new Map<string, number>();
      let dupCount = 0;
      for (const m of dupMsgs || []) {
        const key = `${m.cast_name}|${m.timestamp}|${m.username}|${m.message}`;
        const cnt = (seen.get(key) || 0) + 1;
        seen.set(key, cnt);
        if (cnt > 1) dupCount++;
      }

      const dupGroups = Array.from(seen.values()).filter(v => v > 1).length;
      results.push({
        id: 'duplicate_detection',
        label: '重複メッセージ検出',
        status: dupCount > 10 ? 'error' : dupCount > 0 ? 'warn' : 'ok',
        count: dupCount,
        summary: dupCount > 0 ? `${dupCount}件の重複 (${dupGroups}グループ)` : '重複なし',
        details: dupCount > 0 ? [`重複グループ数: ${dupGroups}`, `余分な行数: ${dupCount}`] : [],
      });
    } catch (e) {
      results.push({ id: 'duplicate_detection', label: '重複メッセージ検出', status: 'error', count: 0, summary: String(e), details: [] });
    }

    // --- CHECK 3: Freshness Detection (30min+ since last data) ---
    try {
      const { data: spyCasts } = await sb
        .from('spy_casts')
        .select('cast_name')
        .eq('account_id', accountId)
        .eq('is_active', true);

      const staleDetails: string[] = [];
      let staleCount = 0;

      if (spyCasts && spyCasts.length > 0) {
        const { data: latestMsgs } = await sb
          .from('chat_logs')
          .select('cast_name, timestamp')
          .eq('account_id', accountId)
          .gte('timestamp', oneDayAgo.toISOString())
          .order('timestamp', { ascending: false })
          .limit(5000);

        const latestMap = new Map<string, Date>();
        for (const m of latestMsgs || []) {
          if (!latestMap.has(m.cast_name)) {
            latestMap.set(m.cast_name, new Date(m.timestamp));
          }
        }

        for (const sc of spyCasts) {
          const latest = latestMap.get(sc.cast_name);
          if (latest) {
            const minSince = (now.getTime() - latest.getTime()) / 60000;
            if (minSince > 30) {
              staleCount++;
              staleDetails.push(`${sc.cast_name}: ${Math.round(minSince)}分前`);
            }
          }
        }
      }

      results.push({
        id: 'freshness_detection',
        label: 'データ鮮度チェック (30分+)',
        status: staleCount > 3 ? 'error' : staleCount > 0 ? 'warn' : 'ok',
        count: staleCount,
        summary: staleCount > 0 ? `${staleCount}キャストが古いデータ` : '全キャスト鮮度OK',
        details: staleDetails,
      });
    } catch (e) {
      results.push({ id: 'freshness_detection', label: 'データ鮮度チェック (30分+)', status: 'error', count: 0, summary: String(e), details: [] });
    }

    // --- CHECK 4: Unregistered Casts ---
    try {
      const { data: regCasts } = await sb
        .from('spy_casts')
        .select('cast_name')
        .eq('account_id', accountId)
        .eq('is_active', true);

      const { data: ownCasts } = await sb
        .from('registered_casts')
        .select('cast_name')
        .eq('account_id', accountId)
        .eq('is_active', true);

      const knownNames = new Set([
        ...(regCasts || []).map(c => c.cast_name),
        ...(ownCasts || []).map(c => c.cast_name),
      ]);

      const { data: spyNames } = await sb
        .from('chat_logs')
        .select('cast_name')
        .eq('account_id', accountId)
        .gte('timestamp', sevenDaysAgo.toISOString())
        .limit(5000);

      const unregistered = new Set<string>();
      for (const m of spyNames || []) {
        if (m.cast_name && !knownNames.has(m.cast_name)) {
          unregistered.add(m.cast_name);
        }
      }

      results.push({
        id: 'unregistered_casts',
        label: '未登録キャスト検出',
        status: unregistered.size > 0 ? 'warn' : 'ok',
        count: unregistered.size,
        summary: unregistered.size > 0 ? `${unregistered.size}件の未登録` : '全キャスト登録済み',
        details: Array.from(unregistered).map(n => n),
      });
    } catch (e) {
      results.push({ id: 'unregistered_casts', label: '未登録キャスト検出', status: 'error', count: 0, summary: String(e), details: [] });
    }

    // --- CHECK 5: NULL session_id ---
    try {
      const { count } = await sb
        .from('chat_logs')
        .select('*', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .gte('timestamp', sevenDaysAgo.toISOString())
        .is('session_id', null);

      const nullCount = count || 0;
      results.push({
        id: 'null_session_id',
        label: 'NULL session_id メッセージ',
        status: nullCount > 50 ? 'warn' : 'ok',
        count: nullCount,
        summary: `${nullCount}件`,
        details: nullCount > 0 ? [`過去7日間でsession_idがNULL: ${nullCount}件`] : [],
      });
    } catch (e) {
      results.push({ id: 'null_session_id', label: 'NULL session_id メッセージ', status: 'error', count: 0, summary: String(e), details: [] });
    }

    // --- CHECK 6: Cast Summary (7 days) ---
    try {
      const { data: spyCasts } = await sb
        .from('spy_casts')
        .select('cast_name')
        .eq('account_id', accountId)
        .eq('is_active', true);

      const { data: msgData } = await sb
        .from('chat_logs')
        .select('cast_name, message_type, tokens')
        .eq('account_id', accountId)
        .gte('timestamp', sevenDaysAgo.toISOString())
        .limit(10000);

      const castMap = new Map<string, { msgs: number; tips: number; tokens: number }>();
      for (const m of msgData || []) {
        const prev = castMap.get(m.cast_name) || { msgs: 0, tips: 0, tokens: 0 };
        prev.msgs++;
        if (m.message_type === 'tip') {
          prev.tips++;
          prev.tokens += m.tokens || 0;
        }
        castMap.set(m.cast_name, prev);
      }

      const details: string[] = [];
      const allCastNames = new Set([
        ...(spyCasts || []).map(c => c.cast_name),
        ...Array.from(castMap.keys()),
      ]);

      for (const cn of Array.from(allCastNames).sort()) {
        const info = castMap.get(cn);
        if (info) {
          details.push(`${cn}: ${info.msgs}msg / ${info.tips}tip / ${info.tokens.toLocaleString()}tk`);
        } else {
          details.push(`${cn}: データなし`);
        }
      }

      results.push({
        id: 'cast_summary',
        label: 'キャスト別データ量 (7日間)',
        status: 'ok',
        count: allCastNames.size,
        summary: `${allCastNames.size}キャスト / ${(msgData || []).length.toLocaleString()}メッセージ`,
        details,
      });
    } catch (e) {
      results.push({ id: 'cast_summary', label: 'キャスト別データ量 (7日間)', status: 'error', count: 0, summary: String(e), details: [] });
    }

    // --- CHECK 7: Cross-check SPY tips vs coin_transactions ---
    try {
      const { data: spyTips } = await sb
        .from('chat_logs')
        .select('cast_name, timestamp')
        .eq('account_id', accountId)
        .eq('message_type', 'tip')
        .gt('tokens', 0)
        .gte('timestamp', sevenDaysAgo.toISOString())
        .limit(5000);

      // Get unique cast_name + date combos from spy tips
      const spyDays = new Set<string>();
      for (const t of spyTips || []) {
        const d = new Date(t.timestamp);
        const jstDate = new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
        spyDays.add(`${t.cast_name}|${jstDate}`);
      }

      // Get unique cast_name + date combos from coin_transactions
      const { data: coinData } = await sb
        .from('coin_transactions')
        .select('cast_name, date')
        .eq('account_id', accountId)
        .gte('date', sevenDaysAgo.toISOString())
        .limit(10000);

      const coinDays = new Set<string>();
      for (const c of coinData || []) {
        const d = new Date(c.date);
        const jstDate = new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
        coinDays.add(`${c.cast_name}|${jstDate}`);
      }

      let missingCount = 0;
      const missingDetails: string[] = [];
      for (const key of Array.from(spyDays)) {
        if (!coinDays.has(key)) {
          missingCount++;
          const [cn, dt] = key.split('|');
          missingDetails.push(`${cn} (${dt})`);
        }
      }

      results.push({
        id: 'cross_check_coins',
        label: 'SPY tip vs coin_transactions 整合性',
        status: missingCount > 3 ? 'warn' : 'ok',
        count: missingCount,
        summary: missingCount > 0 ? `${missingCount}日分のコインデータ欠損` : '整合性OK',
        details: missingDetails.slice(0, 20),
      });
    } catch (e) {
      results.push({ id: 'cross_check_coins', label: 'SPY tip vs coin_transactions 整合性', status: 'error', count: 0, summary: String(e), details: [] });
    }

    setChecks(results);
    setLastRun(new Date());
    setRunning(false);
  }, [user, accountId, sb]);

  useEffect(() => { runChecks(); }, [runChecks]);

  if (!user || !accountId) return null;

  const okCount = checks.filter(c => c.status === 'ok').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const errorCount = checks.filter(c => c.status === 'error').length;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/admin/health" className="text-xs hover:underline" style={{ color: 'var(--text-muted)' }}>
              品質チェック
            </Link>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>/</span>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>SPYデータ品質</span>
          </div>
          <h1 className="text-xl font-bold">SPY データ品質管理</h1>
          <div className="flex items-center gap-3 mt-1">
            {lastRun && (
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                最終実行: {lastRun.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
              </p>
            )}
            {rpcAvailable !== null && (
              <span className="text-[9px] px-2 py-0.5 rounded font-semibold" style={
                rpcAvailable
                  ? { color: 'var(--accent-green)', background: 'rgba(34,197,94,0.1)' }
                  : { color: 'var(--accent-amber)', background: 'rgba(245,158,11,0.1)' }
              }>
                {rpcAvailable ? 'RPC' : 'CLIENT'}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={runChecks}
          disabled={running}
          className="btn-primary px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50"
        >
          {running ? 'チェック中...' : 'Refresh'}
        </button>
      </div>

      {/* Summary badges */}
      {checks.length > 0 && (
        <div className="flex items-center gap-3">
          {okCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <span className="text-xs font-medium text-emerald-400">{okCount}件 正常</span>
            </div>
          )}
          {warnCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <span className="text-xs font-medium text-amber-400">{warnCount}件 注意</span>
            </div>
          )}
          {errorCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
              <span className="text-xs font-medium text-rose-400">{errorCount}件 異常</span>
            </div>
          )}
        </div>
      )}

      <Accordion id="admin-dq-checks" title="品質チェック結果" icon="🔍" badge={`${checks.length}件`} defaultOpen={true} lazy={false}>
      {/* Check cards */}
      {running && checks.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {checks.map(check => (
            <div key={check.id} className="glass-card p-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold">{check.label}</h3>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {check.count}
                  </span>
                  <StatusBadge status={check.status} />
                </div>
              </div>
              <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
                {check.summary}
              </p>
              {check.details.length > 0 && (
                <div className="rounded-lg p-3 space-y-1" style={{ background: 'rgba(0,0,0,0.2)' }}>
                  {check.details.slice(0, 30).map((d, i) => (
                    <p key={i} className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                      {d}
                    </p>
                  ))}
                  {check.details.length > 30 && (
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      ...他{check.details.length - 30}件
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </Accordion>
    </div>
  );
}

function StatusBadge({ status }: { status: QualityCheck['status'] }) {
  switch (status) {
    case 'ok':
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">OK</span>;
    case 'warn':
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/20">WARN</span>;
    case 'error':
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/20">ERROR</span>;
    case 'loading':
      return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-400 border border-sky-500/20">...</span>;
  }
}

function formatRpcDetails(checkId: string, details: unknown): string[] {
  if (!details) return [];
  if (Array.isArray(details)) {
    return details.map((d: Record<string, unknown>) => {
      if (d.cast_name) {
        const parts = [d.cast_name as string];
        if (d.gap_count) parts.push(`${d.gap_count}回`);
        if (d.max_gap_min) parts.push(`最大${d.max_gap_min}分`);
        if (d.msg_count !== undefined) parts.push(`${d.msg_count}msg`);
        if (d.tip_count !== undefined) parts.push(`${d.tip_count}tip`);
        if (d.total_tokens) parts.push(`${Number(d.total_tokens).toLocaleString()}tk`);
        if (d.minutes_since) parts.push(`${d.minutes_since}分前`);
        return parts.join(' / ');
      }
      return typeof d === 'string' ? d : JSON.stringify(d);
    });
  }
  if (typeof details === 'object') {
    return Object.entries(details as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`);
  }
  return [String(details)];
}
