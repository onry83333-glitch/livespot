'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, formatJST } from '@/lib/utils';
import Link from 'next/link';

/* ============================================================
   Types
   ============================================================ */
interface SessionRow {
  session_id: string;
  title: string;
  cast_name: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number;
  total_messages: number;
  total_tokens: number;
  peak_viewers: number;
  unique_chatters: number;
  tip_count: number;
  coin_revenue: number;
  is_active: boolean;
  total_count: number;
}

const COIN_RATE = 7.7;
const PAGE_SIZE = 20;

/* ============================================================
   Helper: 配信時間フォーマット
   ============================================================ */
function formatDuration(minutes: number): string {
  if (minutes < 0) return '-';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分`;
  return `${h}時間${m > 0 ? `${m}分` : ''}`;
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

  // Summary stats
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

  // Load sessions via RPC
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
      // Fallback: direct query
      const since = new Date(Date.now() - 90 * 86400000).toISOString();
      const { data: fallbackData } = await sb
        .from('sessions')
        .select('*')
        .eq('account_id', accountId)
        .or(`cast_name.eq.${castName},title.eq.${castName}`)
        .gte('started_at', since)
        .order('started_at', { ascending: false })
        .range(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE - 1);

      if (fallbackData) {
        const rows: SessionRow[] = fallbackData.map((s: Record<string, unknown>) => ({
          session_id: s.session_id as string,
          title: (s.title || s.cast_name || castName) as string,
          cast_name: (s.cast_name || s.title || castName) as string,
          started_at: s.started_at as string,
          ended_at: s.ended_at as string | null,
          duration_minutes: s.ended_at
            ? Math.round((new Date(s.ended_at as string).getTime() - new Date(s.started_at as string).getTime()) / 60000)
            : 0,
          total_messages: (s.total_messages || 0) as number,
          total_tokens: (s.total_tokens || 0) as number,
          peak_viewers: (s.peak_viewers || 0) as number,
          unique_chatters: 0,
          tip_count: 0,
          coin_revenue: 0,
          is_active: s.ended_at === null,
          total_count: 0,
        }));
        setSessions(rows);
        setTotalCount(rows.length);
      }
      setLoading(false);
      return;
    }

    const rows = (data || []) as SessionRow[];
    setSessions(rows);
    if (rows.length > 0) {
      setTotalCount(rows[0].total_count);
    } else if (pageNum === 0) {
      setTotalCount(0);
    }

    // Calculate summary from first page
    if (pageNum === 0 && rows.length > 0) {
      const total = rows[0].total_count;
      const totalRev = rows.reduce((sum, r) => sum + r.coin_revenue, 0);
      const avgRev = rows.length > 0 ? Math.round(totalRev / rows.length) : 0;
      const avgDur = rows.length > 0 ? Math.round(rows.reduce((sum, r) => sum + r.duration_minutes, 0) / rows.length) : 0;
      const totalMsg = rows.reduce((sum, r) => sum + r.total_messages, 0);
      setSummaryStats({
        totalSessions: total,
        totalRevenue: totalRev,
        avgRevenue: avgRev,
        avgDuration: avgDur,
        totalMessages: totalMsg,
      });
    }

    setLoading(false);
  }, [accountId, castName, sb]);

  useEffect(() => {
    loadSessions(page);
  }, [page, loadSessions]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <div className="min-h-screen bg-mesh">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        {/* ============ Header ============ */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href={`/casts/${encodeURIComponent(castName)}?tab=sessions`}
              className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              ← キャスト詳細
            </Link>
            <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
              📺 {castName} — 配信セッション一覧
            </h1>
          </div>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            全 {totalCount} セッション
          </span>
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
                        {formatTimeJST(s.started_at)}
                        {s.ended_at ? `〜${formatTimeJST(s.ended_at)}` : '〜配信中'}
                      </p>
                    </div>

                    {/* Status badge */}
                    {s.is_active && (
                      <span className="badge-live text-[10px] px-2 py-0.5">LIVE</span>
                    )}

                    {/* Title + metadata */}
                    <div>
                      {s.title && s.title !== s.cast_name && (
                        <p className="text-xs font-semibold" style={{ color: 'var(--accent-purple)' }}>
                          {s.title}
                        </p>
                      )}
                      <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span>⏱ {formatDuration(s.duration_minutes)}</span>
                        <span>💬 {s.total_messages} msg</span>
                        <span>👤 {s.unique_chatters} users</span>
                        {s.peak_viewers > 0 && <span>👁 max {s.peak_viewers}</span>}
                        {s.tip_count > 0 && <span>🎁 {s.tip_count} tips</span>}
                      </div>
                    </div>
                  </div>

                  {/* Right: revenue */}
                  <div className="text-right min-w-[120px]">
                    {s.coin_revenue > 0 ? (
                      <>
                        <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>
                          {formatTokens(s.coin_revenue)}
                        </p>
                        <p className="text-[10px]" style={{ color: 'var(--accent-green)' }}>
                          {tokensToJPY(s.coin_revenue, COIN_RATE)}
                        </p>
                      </>
                    ) : s.total_tokens > 0 ? (
                      <>
                        <p className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>
                          {formatTokens(s.total_tokens)}
                        </p>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          SPYベース
                        </p>
                      </>
                    ) : (
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>-</p>
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
