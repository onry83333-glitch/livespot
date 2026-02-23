'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, formatJST } from '@/lib/utils';
import Link from 'next/link';

/* ============================================================
   Types
   ============================================================ */
interface SessionSummary {
  session_id: string;
  title: string;
  cast_name: string;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  total_messages: number;
  total_tips: number;
  spy_tokens: number;
  unique_chatters: number;
  peak_viewers: number;
  coin_revenue: number;
  revenue_by_type: Record<string, number>;
  new_users: number;
  returning_users: number;
  top_users: { user_name: string; tokens: number; types: string[]; is_new: boolean }[];
  prev_session_id: string | null;
  prev_session_date: string | null;
  prev_coin_revenue: number;
  change_pct: number | null;
}

const COIN_RATE = 7.7;

function formatDuration(minutes: number): string {
  if (minutes < 0) return '-';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分`;
  return `${h}時間${m > 0 ? `${m}分` : ''}`;
}

/* ============================================================
   Component
   ============================================================ */
export default function SessionDetailPage() {
  const params = useParams();
  const { user } = useAuth();
  const castName = decodeURIComponent(params.castName as string);
  const sessionId = decodeURIComponent(params.sessionId as string);

  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get accountId
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  // Load session summary via RPC
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);

    sb.rpc('get_session_summary', {
      p_account_id: accountId,
      p_session_id: sessionId,
    }).then(({ data, error: rpcError }) => {
      if (rpcError) {
        console.error('[Session] RPC error:', rpcError.message);
        setError(`RPC未適用: get_session_summary を Supabase SQL Editor で実行してください`);
        setLoading(false);
        return;
      }

      const rows = data as SessionSummary[] | null;
      if (rows && rows.length > 0) {
        setSummary(rows[0]);
      } else {
        setError('セッションが見つかりません');
      }
      setLoading(false);
    });
  }, [accountId, sessionId, sb]);

  return (
    <div className="min-h-screen bg-mesh">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* ============ Header ============ */}
        <div className="flex items-center gap-3">
          <Link
            href={`/casts/${encodeURIComponent(castName)}/sessions`}
            className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            ← セッション一覧
          </Link>
          <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            📺 セッション詳細
          </h1>
        </div>

        {/* ============ Loading / Error ============ */}
        {loading ? (
          <div className="glass-card p-12 text-center">
            <div className="inline-block w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
          </div>
        ) : error ? (
          <div className="glass-card p-8 text-center">
            <p className="text-sm" style={{ color: 'var(--accent-pink)' }}>{error}</p>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              migration 049 を Supabase SQL Editor で適用してください
            </p>
          </div>
        ) : summary ? (
          <>
            {/* ============ Session Info ============ */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                    {summary.title || summary.cast_name}
                  </h2>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {formatJST(summary.started_at)} 〜 {formatJST(summary.ended_at)}
                    <span className="ml-3">⏱ {formatDuration(summary.duration_minutes)}</span>
                  </p>
                </div>
                {summary.change_pct !== null && (
                  <div className="text-right">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>前回比</p>
                    <p className="text-sm font-bold" style={{
                      color: summary.change_pct >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)',
                    }}>
                      {summary.change_pct >= 0 ? '+' : ''}{summary.change_pct}%
                    </p>
                  </div>
                )}
              </div>

              {/* KPI Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'コイン売上', value: formatTokens(summary.coin_revenue), sub: tokensToJPY(summary.coin_revenue, COIN_RATE), color: 'var(--accent-amber)' },
                  { label: 'SPYチップ', value: formatTokens(summary.spy_tokens), sub: `${summary.total_tips} tips`, color: 'var(--accent-primary)' },
                  { label: 'チャッター', value: `${summary.unique_chatters}`, sub: `新規 ${summary.new_users} / 既存 ${summary.returning_users}`, color: 'var(--accent-purple)' },
                  { label: 'メッセージ', value: `${summary.total_messages}`, sub: summary.peak_viewers > 0 ? `最大 ${summary.peak_viewers} 視聴者` : '', color: 'var(--text-primary)' },
                ].map(kpi => (
                  <div key={kpi.label} className="glass-panel px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{kpi.label}</p>
                    <p className="text-base font-bold" style={{ color: kpi.color }}>{kpi.value}</p>
                    {kpi.sub && <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{kpi.sub}</p>}
                  </div>
                ))}
              </div>
            </div>

            {/* ============ Revenue Breakdown ============ */}
            {Object.keys(summary.revenue_by_type).length > 0 && (
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>💰 売上内訳（コインAPI）</h3>
                <div className="space-y-2">
                  {Object.entries(summary.revenue_by_type)
                    .sort(([, a], [, b]) => b - a)
                    .map(([type, tokens]) => {
                      const pct = summary.coin_revenue > 0 ? Math.round(tokens / summary.coin_revenue * 100) : 0;
                      return (
                        <div key={type} className="flex items-center gap-3">
                          <span className="text-xs w-24 text-right" style={{ color: 'var(--text-secondary)' }}>{type}</span>
                          <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${pct}%`,
                                background: 'linear-gradient(90deg, var(--accent-amber), var(--accent-green))',
                              }}
                            />
                          </div>
                          <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-amber)' }}>
                            {formatTokens(tokens)}
                          </span>
                          <span className="text-[10px] min-w-[40px] text-right" style={{ color: 'var(--text-muted)' }}>
                            {pct}%
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* ============ Top Users ============ */}
            {summary.top_users && summary.top_users.length > 0 && (
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>👑 トップユーザー</h3>
                <div className="space-y-1.5">
                  {summary.top_users.map((u, i) => (
                    <div key={u.user_name} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.02]">
                      <span className="text-xs font-bold w-6" style={{ color: i < 3 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                        #{i + 1}
                      </span>
                      <Link
                        href={`/users/${encodeURIComponent(u.user_name)}`}
                        className="text-xs font-semibold hover:underline"
                        style={{ color: 'var(--accent-primary)' }}
                        onClick={e => e.stopPropagation()}
                      >
                        {u.user_name}
                      </Link>
                      {u.is_new && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--accent-green)' }}>
                          NEW
                        </span>
                      )}
                      <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                        {u.types.join(', ')}
                      </span>
                      <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-amber)' }}>
                        {formatTokens(u.tokens)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ============ Previous Session Comparison ============ */}
            {summary.prev_session_id && (
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>📊 前回セッション比較</h3>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>前回売上</p>
                    <p className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{formatTokens(summary.prev_coin_revenue)}</p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{summary.prev_session_date}</p>
                  </div>
                  <div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>今回売上</p>
                    <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(summary.coin_revenue)}</p>
                  </div>
                  <div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>変化率</p>
                    <p className="text-sm font-bold" style={{
                      color: (summary.change_pct ?? 0) >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)',
                    }}>
                      {summary.change_pct !== null ? `${summary.change_pct >= 0 ? '+' : ''}${summary.change_pct}%` : '-'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
