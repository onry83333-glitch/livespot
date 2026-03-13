'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, COIN_RATE } from '@/lib/utils';
import Link from 'next/link';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts';

/* ============================================================
   Types — RPC get_session_list_v2 の戻り値に一致
   broadcast_group: 30分ギャップで自動統合されたセッション群
   ============================================================ */
interface SessionRow {
  broadcast_group_id: string;
  session_ids: string[];
  cast_name: string;
  session_title: string | null;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  msg_count: number;
  unique_users: number;
  chat_tokens: number;
  tip_count: number;
  coin_tokens: number;
  coin_tip_tokens: number;
  coin_private_tokens: number;
  coin_ticket_tokens: number;
  coin_group_tokens: number;
  coin_spy_tokens: number;
  coin_other_tokens: number;
  total_revenue: number;
  is_active: boolean;
  total_count: number;
}

type PeriodKey = 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'all' | 'custom';

interface PeriodRange { from: Date; to: Date }

interface SummaryStats {
  totalSessions: number;
  totalRevenue: number;
  avgRevenue: number;
  avgDuration: number;
  totalMessages: number;
}

// COIN_RATE imported from @/lib/utils
const PAGE_SIZE = 20;
const LOAD_LIMIT = 500;

const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: 'this_week', label: '今週' },
  { key: 'last_week', label: '先週' },
  { key: 'this_month', label: '今月' },
  { key: 'last_month', label: '先月' },
  { key: 'all', label: '全期間' },
  { key: 'custom', label: 'カスタム' },
];

/* ============================================================
   Helpers
   ============================================================ */
