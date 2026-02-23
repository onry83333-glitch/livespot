// -*- coding: utf-8 -*-
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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

interface SessionActions {
  first_time_payers: { user_name: string; session_tokens: number; dm_sent: boolean }[];
  high_spenders: { user_name: string; session_tokens: number }[];
  visited_no_action: { user_name: string; segment: string }[];
  dm_no_visit: { user_name: string; segment: string; dm_sent_at: string }[];
  segment_breakdown: { segment: string; dm_sent: number; visited: number; paid: number }[];
}

type BroadcastMode = 'pre' | 'live' | 'post';

/* ============================================================
   Labels — all UI text in one place to avoid encoding issues
   ============================================================ */
const LABELS = {
  min: '分',
  hours: '時間',
  sessionDetail: 'セッション詳細',
  backToList: 'セッション一覧',
  preBroadcast: '配信前',
  duringBroadcast: '配信中',
  postBroadcast: '配信後',
  developing: '開発中',
  loading: '読み込み中...',
  checkConsole: 'ブラウザの開発者コンソールを確認してください',
  sessionNotFound: 'セッションが見つかりません',
  prevCompare: '前回比',
  sales: '売上',
  tipCount: 'チップ数',
  users: 'ユーザー',
  messages: 'メッセージ',
  salesBreakdown: '売上内訳（msg_type別）',
  topUsers: 'トップユーザー',
  prevComparison: '前回セッション比較',
  prevSales: '前回売上',
  currentSales: '今回売上',
  changeRate: '変化率',
  analyzingActions: 'アクション分析中...',
  actionHeader: '今すぐやること',
  firstTimePayers: '初課金ユーザーへお礼DM',
  highSpenders: '高額課金ユーザーへ特別DM',
  visitedNoAction: '来訪したがアクションなし',
  dmNoVisit: 'DM送信→未来訪',
  sendTemplate: 'テンプレートで一括送信',
  createDm: '個別DM作成',
  followDm: 'フォローDMを送る',
  notImplemented: '次フェーズで実装予定',
  noData: '該当なし',
  dmSentBadge: '送信済み',
  personSuffix: '人',
  reviewDmTarget: '次回のDMターゲット見直しを検討',
  showFormulaTitle: '計算式を表示',
  segmentBreakdown: 'セグメント別ブレイクダウン',
  segment: 'セグメント',
  dmSentCol: 'DM送信',
  visited: '来訪',
  paid: '課金',
  total: '合計',
} as const;

const COIN_RATE = 7.7;

/* ============================================================
   Helpers
   ============================================================ */
