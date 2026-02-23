'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY } from '@/lib/utils';
import Link from 'next/link';

/* ============================================================
   Types — RPC get_session_list の戻り値に一致
   session データは spy_messages.session_id の GROUP BY で導出
   ============================================================ */
interface SessionRow {
  session_id: string;
  cast_name: string;
  session_title: string | null;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  msg_count: number;
  unique_users: number;
  total_tokens: number;
  tip_count: number;
  is_active: boolean;
  total_count: number;
}

const COIN_RATE = 7.7;
const PAGE_SIZE = 20;

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
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // Summary stats (calculated from loaded data)
  const [summaryStats, setSummaryStats] = useState({
    totalSessions: 0,
    totalRevenue: 0,
    avgRevenue: 0,
    avgDuration: 0,
    totalMessages: 0,
  });

  // Get accountId
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  // Load sessions via RPC (spy_messages GROUP BY session_id)
  const loadSessions = useCallback(async (pageNum: number) => {
    if (!accountId) return;
    setLoading(true);

    const { data, error } = await sb.rpc('get_session_list', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_limit: PAGE_SIZE,
      p_offset: pageNum * PAGE_SIZE,
    });

    if (error) {
      console.error('[Sessions] RPC error:', error.message);
      // Fallback: spy_messages を直接 GROUP BY
      await loadSessionsFallback(pageNum);
      return;
    }

    const rows = (data || []) as SessionRow[];
    setSessions(rows);
    if (rows.length > 0) {
      setTotalCount(rows[0].total_count);
    } else if (pageNum === 0) {
      setTotalCount(0);
    }

    // KPI集計 (表示ページ分)
    if (pageNum === 0) {
      computeSummary(rows);
    }

    setLoading(false);
  }, [accountId, castName, sb]);

  // Fallback: RPCが無い場合、spy_messagesから直接GROUP BY
  const loadSessionsFallback = useCallback(async (pageNum: number) => {
    console.log('[Sessions] Fallback: spy_messages direct query');
    const { data: rawData } = await sb
      .from('spy_messages')
      .select('session_id, cast_name, session_title, message_time, user_name, tokens')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .not('session_id', 'is', null)
      .order('message_time', { ascending: false })
      .limit(2000);

    if (!rawData || rawData.length === 0) {
      setSessions([]);
      setTotalCount(0);
      setLoading(false);
      return;
    }

    // クライアント側でGROUP BY session_id
    const sessionMap = new Map<string, {
      session_id: string; cast_name: string; session_title: string | null;
      messages: { time: string; user_name: string | null; tokens: number }[];
    }>();

    for (const r of rawData) {
      if (!r.session_id) continue;
      if (!sessionMap.has(r.session_id)) {
        sessionMap.set(r.session_id, {
          session_id: r.session_id,
          cast_name: r.cast_name,
          session_title: r.session_title,
          messages: [],
        });
      }
      sessionMap.get(r.session_id)!.messages.push({
        time: r.message_time,
        user_name: r.user_name,
        tokens: r.tokens || 0,
      });
    }

    const allRows: SessionRow[] = [];
    const now = Date.now();
    for (const entry of Array.from(sessionMap.entries())) {
      const [sid, sess] = entry;
      const times = sess.messages.map(m => new Date(m.time).getTime());
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const users = new Set(sess.messages.filter(m => m.user_name).map(m => m.user_name));
      const totalTk = sess.messages.reduce((s, m) => s + (m.tokens > 0 ? m.tokens : 0), 0);
      const tips = sess.messages.filter(m => m.tokens > 0).length;

      allRows.push({
        session_id: sid,
        cast_name: sess.cast_name,
        session_title: sess.session_title,
        started_at: new Date(minTime).toISOString(),
        ended_at: new Date(maxTime).toISOString(),
        duration_minutes: Math.round((maxTime - minTime) / 60000),
        msg_count: sess.messages.length,
        unique_users: users.size,
        total_tokens: totalTk,
        tip_count: tips,
        is_active: (now - maxTime) < 10 * 60 * 1000,
        total_count: 0,
      });
    }

    allRows.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    const total = allRows.length;
    const sliced = allRows.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);
    sliced.forEach(r => r.total_count = total);

    setSessions(sliced);
    setTotalCount(total);

    if (pageNum === 0) {
      computeSummary(sliced);
    }

    setLoading(false);
  }, [accountId, castName, sb]);

  // KPI集計
  const computeSummary = (rows: SessionRow[]) => {
    if (rows.length === 0) {
      setSummaryStats({ totalSessions: 0, totalRevenue: 0, avgRevenue: 0, avgDuration: 0, totalMessages: 0 });
      return;
    }
    const total = rows[0].total_count || rows.length;
    const totalRev = rows.reduce((s, r) => s + r.total_tokens, 0);
    const avgRev = rows.length > 0 ? Math.round(totalRev / rows.length) : 0;
    const avgDur = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.duration_minutes, 0) / rows.length) : 0;
    const totalMsg = rows.reduce((s, r) => s + r.msg_count, 0);
    setSummaryStats({ totalSessions: total, totalRevenue: totalRev, avgRevenue: avgRev, avgDuration: avgDur, totalMessages: totalMsg });
  };

  useEffect(() => {
    loadSessions(page);
  }, [page, loadSessions]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

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

        {/* ============ Header ============ */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            📺 {castName} — 配信セッション一覧
          </h1>
          <div className="flex items-center gap-3">
            {/* 配信準備ボタン: セッションあり→最新終了セッション、なし→DM管理 */}
            {sessions.length > 0 && !sessions[0]?.is_active ? (
              <button
                onClick={() => {
                  const latest = sessions[0];
                  router.push(`/casts/${encodeURIComponent(castName)}/sessions/${encodeURIComponent(latest.session_id)}?mode=pre`);
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
            ) : !loading && sessions.length === 0 ? (
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
            ) : null}
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              全 {totalCount} セッション
            </span>
          </div>
        </div>

        {/* ============ Summary KPI ============ */}
        {!loading && sessions.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'セッション数', value: String(summaryStats.totalSessions), color: 'var(--text-primary)' },
              { label: '平均配信時間', value: formatDuration(summaryStats.avgDuration), color: 'var(--accent-primary)' },
              { label: '表示ページ売上', value: formatTokens(summaryStats.totalRevenue), color: 'var(--accent-amber)' },
              { label: '平均売上/配信', value: formatTokens(summaryStats.avgRevenue), color: 'var(--accent-green)' },
              { label: '表示ページMSG', value: summaryStats.totalMessages.toLocaleString(), color: 'var(--accent-purple)' },
            ].map(kpi => (
              <div key={kpi.label} className="glass-card px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{kpi.label}</p>
                <p className="text-base font-bold" style={{ color: kpi.color }}>{kpi.value}</p>
              </div>
            ))}
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
        ) : sessions.length === 0 ? (
          <div className="glass-card p-12 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>配信セッションデータがありません</p>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              Chrome拡張でSPY監視を開始すると、配信セッションが自動で記録されます
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map(s => (
              <div
                key={s.session_id}
                className="glass-card-hover cursor-pointer overflow-hidden"
                onClick={() => router.push(`/casts/${encodeURIComponent(castName)}/sessions/${encodeURIComponent(s.session_id)}`)}
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

                    {/* LIVE badge */}
                    {s.is_active && (
                      <span className="badge-live text-[10px] px-2 py-0.5">LIVE</span>
                    )}

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
                  <div className="text-right min-w-[120px]">
                    <p className="text-sm font-bold" style={{ color: s.total_tokens > 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                      {formatTokens(s.total_tokens)}
                    </p>
                    {s.total_tokens > 0 && (
                      <p className="text-[10px]" style={{ color: 'var(--accent-green)' }}>
                        {tokensToJPY(s.total_tokens, COIN_RATE)}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
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
