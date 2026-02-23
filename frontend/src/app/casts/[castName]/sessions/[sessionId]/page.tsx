'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, formatJST } from '@/lib/utils';
import Link from 'next/link';

/* ============================================================
   Types — RPC get_session_summary の戻り値に一致
   全データは spy_messages.session_id GROUP BY で導出
   ============================================================ */
interface SessionSummary {
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
  tokens_by_type: Record<string, number>;
  top_users: { user_name: string; tokens: number; tip_count: number }[];
  prev_session_id: string | null;
  prev_total_tokens: number | null;
  prev_started_at: string | null;
  change_pct: number | null;
}

const COIN_RATE = 7.7;

function formatDuration(minutes: number): string {
  if (!minutes || minutes < 0) return '0分';
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}分`;
  return `${h}時間${rem > 0 ? `${rem}分` : ''}`;
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

  // Load session summary via RPC, fallback to direct query
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);

    sb.rpc('get_session_summary', {
      p_account_id: accountId,
      p_session_id: sessionId,
    }).then(async ({ data, error: rpcError }) => {
      if (!rpcError && data && (data as unknown[]).length > 0) {
        const row = (data as SessionSummary[])[0];
        // top_users が文字列の場合パース
        if (typeof row.top_users === 'string') {
          try { row.top_users = JSON.parse(row.top_users); } catch { row.top_users = []; }
        }
        if (typeof row.tokens_by_type === 'string') {
          try { row.tokens_by_type = JSON.parse(row.tokens_by_type); } catch { row.tokens_by_type = {}; }
        }
        setSummary(row);
        setLoading(false);
        return;
      }

      // Fallback: spy_messages から直接集計
      console.warn('[Session] RPC failed or empty, fallback to direct query:', rpcError?.message);
      await loadFallback();
    });
  }, [accountId, sessionId, sb]);

  // Fallback: spy_messages から直接クエリ
  const loadFallback = async () => {
    const { data: msgs } = await sb
      .from('spy_messages')
      .select('session_id, cast_name, session_title, message_time, user_name, tokens, msg_type')
      .eq('account_id', accountId!)
      .eq('session_id', sessionId)
      .order('message_time', { ascending: true });

    if (!msgs || msgs.length === 0) {
      setError('セッションが見つかりません');
      setLoading(false);
      return;
    }

    const times = msgs.map(m => new Date(m.message_time).getTime());
    const users = new Set(msgs.filter(m => m.user_name).map(m => m.user_name));
    const totalTk = msgs.reduce((s, m) => s + (m.tokens > 0 ? m.tokens : 0), 0);
    const tips = msgs.filter(m => m.tokens > 0);

    // msg_type別集計
    const typeMap: Record<string, number> = {};
    for (const m of msgs) {
      if (m.tokens > 0 && m.msg_type) {
        typeMap[m.msg_type] = (typeMap[m.msg_type] || 0) + m.tokens;
      }
    }

    // トップ5ユーザー
    const userMap = new Map<string, { tokens: number; count: number }>();
    for (const m of tips) {
      if (!m.user_name) continue;
      const u = userMap.get(m.user_name) || { tokens: 0, count: 0 };
      u.tokens += m.tokens;
      u.count += 1;
      userMap.set(m.user_name, u);
    }
    const top5 = Array.from(userMap.entries())
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 5)
      .map(([name, v]) => ({ user_name: name, tokens: v.tokens, tip_count: v.count }));

    setSummary({
      session_id: sessionId,
      cast_name: msgs[0].cast_name,
      session_title: msgs[0].session_title,
      started_at: new Date(Math.min(...times)).toISOString(),
      ended_at: new Date(Math.max(...times)).toISOString(),
      duration_minutes: Math.round((Math.max(...times) - Math.min(...times)) / 60000),
      msg_count: msgs.length,
      unique_users: users.size,
      total_tokens: totalTk,
      tip_count: tips.length,
      tokens_by_type: typeMap,
      top_users: top5,
      prev_session_id: null,
      prev_total_tokens: null,
      prev_started_at: null,
      change_pct: null,
    });
    setLoading(false);
  };

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
              migration 050 を Supabase SQL Editor で適用してください
            </p>
          </div>
        ) : summary ? (
          <>
            {/* ============ Session Info ============ */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                    {summary.session_title || summary.cast_name}
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
                  { label: '売上', value: formatTokens(summary.total_tokens), sub: tokensToJPY(summary.total_tokens, COIN_RATE), color: 'var(--accent-amber)' },
                  { label: 'チップ数', value: `${summary.tip_count}`, sub: `${formatTokens(summary.total_tokens)} tk`, color: 'var(--accent-primary)' },
                  { label: 'ユーザー', value: `${summary.unique_users}`, sub: '', color: 'var(--accent-purple)' },
                  { label: 'メッセージ', value: `${summary.msg_count}`, sub: '', color: 'var(--text-primary)' },
                ].map(kpi => (
                  <div key={kpi.label} className="glass-panel px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{kpi.label}</p>
                    <p className="text-base font-bold" style={{ color: kpi.color }}>{kpi.value}</p>
                    {kpi.sub && <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{kpi.sub}</p>}
                  </div>
                ))}
              </div>
            </div>

            {/* ============ Tokens by msg_type ============ */}
            {summary.tokens_by_type && Object.keys(summary.tokens_by_type).length > 0 && (
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>💰 売上内訳（msg_type別）</h3>
                <div className="space-y-2">
                  {Object.entries(summary.tokens_by_type)
                    .sort(([, a], [, b]) => b - a)
                    .map(([type, tokens]) => {
                      const pct = summary.total_tokens > 0 ? Math.round(tokens / summary.total_tokens * 100) : 0;
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
                      <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                        {u.tip_count} tips
                      </span>
                      <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-amber)' }}>
                        {formatTokens(u.tokens)}
                      </span>
                      <span className="text-[10px] min-w-[60px] text-right" style={{ color: 'var(--accent-green)' }}>
                        {tokensToJPY(u.tokens, COIN_RATE)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ============ Previous Session Comparison ============ */}
            {summary.prev_session_id && summary.prev_total_tokens !== null && (
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>📊 前回セッション比較</h3>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>前回売上</p>
                    <p className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{formatTokens(summary.prev_total_tokens)}</p>
                    {summary.prev_started_at && (
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatJST(summary.prev_started_at).split(' ')[0]}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>今回売上</p>
                    <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(summary.total_tokens)}</p>
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