function formatDuration(minutes: number): string {
  if (!minutes || minutes < 0) return '0分';
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}分`;
  return `${h}時間${rem > 0 ? `${rem}分` : ''}`;
}

function formatDateJST(dateStr: string): string {
  const d = new Date(dateStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dayName = dayNames[jst.getUTCDay()];
  return `${mm}/${dd} (${dayName})`;
}

function formatTimeJST(dateStr: string): string {
  const d = new Date(dateStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function toJSTDateKey(dateStr: string): string {
  const d = new Date(dateStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

/** 週区切り: 月曜 3:00 AM JST を起点とするその週の開始時刻(UTC)を返す */
function getThisWeekStartUTC(): Date {
  const now = new Date();
  const JST = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + JST);
  const day = jstNow.getUTCDay(); // 0=日, 1=月 ...
  const daysSinceMonday = day === 0 ? 6 : day - 1;

  // 今週月曜 3:00 JST を UTC で構築
  const mondayJst = new Date(Date.UTC(
    jstNow.getUTCFullYear(), jstNow.getUTCMonth(),
    jstNow.getUTCDate() - daysSinceMonday,
    3, 0, 0, 0,
  ));
  // 現在のJST時刻がまだ月曜 3:00 に達していなければ前週
  if (jstNow.getTime() < mondayJst.getTime()) {
    mondayJst.setUTCDate(mondayJst.getUTCDate() - 7);
  }
  return new Date(mondayJst.getTime() - JST);
}

function computePeriodRange(key: PeriodKey, customFrom: string, customTo: string): PeriodRange | null {
  if (key === 'all') return null;
  const now = new Date();
  const JST = 9 * 60 * 60 * 1000;

  if (key === 'custom') {
    if (!customFrom) return null;
    const from = new Date(customFrom + 'T00:00:00+09:00');
    const to = customTo ? new Date(customTo + 'T23:59:59+09:00') : now;
    return { from, to };
  }

  if (key === 'this_week') {
    return { from: getThisWeekStartUTC(), to: now };
  }
  if (key === 'last_week') {
    const ws = getThisWeekStartUTC();
    return { from: new Date(ws.getTime() - 7 * 24 * 60 * 60 * 1000), to: ws };
  }

  const jstNow = new Date(now.getTime() + JST);
  if (key === 'this_month') {
    const from = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), 1) - JST);
    return { from, to: now };
  }
  if (key === 'last_month') {
    const from = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() - 1, 1) - JST);
    const to = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), 1) - JST);
    return { from, to };
  }
  return null;
}

/** 前期間比較用: 今週→先週、今月→先月 */
function computePrevRange(key: PeriodKey): PeriodRange | null {
  if (key === 'this_week') return computePeriodRange('last_week', '', '');
  if (key === 'this_month') return computePeriodRange('last_month', '', '');
  return null;
}

function computeStats(rows: SessionRow[]): SummaryStats {
  if (rows.length === 0) return { totalSessions: 0, totalRevenue: 0, avgRevenue: 0, avgDuration: 0, totalMessages: 0 };
  const totalRev = rows.reduce((s, r) => s + r.total_revenue, 0);
  return {
    totalSessions: rows.length,
    totalRevenue: totalRev,
    avgRevenue: Math.round(totalRev / rows.length),
    avgDuration: Math.round(rows.reduce((s, r) => s + r.duration_minutes, 0) / rows.length),
    totalMessages: rows.reduce((s, r) => s + r.msg_count, 0),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card px-3 py-2 text-xs" style={{ border: '1px solid var(--border-glass)' }}>
      <p className="font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{label}</p>
      {payload.map((entry: any, i: number) => (
        <p key={i} style={{ color: entry.color }}>
          {entry.name}: {entry.dataKey === 'revenue' ? formatTokens(entry.value) : entry.value?.toLocaleString()}
        </p>
      ))}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ============================================================
   Component
   ============================================================ */
export default function SessionListPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const castName = decodeURIComponent(params.castName as string);

  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [allSessions, setAllSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  // 期間フィルタ
  const [periodKey, setPeriodKey] = useState<PeriodKey>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // DM日別送信数
  const [dmByDate, setDmByDate] = useState<Map<string, number>>(new Map());

  // Get accountId
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  /* ------ Load ALL sessions (up to 500) ------ */
  const loadAllSessions = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);

    // v2 RPC を試行 → v1 → fallback
    let { data, error } = await sb.rpc('get_session_list_v2', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_limit: LOAD_LIMIT,
      p_offset: 0,
    });

    if (error) {
      console.warn('[Sessions] v2 RPC error, trying v1:', error.message);
      const v1 = await sb.rpc('get_session_list', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_limit: LOAD_LIMIT,
        p_offset: 0,
      });
      if (v1.error) {
        console.warn('[Sessions] v1 also failed, using fallback');
        await loadFallback();
        return;
      }
      // v1 → v2 形式に変換
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data = ((v1.data || []) as any[]).map(r => ({
        broadcast_group_id: r.session_id,
        session_ids: [r.session_id],
        cast_name: r.cast_name,
        session_title: r.session_title,
        started_at: r.started_at,
        ended_at: r.ended_at,
        duration_minutes: r.duration_minutes,
        msg_count: r.msg_count,
        unique_users: r.unique_users,
        chat_tokens: r.total_tokens ?? 0,
        tip_count: r.tip_count,
        coin_tokens: 0, coin_tip_tokens: 0, coin_private_tokens: 0,
        coin_ticket_tokens: 0, coin_group_tokens: 0, coin_spy_tokens: 0, coin_other_tokens: 0,
        total_revenue: r.total_tokens ?? 0,
        is_active: r.is_active,
        total_count: r.total_count,
      }));
    }

    setAllSessions((data || []) as SessionRow[]);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, castName, sb]);

  /* ------ Fallback: spy_messages直接クエリ ------ */
  const loadFallback = useCallback(async () => {
    const { data: rawData } = await sb
      .from('chat_logs')
      .select('session_id, cast_name, session_title, timestamp, username, tokens')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .not('session_id', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(5000);

    if (!rawData || rawData.length === 0) {
      setAllSessions([]);
      setLoading(false);
      return;
    }

    const sessionMap = new Map<string, {
      session_id: string; cast_name: string; session_title: string | null;
      messages: { time: string; user_name: string | null; tokens: number }[];
    }>();
    for (const r of rawData) {
      if (!r.session_id) continue;
      if (!sessionMap.has(r.session_id)) {
        sessionMap.set(r.session_id, { session_id: r.session_id, cast_name: r.cast_name, session_title: r.session_title, messages: [] });
      }
      sessionMap.get(r.session_id)!.messages.push({ time: r.timestamp, user_name: r.username, tokens: r.tokens || 0 });
    }

    const rows: SessionRow[] = [];
    const now = Date.now();
    for (const entry of Array.from(sessionMap.entries())) {
      const [sid, sess] = entry;
      const times = sess.messages.map(m => new Date(m.time).getTime());
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const users = new Set(sess.messages.filter(m => m.user_name).map(m => m.user_name));
      const totalTk = sess.messages.reduce((s, m) => s + (m.tokens > 0 ? m.tokens : 0), 0);
      const tips = sess.messages.filter(m => m.tokens > 0).length;
      rows.push({
        broadcast_group_id: sid, session_ids: [sid],
        cast_name: sess.cast_name, session_title: sess.session_title,
        started_at: new Date(minTime).toISOString(), ended_at: new Date(maxTime).toISOString(),
        duration_minutes: Math.round((maxTime - minTime) / 60000),
        msg_count: sess.messages.length, unique_users: users.size,
        chat_tokens: totalTk, tip_count: tips,
        coin_tokens: 0, coin_tip_tokens: 0, coin_private_tokens: 0,
        coin_ticket_tokens: 0, coin_group_tokens: 0, coin_spy_tokens: 0, coin_other_tokens: 0,
        total_revenue: totalTk,
        is_active: (now - maxTime) < 10 * 60 * 1000,
        total_count: 0,
      });
    }
    rows.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    rows.forEach(r => r.total_count = rows.length);
    setAllSessions(rows);
    setLoading(false);
  }, [accountId, castName, sb]);

  /* ------ DM送信数を日別に集計 ------ */
  const loadDmCounts = useCallback(async () => {
    if (!accountId) return;
    const { data } = await sb
      .from('dm_send_log')
      .select('created_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (!data) return;
    const map = new Map<string, number>();
    for (const row of data) {
      if (!row.created_at) continue;
      const key = toJSTDateKey(row.created_at);
      map.set(key, (map.get(key) || 0) + 1);
    }
    setDmByDate(map);
  }, [accountId, castName, sb]);

  // 初回ロード
  useEffect(() => { loadAllSessions(); loadDmCounts(); }, [loadAllSessions, loadDmCounts]);

  // 期間変更時にページリセット
  useEffect(() => { setPage(0); }, [periodKey, customFrom, customTo]);

  /* ------ Computed ------ */

  // 期間フィルタ適用済みセッション
  const filteredSessions = useMemo(() => {
    const range = computePeriodRange(periodKey, customFrom, customTo);
    if (!range) return allSessions;
    return allSessions.filter(s => {
      const t = new Date(s.started_at).getTime();
      return t >= range.from.getTime() && t <= range.to.getTime();
    });
  }, [allSessions, periodKey, customFrom, customTo]);

  // 表示用（ページネーション済み）
  const displaySessions = useMemo(() => {
    return filteredSessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }, [filteredSessions, page]);

  const totalPages = Math.ceil(filteredSessions.length / PAGE_SIZE);

  // KPIサマリー
  const stats = useMemo(() => computeStats(filteredSessions), [filteredSessions]);

  // 前期間KPI（今週→先週比、今月→先月比）
  const prevStats = useMemo<SummaryStats | null>(() => {
    const prevRange = computePrevRange(periodKey);
    if (!prevRange) return null;
    const prev = allSessions.filter(s => {
      const t = new Date(s.started_at).getTime();
      return t >= prevRange.from.getTime() && t <= prevRange.to.getTime();
    });
    return prev.length > 0 ? computeStats(prev) : null;
  }, [allSessions, periodKey]);

  // トレンドチャートデータ（古い順）
  const trendData = useMemo(() => {
    return [...filteredSessions].reverse().map(s => ({
      label: formatDateJST(s.started_at),
      revenue: s.total_revenue,
      users: s.unique_users,
      dm: dmByDate.get(toJSTDateKey(s.started_at)) || 0,
    }));
  }, [filteredSessions, dmByDate]);

  /* ------ CSV Export ------ */
  const exportCsv = useCallback(() => {
    const headers = ['配信日', '開始', '終了', '時間(分)', 'MSG数', 'ユーザー数', 'チャット売上(tk)', 'コイン売上(tk)', '総売上(tk)', '円換算'];
    const rows = filteredSessions.map(s => [
      formatDateJST(s.started_at),
      formatTimeJST(s.started_at),
      formatTimeJST(s.ended_at),
      s.duration_minutes?.toFixed(0) ?? '0',
      s.msg_count,
      s.unique_users,
      s.chat_tokens,
      s.coin_tokens,
      s.total_revenue,
      Math.round((s.total_revenue || 0) * COIN_RATE),
    ]);
    const csv = '\uFEFF' + [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${castName}_sessions_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredSessions, castName]);

  /* ------ 前期間比 ------ */
  const renderDelta = (current: number, prev: number | undefined) => {
    if (prev === undefined || prev === 0) return null;
    const pct = ((current - prev) / prev * 100).toFixed(0);
    const up = Number(pct) >= 0;
    return (
      <span className="text-[10px] ml-1" style={{ color: up ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
        {up ? '↑' : '↓'}{Math.abs(Number(pct))}%
      </span>
    );
  };

  const prevLabel = periodKey === 'this_week' ? '先週比' : periodKey === 'this_month' ? '先月比' : '';

  /* ============================================================
     Render
     ============================================================ */
  return (
    <div className="min-h-screen bg-mesh">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

        {/* ============ Breadcrumb ============ */}
        <nav className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <Link href="/casts" className="hover:underline">キャスト</Link>
          <span>/</span>
          <Link href={`/casts/${encodeURIComponent(castName)}`} className="hover:underline">{castName}</Link>
          <span>/</span>
          <span style={{ color: 'var(--text-secondary)' }}>セッション一覧</span>
        </nav>

        {/* ============ Header + Period Filter ============ */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
              📺 {castName} — 配信セッション一覧
            </h1>
            <div className="flex items-center gap-3">
              {/* 配信準備ボタン */}
              {!loading && allSessions.length > 0 && !allSessions[0]?.is_active && (
                <button
                  onClick={() => {
                    const latest = allSessions[0];
                    router.push(`/casts/${encodeURIComponent(castName)}/sessions/${encodeURIComponent(latest.broadcast_group_id)}?mode=pre`);
                  }}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:scale-105"
                  style={{
                    background: 'rgba(245,158,11,0.15)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    color: 'rgb(251,191,36)',
                  }}
                >
                  📡 配信準備
                </button>
              )}
              {!loading && allSessions.length === 0 && (
                <Link
                  href={`/casts/${encodeURIComponent(castName)}?tab=dm`}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:scale-105"
                  style={{
                    background: 'rgba(245,158,11,0.15)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    color: 'rgb(251,191,36)',
                  }}
                >
                  📡 配信準備（DM管理へ）
                </Link>
              )}
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                全 {allSessions.length} 配信
              </span>
            </div>
          </div>

          {/* Period filter buttons + CSV export */}
          <div className="flex items-center gap-2 flex-wrap">
            {PERIOD_OPTIONS.map(opt => (
              <button
                key={opt.key}
                onClick={() => setPeriodKey(opt.key)}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all"
                style={{
                  background: periodKey === opt.key ? 'rgba(56,189,248,0.2)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${periodKey === opt.key ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  color: periodKey === opt.key ? 'var(--accent-primary)' : 'var(--text-secondary)',
                }}
              >
                {opt.label}
              </button>
            ))}

            {/* CSV Export */}
            {filteredSessions.length > 0 && (
              <button
                onClick={exportCsv}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all hover:scale-105 ml-auto"
                style={{
                  background: 'rgba(34,197,94,0.12)',
                  border: '1px solid rgba(34,197,94,0.3)',
                  color: 'var(--accent-green)',
                }}
              >
                📥 CSV
              </button>
            )}
          </div>

          {/* カスタム日付ピッカー */}
          {periodKey === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="input-glass text-xs px-2 py-1.5 rounded-lg"
                style={{ maxWidth: 160 }}
              />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>〜</span>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className="input-glass text-xs px-2 py-1.5 rounded-lg"
                style={{ maxWidth: 160 }}
              />
            </div>
          )}

          {/* 期間表示 */}
          {periodKey !== 'all' && filteredSessions.length > 0 && (
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              選択期間の {filteredSessions.length} 配信を表示中
              {prevLabel && prevStats && ` （${prevLabel}: ${prevStats.totalSessions}配信）`}
            </p>
          )}
        </div>

        {/* ============ Summary KPI ============ */}
        {!loading && filteredSessions.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              {
                label: 'セッション数',
                value: String(stats.totalSessions),
                color: 'var(--text-primary)',
                prev: prevStats?.totalSessions,
              },
              {
                label: '平均配信時間',
                value: formatDuration(stats.avgDuration),
                color: 'var(--accent-primary)',
                prev: prevStats?.avgDuration,
              },
              {
                label: '総売上',
                value: formatTokens(stats.totalRevenue),
                color: 'var(--accent-amber)',
                prev: prevStats?.totalRevenue,
              },
              {
                label: '平均売上/配信',
                value: formatTokens(stats.avgRevenue),
                color: 'var(--accent-green)',
                prev: prevStats?.avgRevenue,
              },
              {
                label: '総MSG数',
                value: (stats.totalMessages ?? 0).toLocaleString(),
                color: 'var(--accent-purple)',
                prev: prevStats?.totalMessages,
              },
            ].map(kpi => (
              <div key={kpi.label} className="glass-card px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
                  {kpi.label}
                  {prevLabel && <span className="ml-1 normal-case tracking-normal">({prevLabel})</span>}
                </p>
                <p className="text-base font-bold" style={{ color: kpi.color }}>
                  {kpi.value}
                  {renderDelta(
                    kpi.label === '平均配信時間' ? stats.avgDuration : kpi.label === 'セッション数' ? stats.totalSessions : kpi.label === '総売上' ? stats.totalRevenue : kpi.label === '平均売上/配信' ? stats.avgRevenue : stats.totalMessages,
                    kpi.prev,
                  )}
                </p>
                {prevLabel && kpi.prev !== undefined && kpi.prev > 0 && (
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    前期: {kpi.label === '平均配信時間' ? formatDuration(kpi.prev) : kpi.label.includes('売上') ? formatTokens(kpi.prev) : (kpi.prev ?? 0).toLocaleString()}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ============ Trend Chart ============ */}
        {!loading && trendData.length >= 2 && (
          <div className="glass-card p-5">
            <h2 className="text-xs font-bold mb-4" style={{ color: 'var(--text-primary)' }}>
              📈 トレンド推移
              <span className="text-[10px] font-normal ml-2" style={{ color: 'var(--text-muted)' }}>
                バー: 売上(tk)　青線: ユーザー数　緑線: DM送信数
              </span>
            </h2>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Bar yAxisId="left" dataKey="revenue" name="売上(tk)" fill="rgba(245,158,11,0.5)" radius={[3, 3, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="users" name="ユーザー数" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3 }} />
                <Line yAxisId="right" type="monotone" dataKey="dm" name="DM送信数" stroke="#22c55e" strokeWidth={1.5} dot={{ r: 2 }} strokeDasharray="4 2" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ============ Session List ============ */}
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="glass-card p-5 animate-pulse">
                <div className="h-4 bg-white/5 rounded w-1/3 mb-2" />
                <div className="h-3 bg-white/5 rounded w-2/3" />
              </div>
            ))}
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="glass-card p-12 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {periodKey !== 'all' ? 'この期間の配信データがありません' : '配信セッションデータがありません'}
            </p>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              {periodKey !== 'all'
                ? '別の期間を選択するか、全期間に戻してください'
                : 'Chrome拡張でSPY監視を開始すると、配信セッションが自動で記録されます'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {displaySessions.map(s => {
              const hasCoin = s.coin_tokens > 0;
              const isMerged = s.session_ids && s.session_ids.length > 1;
              return (
                <div
                  key={s.broadcast_group_id}
                  className="glass-card-hover cursor-pointer overflow-hidden"
                  onClick={() => router.push(`/casts/${encodeURIComponent(castName)}/sessions/${encodeURIComponent(s.broadcast_group_id)}`)}
                >
                  <div className="px-5 py-4 flex items-center justify-between">
                    {/* Left: date + time + status */}
                    <div className="flex items-center gap-4">
                      {/* Date block */}
                      <div className="text-center min-w-[60px]">
                        <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                          {formatDateJST(s.started_at)}
                        </p>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {formatTimeJST(s.started_at)}〜{formatTimeJST(s.ended_at)}
                        </p>
                      </div>

                      {/* LIVE / Merged badges */}
                      <div className="flex items-center gap-1">
                        {s.is_active && (
                          <span className="badge-live text-[10px] px-2 py-0.5">LIVE</span>
                        )}
                        {isMerged && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{
                            background: 'rgba(167,139,250,0.15)',
                            border: '1px solid rgba(167,139,250,0.3)',
                            color: 'var(--accent-purple)',
                          }}>
                            {s.session_ids.length}統合
                          </span>
                        )}
                      </div>

                      {/* Title + metadata */}
                      <div>
                        {s.session_title && (
                          <p className="text-xs font-semibold" style={{ color: 'var(--accent-purple)' }}>
                            {s.session_title}
                          </p>
                        )}
                        <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          <span>⏱ {formatDuration(s.duration_minutes)}</span>
                          <span>💬 {s.msg_count} msg</span>
                          <span>👤 {s.unique_users} users</span>
                          {s.tip_count > 0 && <span>🎁 {s.tip_count} tips</span>}
                        </div>
                      </div>
                    </div>

                    {/* Right: revenue */}
                    <div className="text-right min-w-[140px]">
                      <p className="text-sm font-bold flex items-center justify-end gap-1" style={{ color: s.total_revenue > 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                        {formatTokens(s.total_revenue)}
                        {(() => {
                          const idx = displaySessions.indexOf(s);
                          if (idx >= displaySessions.length - 1) return null;
                          const prev = displaySessions[idx + 1]?.total_revenue || 0;
                          if (prev <= 0) return null;
                          const chg = ((s.total_revenue - prev) / prev * 100).toFixed(0);
                          return (
                            <span className="text-[10px]" style={{ color: Number(chg) >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                              {Number(chg) >= 0 ? '⇑' : '⇓'}{chg}%
                            </span>
                          );
                        })()}
                      </p>
                      {s.total_revenue > 0 && (
                        <p className="text-[10px]" style={{ color: 'var(--accent-green)' }}>
                          {tokensToJPY(s.total_revenue, COIN_RATE)}
                        </p>
                      )}
                      {/* Coin内訳ミニバー */}
                      {hasCoin && (
                        <div className="flex items-center gap-0.5 mt-1 justify-end">
                          {[
                            { val: s.coin_tip_tokens, color: '#f59e0b', label: 'tip' },
                            { val: s.coin_private_tokens, color: '#f43f5e', label: 'pvt' },
                            { val: s.coin_ticket_tokens, color: '#a78bfa', label: 'tkt' },
                            { val: s.coin_group_tokens, color: '#38bdf8', label: 'grp' },
                            { val: s.coin_spy_tokens, color: '#22c55e', label: 'spy' },
                            { val: s.coin_other_tokens, color: '#64748b', label: 'etc' },
                          ].filter(c => c.val > 0).map(c => (
                            <div
                              key={c.label}
                              title={`${c.label}: ${formatTokens(c.val)}`}
                              style={{
                                width: `${Math.max(6, Math.round(s.coin_tokens > 0 ? c.val / s.coin_tokens * 60 : 0))}px`,
                                height: '4px',
                                background: c.color,
                                borderRadius: '1px',
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ============ Pagination ============ */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-30"
            >
              ← 前へ
            </button>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-30"
            >
              次へ →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