function formatDuration(minutes: number): string {
  if (!minutes || minutes < 0) return `0${LABELS.min}`;
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}${LABELS.min}`;
  return `${h}${LABELS.hours}${rem > 0 ? `${rem}${LABELS.min}` : ''}`;
}

function groupBySegmentRange(items: { segment: string }[]): { label: string; count: number }[] {
  const ranges = [
    { label: 'S1-S3', segments: ['S1', 'S2', 'S3'] },
    { label: 'S4-S6', segments: ['S4', 'S5', 'S6'] },
    { label: 'S7-S9', segments: ['S7', 'S8', 'S9'] },
    { label: 'S10', segments: ['S10'] },
  ];
  return ranges.map(r => ({
    label: r.label,
    count: items.filter(i => r.segments.includes(i.segment)).length,
  })).filter(r => r.count > 0);
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

  const [mode, setMode] = useState<BroadcastMode>('post');
  const [actions, setActions] = useState<SessionActions | null>(null);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showFormula, setShowFormula] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    setError(null);

    sb.rpc('get_session_summary', {
      p_account_id: accountId,
      p_session_id: sessionId,
    }).then(async ({ data, error: rpcError }) => {
      if (rpcError) {
        console.warn('[Session] RPC error, fallback:', rpcError.message);
        await loadFallback();
        return;
      }

      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length > 0) {
        const row = rows[0] as SessionSummary;
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

      await loadFallback();
    });
  }, [accountId, sessionId, sb]);

  const loadFallback = async () => {
    const { data: msgs } = await sb
      .from('spy_messages')
      .select('session_id, cast_name, session_title, message_time, user_name, tokens, msg_type')
      .eq('account_id', accountId!)
      .eq('session_id', sessionId)
      .order('message_time', { ascending: true });

    if (!msgs || msgs.length === 0) {
      setError(`${LABELS.sessionNotFound} (session_id: ${sessionId.slice(0, 8)}...)`);
      setLoading(false);
      return;
    }

    const times = msgs.map(m => new Date(m.message_time).getTime());
    const users = new Set(msgs.filter(m => m.user_name).map(m => m.user_name));
    const totalTk = msgs.reduce((s, m) => s + (m.tokens > 0 ? m.tokens : 0), 0);
    const tips = msgs.filter(m => m.tokens > 0);

    const typeMap: Record<string, number> = {};
    for (const m of msgs) {
      if (m.tokens > 0 && m.msg_type) {
        typeMap[m.msg_type] = (typeMap[m.msg_type] || 0) + m.tokens;
      }
    }

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

  useEffect(() => {
    if (!summary) return;
    const endedAt = new Date(summary.ended_at).getTime();
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    setMode(endedAt < tenMinAgo ? 'post' : 'live');
  }, [summary]);

  const loadActions = useCallback(async () => {
    if (!accountId || mode !== 'post') return;
    setActionsLoading(true);
    const { data, error: actErr } = await sb.rpc('get_session_actions', {
      p_account_id: accountId,
      p_session_id: sessionId,
    });
    if (actErr) {
      console.warn('[Session] get_session_actions RPC error:', actErr.message);
      setActionsLoading(false);
      return;
    }
    const result = Array.isArray(data) ? data[0] : data;
    if (result) setActions(result as SessionActions);
    setActionsLoading(false);
  }, [accountId, sessionId, mode, sb]);

  useEffect(() => { loadActions(); }, [loadActions]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const modeLabels: Record<BroadcastMode, string> = {
    pre: LABELS.preBroadcast,
    live: LABELS.duringBroadcast,
    post: LABELS.postBroadcast,
  };

  return (
    <div className="min-h-screen bg-mesh">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link
            href={`/casts/${encodeURIComponent(castName)}/sessions`}
            className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            {`← ${LABELS.backToList}`}
          </Link>
          <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {`📺 ${LABELS.sessionDetail}`}
          </h1>
        </div>

        {/* Mode Tabs */}
        {summary && (
          <div className="flex gap-1">
            {(['pre', 'live', 'post'] as BroadcastMode[]).map(m => {
              const isActive = mode === m;
              const isPost = m === 'post';
              return (
                <button
                  key={m}
                  onClick={() => {
                    if (isPost) {
                      setMode('post');
                    } else {
                      setToast(LABELS.developing);
                    }
                  }}
                  className="px-4 py-2 text-xs font-semibold rounded-t-lg transition-all"
                  style={{
                    background: isActive ? 'rgba(16,185,129,0.1)' : 'transparent',
                    borderBottom: isActive ? '2px solid rgb(16,185,129)' : '2px solid transparent',
                    color: isActive ? 'rgb(52,211,153)' : 'var(--text-muted)',
                    opacity: isPost ? 1 : 0.6,
                  }}
                >
                  {modeLabels[m]}
                </button>
              );
            })}
          </div>
        )}

        {/* Loading / Error */}
        {loading ? (
          <div className="glass-card p-12 text-center">
            <div className="inline-block w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>{LABELS.loading}</p>
          </div>
        ) : error ? (
          <div className="glass-card p-8 text-center">
            <p className="text-sm" style={{ color: 'var(--accent-pink)' }}>{error}</p>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{LABELS.checkConsole}</p>
          </div>
        ) : summary ? (
          <>
            {/* Session Info */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                    {summary.session_title || summary.cast_name}
                  </h2>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {formatJST(summary.started_at)} ~ {formatJST(summary.ended_at)}
                    <span className="ml-3">{`⏱ ${formatDuration(summary.duration_minutes)}`}</span>
                  </p>
                </div>
                {summary.change_pct !== null && (
                  <div className="text-right">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.prevCompare}</p>
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
                  { label: LABELS.sales, value: formatTokens(summary.total_tokens), sub: tokensToJPY(summary.total_tokens, COIN_RATE), color: 'var(--accent-amber)' },
                  { label: LABELS.tipCount, value: `${summary.tip_count}`, sub: `${summary.tip_count > 0 ? `${Math.round(summary.total_tokens / summary.tip_count)} tk/tip` : ''}`, color: 'var(--accent-primary)' },
                  { label: LABELS.users, value: `${summary.unique_users}`, sub: '', color: 'var(--accent-purple)' },
                  { label: LABELS.messages, value: `${summary.msg_count}`, sub: '', color: 'var(--text-primary)' },
                ].map(kpi => (
                  <div key={kpi.label} className="glass-panel px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{kpi.label}</p>
                    <p className="text-base font-bold" style={{ color: kpi.color }}>{kpi.value}</p>
                    {kpi.sub && <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{kpi.sub}</p>}
                  </div>
                ))}
              </div>
            </div>

            {/* Tokens by msg_type */}
            {summary.tokens_by_type && Object.keys(summary.tokens_by_type).length > 0 && (
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`💰 ${LABELS.salesBreakdown}`}</h3>
                <div className="space-y-2">
                  {(() => {
                    const typeTotal = Object.values(summary.tokens_by_type).reduce((s, v) => s + v, 0);
                    return Object.entries(summary.tokens_by_type)
                    .sort(([, a], [, b]) => b - a)
                    .map(([type, tokens]) => {
                      const pct = typeTotal > 0 ? Math.round(tokens / typeTotal * 100) : 0;
                      return (
                        <div key={type} className="flex items-center gap-3">
                          <span className="text-xs w-24 text-right" style={{ color: 'var(--text-secondary)' }}>{type}</span>
                          <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--accent-amber), var(--accent-green))' }} />
                          </div>
                          <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-amber)' }}>{formatTokens(tokens)}</span>
                          <span className="text-[10px] min-w-[40px] text-right" style={{ color: 'var(--text-muted)' }}>{pct}%</span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}

            {/* Top Users */}
            {summary.top_users && summary.top_users.length > 0 && (
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`👑 ${LABELS.topUsers}`}</h3>
                <div className="space-y-1.5">
                  {summary.top_users.map((u, i) => (
                    <div key={u.user_name} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.02]">
                      <span className="text-xs font-bold w-6" style={{ color: i < 3 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>#{i + 1}</span>
                      <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }} onClick={e => e.stopPropagation()}>
                        {u.user_name}
                      </Link>
                      <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{u.tip_count} tips</span>
                      <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.tokens)}</span>
                      <span className="text-[10px] min-w-[60px] text-right" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.tokens, COIN_RATE)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Previous Session Comparison */}
            {summary.prev_session_id && summary.prev_total_tokens !== null && (
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`📊 ${LABELS.prevComparison}`}</h3>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.prevSales}</p>
                    <p className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{formatTokens(summary.prev_total_tokens)}</p>
                    {summary.prev_started_at && (
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatJST(summary.prev_started_at).split(' ')[0]}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.currentSales}</p>
                    <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(summary.total_tokens)}</p>
                  </div>
                  <div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.changeRate}</p>
                    <p className="text-sm font-bold" style={{
                      color: (summary.change_pct ?? 0) >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)',
                    }}>
                      {summary.change_pct !== null ? `${summary.change_pct >= 0 ? '+' : ''}${summary.change_pct}%` : '-'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Post-broadcast mode: Action Panel + Segment Breakdown */}
            {mode === 'post' && (
              <>
                {actionsLoading ? (
                  <div className="glass-card p-8 text-center">
                    <div className="inline-block w-5 h-5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{LABELS.analyzingActions}</p>
                  </div>
                ) : actions ? (
                  <>
                    {/* Action Panel Header */}
                    <div className="flex items-center gap-2 pt-2">
                      <span className="text-base">{'⚡'}</span>
                      <h3 className="text-sm font-bold" style={{ color: 'rgb(52,211,153)' }}>{LABELS.actionHeader}</h3>
                    </div>

                    {/* 1. First-time Payers */}
                    <div className="rounded-xl p-5 border" style={{ background: 'rgba(249,115,22,0.08)', borderColor: 'rgba(249,115,22,0.25)' }}>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-xs font-bold" style={{ color: 'rgb(251,146,60)' }}>
                          {`🟠 ${LABELS.firstTimePayers} (${actions.first_time_payers.length}${LABELS.personSuffix})`}
                        </h4>
                        {actions.first_time_payers.length > 0 && (
                          <button onClick={() => setToast(LABELS.notImplemented)} className="text-[10px] px-3 py-1.5 rounded-lg font-semibold transition-colors" style={{ background: 'rgba(249,115,22,0.2)', color: 'rgb(251,146,60)' }}>
                            {LABELS.sendTemplate}
                          </button>
                        )}
                      </div>
                      {actions.first_time_payers.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                      ) : (
                        <div className="space-y-1.5">
                          {actions.first_time_payers.map(u => (
                            <div key={u.user_name} className="flex items-center gap-3 px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                              <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }}>{u.user_name}</Link>
                              <span className="text-xs font-bold ml-auto" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.session_tokens)}</span>
                              <span className="text-[10px]" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.session_tokens, COIN_RATE)}</span>
                              {u.dm_sent && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.15)', color: 'rgb(74,222,128)' }}>{`✅${LABELS.dmSentBadge}`}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 2. High Spenders */}
                    <div className="rounded-xl p-5 border" style={{ background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.25)' }}>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-xs font-bold" style={{ color: 'rgb(96,165,250)' }}>
                          {`🔵 ${LABELS.highSpenders} (${actions.high_spenders.length}${LABELS.personSuffix})`}
                        </h4>
                        {actions.high_spenders.length > 0 && (
                          <button onClick={() => setToast(LABELS.notImplemented)} className="text-[10px] px-3 py-1.5 rounded-lg font-semibold transition-colors" style={{ background: 'rgba(59,130,246,0.2)', color: 'rgb(96,165,250)' }}>
                            {LABELS.createDm}
                          </button>
                        )}
                      </div>
                      {actions.high_spenders.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                      ) : (
                        <div className="space-y-1.5">
                          {actions.high_spenders.map(u => (
                            <div key={u.user_name} className="flex items-center gap-3 px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                              <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }}>{u.user_name}</Link>
                              <span className="text-xs font-bold ml-auto" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.session_tokens)}</span>
                              <span className="text-[10px]" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.session_tokens, COIN_RATE)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 3. Visited No Action */}
                    <div className="rounded-xl p-5 border" style={{ background: 'rgba(234,179,8,0.08)', borderColor: 'rgba(234,179,8,0.25)' }}>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-xs font-bold" style={{ color: 'rgb(250,204,21)' }}>
                          {`🟡 ${LABELS.visitedNoAction} (${actions.visited_no_action.length}${LABELS.personSuffix})`}
                        </h4>
                        {actions.visited_no_action.length > 0 && (
                          <button onClick={() => setToast(LABELS.notImplemented)} className="text-[10px] px-3 py-1.5 rounded-lg font-semibold transition-colors" style={{ background: 'rgba(234,179,8,0.2)', color: 'rgb(250,204,21)' }}>
                            {LABELS.followDm}
                          </button>
                        )}
                      </div>
                      {actions.visited_no_action.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {groupBySegmentRange(actions.visited_no_action).map(g => (
                            <span key={g.label} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)' }}>
                              {g.label}: <span className="font-bold" style={{ color: 'rgb(250,204,21)' }}>{g.count}{LABELS.personSuffix}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 4. DM No Visit */}
                    <div className="rounded-xl p-5 border" style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)' }}>
                      <h4 className="text-xs font-bold mb-3" style={{ color: 'rgb(248,113,113)' }}>
                        {`🔴 ${LABELS.dmNoVisit} (${actions.dm_no_visit.length}${LABELS.personSuffix})`}
                      </h4>
                      {actions.dm_no_visit.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                      ) : (
                        <>
                          <div className="flex flex-wrap gap-2 mb-3">
                            {groupBySegmentRange(actions.dm_no_visit).map(g => (
                              <span key={g.label} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)' }}>
                                {g.label}: <span className="font-bold" style={{ color: 'rgb(248,113,113)' }}>{g.count}{LABELS.personSuffix}</span>
                              </span>
                            ))}
                          </div>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.reviewDmTarget}</p>
                        </>
                      )}
                    </div>

                    {/* Segment Breakdown Table */}
                    {actions.segment_breakdown && actions.segment_breakdown.length > 0 && (
                      <div className="glass-card p-5">
                        <h3 className="text-xs font-bold mb-4" style={{ color: 'var(--text-secondary)' }}>{`📊 ${LABELS.segmentBreakdown}`}</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr style={{ color: 'var(--text-muted)' }}>
                                <th className="text-left pb-2 pr-4 font-semibold">{LABELS.segment}</th>
                                <th className="text-right pb-2 px-2 font-semibold">{LABELS.dmSentCol}</th>
                                <th className="text-right pb-2 px-2 font-semibold">{LABELS.visited}</th>
                                <th className="text-right pb-2 px-2 font-semibold">{LABELS.paid}</th>
                                <th className="text-right pb-2 px-2 font-semibold">Visit CVR</th>
                                <th className="text-right pb-2 pl-2 font-semibold">Payment CVR</th>
                              </tr>
                            </thead>
                            <tbody>
                              {actions.segment_breakdown.map(row => {
                                const visitCvr = row.dm_sent > 0 ? (row.visited / row.dm_sent * 100).toFixed(1) : '-';
                                const payCvr = row.visited > 0 ? (row.paid / row.visited * 100).toFixed(1) : '-';
                                return (
                                  <tr key={row.segment} className="border-t" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                                    <td className="py-2 pr-4 font-bold" style={{ color: 'var(--accent-primary)' }}>{row.segment}</td>
                                    <td className="py-2 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{row.dm_sent}</td>
                                    <td className="py-2 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{row.visited}</td>
                                    <td className="py-2 px-2 text-right" style={{ color: 'var(--accent-amber)' }}>{row.paid}</td>
                                    <td className="py-2 px-2 text-right">
                                      <span style={{ color: 'var(--accent-green)' }}>{visitCvr !== '-' ? `${visitCvr}%` : '-'}</span>
                                      {visitCvr !== '-' && (
                                        <button onClick={() => setShowFormula(showFormula === `${row.segment}-visit` ? null : `${row.segment}-visit`)} className="ml-1 opacity-50 hover:opacity-100 transition-opacity" title={LABELS.showFormulaTitle}>{'📐'}</button>
                                      )}
                                      {showFormula === `${row.segment}-visit` && (
                                        <div className="text-[10px] mt-0.5" style={{ color: 'var(--accent-amber)' }}>{`${row.visited}${LABELS.personSuffix} / ${row.dm_sent}${LABELS.personSuffix} = ${visitCvr}%`}</div>
                                      )}
                                    </td>
                                    <td className="py-2 pl-2 text-right">
                                      <span style={{ color: 'var(--accent-purple)' }}>{payCvr !== '-' ? `${payCvr}%` : '-'}</span>
                                      {payCvr !== '-' && (
                                        <button onClick={() => setShowFormula(showFormula === `${row.segment}-pay` ? null : `${row.segment}-pay`)} className="ml-1 opacity-50 hover:opacity-100 transition-opacity" title={LABELS.showFormulaTitle}>{'📐'}</button>
                                      )}
                                      {showFormula === `${row.segment}-pay` && (
                                        <div className="text-[10px] mt-0.5" style={{ color: 'var(--accent-amber)' }}>{`${row.paid}${LABELS.personSuffix} / ${row.visited}${LABELS.personSuffix} = ${payCvr}%`}</div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                              {/* Totals row */}
                              {(() => {
                                const totals = actions.segment_breakdown.reduce(
                                  (acc, r) => ({ dm: acc.dm + r.dm_sent, vis: acc.vis + r.visited, pay: acc.pay + r.paid }),
                                  { dm: 0, vis: 0, pay: 0 }
                                );
                                const totalVisitCvr = totals.dm > 0 ? (totals.vis / totals.dm * 100).toFixed(1) : '-';
                                const totalPayCvr = totals.vis > 0 ? (totals.pay / totals.vis * 100).toFixed(1) : '-';
                                return (
                                  <tr className="border-t-2" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
                                    <td className="py-2 pr-4 font-bold" style={{ color: 'var(--text-primary)' }}>{LABELS.total}</td>
                                    <td className="py-2 px-2 text-right font-bold" style={{ color: 'var(--text-primary)' }}>{totals.dm}</td>
                                    <td className="py-2 px-2 text-right font-bold" style={{ color: 'var(--text-primary)' }}>{totals.vis}</td>
                                    <td className="py-2 px-2 text-right font-bold" style={{ color: 'var(--accent-amber)' }}>{totals.pay}</td>
                                    <td className="py-2 px-2 text-right font-bold" style={{ color: 'var(--accent-green)' }}>{totalVisitCvr !== '-' ? `${totalVisitCvr}%` : '-'}</td>
                                    <td className="py-2 pl-2 text-right font-bold" style={{ color: 'var(--accent-purple)' }}>{totalPayCvr !== '-' ? `${totalPayCvr}%` : '-'}</td>
                                  </tr>
                                );
                              })()}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </div>

      {/* Toast */}
      {toast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl backdrop-blur-xl border shadow-lg anim-fade-up"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-glass)' }}
        >
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{toast}</p>
        </div>
      )}
    </div>
  );
}
