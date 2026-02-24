'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY } from '@/lib/utils';
import Link from 'next/link';

/* ============================================================
   Types
   ============================================================ */
type AnalysisTab = 'overview' | 'sessions' | 'viewers' | 'heatmap' | 'patterns' | 'ai';

interface OverviewSummary {
  total_casts: number;
  total_sessions: number;
  total_tokens: number;
  avg_viewers: number;
}

interface RankingItem {
  [key: string]: string | boolean | number;
  cast_name: string;
  is_own: boolean;
  sessions: number;
  tokens: number;
  viewers: number;
  engagement: number;
  broadcast_hours: number;
  prev_tokens: number;
  prev_viewers: number;
  prev_engagement: number;
  prev_broadcast_hours: number;
}

interface SessionCompare {
  date: string;
  cast_name: string;
  duration_min: number;
  tokens: number;
  peak_viewers: number;
  tk_per_min: number;
  msg_per_min: number;
}

interface TipCluster {
  cluster_start: string;
  total_tokens: number;
  participant_count: number;
  trigger_context: string;
  duration_seconds: number;
}

interface ViewerTrendPoint {
  timestamp: string;
  cast_name: string;
  viewers: number;
}

interface UserOverlap {
  user_name: string;
  visited_casts: string[];
  total_tokens: number;
  main_cast: string;
  loyalty_pct: number;
  capturable: boolean;
}

interface HeatmapCell {
  day_of_week: number;
  hour: number;
  tokens: number;
  sessions: number;
}

interface SuccessSession {
  cast_name: string;
  date: string;
  tokens: number;
  first_tip_seconds: number;
  tip_concentration: number;
  chat_density: number;
  peak_viewers: number;
}

const TAB_CONFIG: { key: AnalysisTab; label: string; icon: string }[] = [
  { key: 'overview', label: '概要比較',       icon: '📊' },
  { key: 'sessions', label: 'セッション分析', icon: '📺' },
  { key: 'viewers',  label: '視聴者分析',     icon: '👥' },
  { key: 'heatmap',  label: 'ヒートマップ',   icon: '🗓' },
  { key: 'patterns', label: '成功パターン',   icon: '🎯' },
  { key: 'ai',       label: 'AI分析',         icon: '🤖' },
];

const PERIOD_OPTIONS = [
  { value: 7,  label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

const METRIC_OPTIONS = [
  { value: 'tokens',      label: 'トークン' },
  { value: 'viewers',     label: '視聴者' },
  { value: 'engagement',  label: 'エンゲージメント' },
  { value: 'duration',    label: '配信時間' },
];

// SVGグラフ用の色パレット
const CHART_COLORS = [
  '#38bdf8', '#22c55e', '#f59e0b', '#a78bfa', '#f43f5e',
  '#06b6d4', '#84cc16', '#f97316', '#8b5cf6', '#ec4899',
];

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

/* ============================================================
   Helper: API fetch with auth
   ============================================================ */
async function apiFetch<T>(
  path: string,
  supabase: ReturnType<typeof createClient>,
  options?: { method?: string; body?: string },
): Promise<T | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return null;

    const res = await fetch(`${API_BASE}${path}`, {
      method: options?.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      ...(options?.body ? { body: options.body } : {}),
    });
    if (!res.ok) {
      // Try to extract error detail from response
      try {
        const errBody = await res.json();
        const detail = errBody?.detail || '';
        if (detail) {
          throw new Error(detail);
        }
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    if (e instanceof Error && e.message) throw e;
    return null;
  }
}

/* ============================================================
   Helper: 数値フォーマット
   ============================================================ */
function fmtNum(n: number): string {
  return n.toLocaleString('ja-JP');
}

function fmtPct(current: number, prev: number): { text: string; color: string } {
  if (prev === 0) return { text: '-', color: 'var(--text-muted)' };
  const pct = ((current - prev) / prev) * 100;
  const sign = pct >= 0 ? '+' : '';
  return {
    text: `${sign}${pct.toFixed(1)}%`,
    color: pct > 0 ? 'var(--accent-green)' : pct < 0 ? 'var(--accent-pink)' : 'var(--text-muted)',
  };
}

/* ============================================================
   Skeleton Loader
   ============================================================ */
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-gray-800 animate-pulse rounded-lg ${className}`} />;
}

function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/* ============================================================
   Error Callout
   ============================================================ */
function ErrorCallout({ message }: { message: string }) {
  return (
    <div className="px-4 py-3 rounded-xl text-[11px] border"
      style={{
        background: 'rgba(244,63,94,0.08)',
        borderColor: 'rgba(244,63,94,0.2)',
        color: 'var(--accent-pink)',
      }}>
      {message}
    </div>
  );
}

/* ============================================================
   Main Page
   ============================================================ */
export default function CompetitiveAnalysisPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<AnalysisTab>('overview');
  const [days, setDays] = useState(30);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
      setLoading(false);
    });
  }, [user]);

  if (!user) return null;

  if (loading) {
    return (
      <div className="h-[calc(100vh-48px)] flex items-center justify-center">
        <div className="glass-card p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-3 overflow-hidden">
      {/* Header */}
      <div className="glass-card px-5 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/spy" className="text-xs hover:text-sky-400 transition-colors" style={{ color: 'var(--text-muted)' }}>
              ← SPY
            </Link>
            <div>
              <h1 className="text-base font-bold flex items-center gap-2">
                📊 競合分析ダッシュボード
                <span className="text-[10px] px-2 py-0.5 rounded"
                  style={{ background: 'rgba(168,85,247,0.1)', color: 'var(--accent-purple)' }}>
                  ANALYSIS
                </span>
              </h1>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                自社 vs 競合キャストの横断比較
              </p>
            </div>
          </div>

          {/* 期間セレクタ */}
          <div className="flex items-center gap-1">
            {PERIOD_OPTIONS.map(p => (
              <button key={p.value} onClick={() => setDays(p.value)}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
                style={{
                  background: days === p.value ? 'rgba(56,189,248,0.12)' : 'transparent',
                  color: days === p.value ? 'var(--accent-primary)' : 'var(--text-muted)',
                  border: days === p.value ? '1px solid rgba(56,189,248,0.2)' : '1px solid transparent',
                }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab navigation */}
        <div className="flex items-center gap-1 mt-3">
          {TAB_CONFIG.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className="px-4 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
              style={{
                background: activeTab === t.key ? 'rgba(56,189,248,0.12)' : 'transparent',
                color: activeTab === t.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                border: activeTab === t.key ? '1px solid rgba(56,189,248,0.2)' : '1px solid transparent',
              }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'overview' && accountId && <OverviewTab accountId={accountId} days={days} />}
        {activeTab === 'sessions' && accountId && <SessionsTab accountId={accountId} days={days} />}
        {activeTab === 'viewers' && accountId && <ViewersTab accountId={accountId} days={days} />}
        {activeTab === 'heatmap' && accountId && <HeatmapTab accountId={accountId} days={days} />}
        {activeTab === 'patterns' && accountId && <PatternsTab accountId={accountId} days={days} />}
        {activeTab === 'ai' && accountId && <AiTab accountId={accountId} days={days} />}
        {!accountId && (
          <div className="glass-card p-8 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>アカウントが見つかりません</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Tab 1: Overview（概要比較）
   ============================================================ */
function OverviewTab({ accountId, days }: { accountId: string; days: number }) {
  const [summary, setSummary] = useState<OverviewSummary | null>(null);
  const [ranking, setRanking] = useState<RankingItem[]>([]);
  const [metric, setMetric] = useState<string>('tokens');
  const [sortKey, setSortKey] = useState<string>('tokens');
  const [sortAsc, setSortAsc] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    Promise.all([
      apiFetch<OverviewSummary>(`/api/competitive/overview?account_id=${accountId}&days=${days}`, supabase),
      apiFetch<RankingItem[]>(`/api/competitive/ranking?account_id=${accountId}&metric=${metric}&days=${days}`, supabase),
    ]).then(([overviewData, rankingData]) => {
      if (overviewData) setSummary(overviewData);
      else setSummary({ total_casts: 0, total_sessions: 0, total_tokens: 0, avg_viewers: 0 });

      setRanking(Array.isArray(rankingData) ? rankingData : []);

      setLoading(false);
    }).catch(() => {
      setError('データの取得に失敗しました。APIサーバーが起動しているか確認してください。');
      setLoading(false);
    });
  }, [accountId, days, metric]);

  const handleSort = useCallback((key: string) => {
    if (sortKey === key) setSortAsc(prev => !prev);
    else { setSortKey(key); setSortAsc(false); }
  }, [sortKey]);

  const sortedRanking = useMemo(() => {
    return [...ranking].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey] as number ?? 0;
      const bv = (b as Record<string, unknown>)[sortKey] as number ?? 0;
      return sortAsc ? av - bv : bv - av;
    });
  }, [ranking, sortKey, sortAsc]);

  const SortHeader = ({ label, field, align = 'right' }: { label: string; field: string; align?: string }) => (
    <th
      className={`py-2 px-2 font-semibold cursor-pointer hover:text-sky-400 transition-colors text-${align}`}
      style={{ color: sortKey === field ? 'var(--accent-primary)' : 'var(--text-muted)' }}
      onClick={() => handleSort(field)}
    >
      {label} {sortKey === field ? (sortAsc ? '↑' : '↓') : ''}
    </th>
  );

  if (error) return <ErrorCallout message={error} />;

  return (
    <div className="space-y-3">
      <p className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>
        登録した他社キャストの配信データを横断比較します
      </p>
      {/* サマリーカード */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="glass-card p-4 text-center">
              <Skeleton className="h-3 w-20 mx-auto mb-2" />
              <Skeleton className="h-8 w-24 mx-auto" />
            </div>
          ))
        ) : (
          [
            { label: '全キャスト数', value: fmtNum(summary?.total_casts ?? 0), color: 'var(--text-primary)' },
            { label: '総セッション', value: fmtNum(summary?.total_sessions ?? 0), color: 'var(--accent-primary)' },
            { label: '総トークン',   value: fmtNum(summary?.total_tokens ?? 0) + ' tk', color: 'var(--accent-amber)' },
            { label: '平均視聴者',   value: fmtNum(Math.round(summary?.avg_viewers ?? 0)), color: 'var(--accent-purple)' },
          ].map(card => (
            <div key={card.label} className="glass-card p-4 text-center">
              <p className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>{card.label}</p>
              <p className="text-2xl font-bold mt-1 tabular-nums" style={{ color: card.color }}>{card.value}</p>
            </div>
          ))
        )}
      </div>

      {/* 指標切替ボタン */}
      <div className="flex items-center gap-1">
        {METRIC_OPTIONS.map(m => (
          <button key={m.value} onClick={() => setMetric(m.value)}
            className="px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all"
            style={{
              background: metric === m.value ? 'rgba(56,189,248,0.12)' : 'transparent',
              color: metric === m.value ? 'var(--accent-primary)' : 'var(--text-muted)',
              border: metric === m.value ? '1px solid rgba(56,189,248,0.2)' : '1px solid transparent',
            }}>
            {m.label}
          </button>
        ))}
      </div>

      {/* ランキングテーブル */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">キャストランキング</h3>
        {loading ? <SkeletonTable rows={8} /> : (
          <div className="overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>#</th>
                  <SortHeader label="キャスト名" field="cast_name" align="left" />
                  <th className="py-2 px-2 font-semibold text-center" style={{ color: 'var(--text-muted)' }}>区分</th>
                  <SortHeader label="セッション" field="sessions" />
                  <SortHeader label="トークン" field="tokens" />
                  <SortHeader label="視聴者" field="viewers" />
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>前期比</th>
                </tr>
              </thead>
              <tbody>
                {sortedRanking.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                      データ不足 - SPYキャストを登録して配信データを蓄積してください。SPY画面からキャストを追加できます。
                    </td>
                  </tr>
                ) : (
                  sortedRanking.map((r, i) => {
                    const change = fmtPct(r.tokens, r.prev_tokens);
                    return (
                      <tr key={r.cast_name}
                        className="border-b transition-colors"
                        style={{
                          borderColor: 'rgba(56,189,248,0.05)',
                          background: r.is_own ? 'rgba(56,189,248,0.06)' : 'transparent',
                          borderLeft: r.is_own ? '2px solid var(--accent-primary)' : '2px solid transparent',
                        }}
                        onMouseEnter={e => { if (!r.is_own) e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = r.is_own ? 'rgba(56,189,248,0.06)' : 'transparent'; }}
                      >
                        <td className="py-2.5 px-2 font-bold" style={{
                          color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)',
                        }}>{i + 1}</td>
                        <td className="py-2.5 px-2">
                          <Link href={`/spy/${encodeURIComponent(r.cast_name)}`}
                            className="font-semibold hover:text-sky-400 transition-colors">
                            {r.cast_name}
                          </Link>
                        </td>
                        <td className="py-2.5 px-2 text-center">
                          {r.is_own ? (
                            <span className="text-[9px] px-1.5 py-0.5 rounded"
                              style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--accent-amber)' }}>
                              自社
                            </span>
                          ) : (
                            <span className="text-[9px] px-1.5 py-0.5 rounded"
                              style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                              SPY
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums">{fmtNum(r.sessions)}</td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>
                          {formatTokens(r.tokens)} <span className="text-[9px] font-normal" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(r.tokens)})</span>
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums">{fmtNum(r.viewers)}</td>
                        <td className="py-2.5 px-2 text-right tabular-nums text-[10px] font-semibold" style={{ color: change.color }}>
                          {change.text}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Tab 2: Sessions（セッション分析）
   ============================================================ */
function SessionsTab({ accountId, days }: { accountId: string; days: number }) {
  const [castOptions, setCastOptions] = useState<string[]>([]);
  const [selectedCasts, setSelectedCasts] = useState<Set<string>>(new Set());
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionCompare[]>([]);
  const [tipClusters, setTipClusters] = useState<TipCluster[]>([]);
  const [clusterCast, setClusterCast] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // キャスト一覧を取得（spy_casts + registered_casts）
  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from('spy_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
      supabase.from('registered_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
    ]).then(([spyRes, regRes]) => {
      const names = new Set<string>();
      spyRes.data?.forEach(c => names.add(c.cast_name));
      regRes.data?.forEach(c => names.add(c.cast_name));
      const arr = Array.from(names).sort();
      setCastOptions(arr);
      // デフォルトで全選択
      setSelectedCasts(new Set(arr));
      if (arr.length > 0) setClusterCast(arr[0]);
    });
  }, [accountId]);

  // セッションデータ取得
  useEffect(() => {
    if (selectedCasts.size === 0) { setSessions([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const castParam = Array.from(selectedCasts).join(',');

    apiFetch<SessionCompare[]>(
      `/api/competitive/sessions?account_id=${accountId}&cast_names=${encodeURIComponent(castParam)}&days=${days}`,
      supabase
    ).then(data => {
      setSessions(Array.isArray(data) ? data : []);
      setLoading(false);
    }).catch(() => {
      setError('セッションデータの取得に失敗しました');
      setLoading(false);
    });
  }, [accountId, days, selectedCasts]);

  // チップクラスタ取得
  useEffect(() => {
    if (!clusterCast) { setTipClusters([]); return; }
    const supabase = createClient();
    apiFetch<TipCluster[]>(
      `/api/competitive/tip-clusters?account_id=${accountId}&cast_name=${encodeURIComponent(clusterCast)}&days=${days}`,
      supabase
    ).then(data => {
      setTipClusters(Array.isArray(data) ? data : []);
    });
  }, [accountId, days, clusterCast]);

  const toggleCast = useCallback((name: string) => {
    setSelectedCasts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedCasts(prev => {
      if (prev.size === castOptions.length) return new Set();
      return new Set(castOptions);
    });
  }, [castOptions]);

  // チップクラスタの最大値（バー幅計算用）
  const maxClusterTokens = useMemo(() => {
    return Math.max(...tipClusters.map(c => c.total_tokens), 1);
  }, [tipClusters]);

  if (error) return <ErrorCallout message={error} />;

  return (
    <div className="space-y-3">
      <p className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>
        各キャストの配信1回ごとの売上推移を時系列で把握します
      </p>
      {/* キャスト選択ドロップダウン */}
      <div className="glass-card p-4 relative" style={{ zIndex: 20 }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold">キャスト選択</h3>
          <div className="relative" style={{ zIndex: 30 }}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all border"
              style={{
                background: 'rgba(56,189,248,0.08)',
                borderColor: 'rgba(56,189,248,0.2)',
                color: 'var(--accent-primary)',
              }}>
              {selectedCasts.size}/{castOptions.length} 選択中 ▾
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1 glass-card p-3 min-w-[200px] max-h-64 overflow-auto"
                style={{ background: 'rgba(15, 23, 42, 0.95)', zIndex: 50 }}>
                <button onClick={toggleAll}
                  className="w-full text-left text-[10px] px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors mb-1 font-semibold"
                  style={{ color: 'var(--accent-primary)' }}>
                  {selectedCasts.size === castOptions.length ? '全解除' : '全選択'}
                </button>
                <div className="border-t my-1" style={{ borderColor: 'var(--border-glass)' }} />
                {castOptions.map(name => (
                  <label key={name}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 cursor-pointer transition-colors">
                    <input type="checkbox" checked={selectedCasts.has(name)}
                      onChange={() => toggleCast(name)}
                      className="rounded border-gray-600 bg-gray-800 text-sky-500 focus:ring-sky-500/30" />
                    <span className="text-[11px] truncate">{name}</span>
                  </label>
                ))}
                <div className="border-t mt-2 pt-2" style={{ borderColor: 'var(--border-glass)' }}>
                  <button onClick={() => setDropdownOpen(false)}
                    className="w-full text-center text-[10px] py-1 rounded-lg hover:bg-white/5"
                    style={{ color: 'var(--text-muted)' }}>
                    閉じる
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* セッション比較テーブル */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">📺 セッション比較</h3>
        {loading ? <SkeletonTable rows={8} /> : sessions.length === 0 ? (
          <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>
            データ不足 - 選択中のキャストにセッション記録がありません。配信が記録されるとここに表示されます。
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>日付</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>キャスト</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>時間(分)</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>トークン</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>ピーク視聴者</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>tk/分</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>msg/分</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s, i) => (
                  <tr key={`${s.date}-${s.cast_name}-${i}`}
                    className="border-b hover:bg-white/[0.02] transition-colors"
                    style={{ borderColor: 'rgba(56,189,248,0.05)' }}>
                    <td className="py-2.5 px-2 font-medium">{s.date}</td>
                    <td className="py-2.5 px-2">
                      <Link href={`/spy/${encodeURIComponent(s.cast_name)}`}
                        className="hover:text-sky-400 transition-colors font-semibold">
                        {s.cast_name}
                      </Link>
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      {fmtNum(s.duration_min)}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>
                      {formatTokens(s.tokens)} <span className="text-[9px] font-normal" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(s.tokens)})</span>
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums" style={{ color: 'var(--accent-purple)' }}>
                      {fmtNum(s.peak_viewers)}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums" style={{ color: 'var(--accent-primary)' }}>
                      {s.tk_per_min.toFixed(1)}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      {s.msg_per_min.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* チップ集中タイミング */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-bold">チップ集中タイミング</h3>
          <select
            value={clusterCast}
            onChange={e => setClusterCast(e.target.value)}
            className="text-[11px] px-3 py-1.5 rounded-lg border outline-none"
            style={{
              background: 'rgba(15, 23, 42, 0.5)',
              borderColor: 'var(--border-glass)',
              color: 'var(--text-primary)',
            }}>
            {castOptions.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
          チップが短時間に集中した区間を自動検出。盛り上がりのきっかけを分析します
        </p>

        {/* 色凡例 */}
        <div className="flex items-center gap-3 mb-3 text-[9px]">
          <div className="flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ background: '#f43f5e' }} />
            <span style={{ color: 'var(--text-muted)' }}>20,000tk+</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ background: '#f59e0b' }} />
            <span style={{ color: 'var(--text-muted)' }}>5,000-20,000tk</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ background: '#22c55e' }} />
            <span style={{ color: 'var(--text-muted)' }}>~5,000tk</span>
          </div>
        </div>

        {tipClusters.length === 0 ? (
          <p className="text-center text-[11px] py-6" style={{ color: 'var(--text-muted)' }}>
            データ不足 - チップ集中データがありません。チップ記録が蓄積されると自動検出されます。
          </p>
        ) : (
          <div className="space-y-3">
            {tipClusters.map((cluster, i) => {
              const barWidth = Math.max((cluster.total_tokens / maxClusterTokens) * 100, 5);
              // 色: 絶対値ベースの閾値で色分け
              const barColor = cluster.total_tokens >= 20000 ? '#f43f5e' : cluster.total_tokens >= 5000 ? '#f59e0b' : '#22c55e';

              return (
                <div key={i} className="glass-panel p-3">
                  {/* タイムラインバー */}
                  <div className="mb-2">
                    <div className="w-full h-6 rounded-lg overflow-hidden" style={{ background: 'rgba(15,23,42,0.5)' }}>
                      <div className="h-full rounded-lg flex items-center px-2 transition-all duration-500"
                        style={{ width: `${barWidth}%`, background: `${barColor}30`, borderLeft: `3px solid ${barColor}` }}>
                        <span className="text-[9px] font-bold tabular-nums whitespace-nowrap" style={{ color: barColor }}>
                          {fmtNum(cluster.total_tokens)} tk
                        </span>
                      </div>
                    </div>
                  </div>
                  {/* クラスタ詳細 */}
                  <div className="flex items-center gap-4 text-[10px]">
                    <span style={{ color: 'var(--text-muted)' }}>
                      開始: <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {new Date(cluster.cluster_start).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      合計: <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                        {formatTokens(cluster.total_tokens)} <span className="text-[9px] font-normal" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(cluster.total_tokens)})</span>
                      </span>
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      チッパー数: <span className="font-medium" style={{ color: 'var(--accent-purple)' }}>
                        {cluster.participant_count}名
                      </span>
                    </span>
                    <span className="truncate" style={{ color: 'var(--text-muted)' }}>
                      きっかけ: <span style={{ color: 'var(--text-secondary)' }}>{cluster.trigger_context || '-'}</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Tab 3: Viewers（視聴者分析）
   ============================================================ */
function ViewersTab({ accountId, days }: { accountId: string; days: number }) {
  const [castOptions, setCastOptions] = useState<string[]>([]);
  const [selectedCasts, setSelectedCasts] = useState<Set<string>>(new Set());
  const [trends, setTrends] = useState<ViewerTrendPoint[]>([]);
  const [overlap, setOverlap] = useState<UserOverlap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // キャスト一覧取得
  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from('spy_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
      supabase.from('registered_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
    ]).then(([spyRes, regRes]) => {
      const names = new Set<string>();
      spyRes.data?.forEach(c => names.add(c.cast_name));
      regRes.data?.forEach(c => names.add(c.cast_name));
      const arr = Array.from(names).sort();
      setCastOptions(arr);
      setSelectedCasts(new Set(arr.slice(0, 5))); // 最大5件選択
    });
  }, [accountId]);

  // データ取得
  useEffect(() => {
    if (selectedCasts.size === 0) { setTrends([]); setOverlap([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const castParam = Array.from(selectedCasts).join(',');

    Promise.all([
      apiFetch<ViewerTrendPoint[]>(
        `/api/competitive/viewer-trends?account_id=${accountId}&cast_names=${encodeURIComponent(castParam)}&days=${days}`,
        supabase
      ),
      apiFetch<UserOverlap[]>(
        `/api/competitive/user-overlap?account_id=${accountId}&days=${days}&cast_names=${encodeURIComponent(castParam)}`,
        supabase
      ),
    ]).then(([trendData, overlapData]) => {
      setTrends(Array.isArray(trendData) ? trendData : []);
      // Filter overlap to only include users who visited at least one of the selected casts
      const selectedSet = new Set(selectedCasts);
      const filtered = (Array.isArray(overlapData) ? overlapData : []).filter(u =>
        (u.visited_casts || []).some(c => selectedSet.has(c))
      );
      setOverlap(filtered);
      setLoading(false);
    }).catch(() => {
      setError('視聴者データの取得に失敗しました');
      setLoading(false);
    });
  }, [accountId, days, selectedCasts]);

  // SVGグラフ用データ加工
  const chartData = useMemo(() => {
    if (!Array.isArray(trends) || trends.length === 0) return null;

    const castMap = new Map<string, { timestamp: number; viewers: number }[]>();
    trends.forEach(p => {
      const arr = castMap.get(p.cast_name) || [];
      arr.push({ timestamp: new Date(p.timestamp).getTime(), viewers: p.viewers });
      castMap.set(p.cast_name, arr);
    });

    // ソート
    castMap.forEach(arr => arr.sort((a, b) => a.timestamp - b.timestamp));

    let minTime = Infinity, maxTime = -Infinity, maxViewers = 0;
    castMap.forEach(arr => {
      arr.forEach(p => {
        if (p.timestamp < minTime) minTime = p.timestamp;
        if (p.timestamp > maxTime) maxTime = p.timestamp;
        if (p.viewers > maxViewers) maxViewers = p.viewers;
      });
    });

    if (minTime === maxTime) maxTime = minTime + 1;
    if (maxViewers === 0) maxViewers = 1;

    const width = 800;
    const height = 300;
    const padding = { top: 20, right: 20, bottom: 40, left: 50 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const scaleX = (t: number) => padding.left + ((t - minTime) / (maxTime - minTime)) * plotW;
    const scaleY = (v: number) => padding.top + plotH - (v / maxViewers) * plotH;

    const castNames = Array.from(castMap.keys());
    const paths = castNames.map((name, idx) => {
      const points = castMap.get(name)!;
      const d = points.map((p, i) =>
        `${i === 0 ? 'M' : 'L'} ${scaleX(p.timestamp).toFixed(1)} ${scaleY(p.viewers).toFixed(1)}`
      ).join(' ');
      return { name, d, color: CHART_COLORS[idx % CHART_COLORS.length] };
    });

    // Y軸目盛り (5段階)
    const yTicks = Array.from({ length: 5 }, (_, i) => {
      const v = Math.round((maxViewers / 4) * i);
      return { value: v, y: scaleY(v) };
    });

    // X軸目盛り (5個)
    const timeRange = maxTime - minTime;
    const xTicks = Array.from({ length: 5 }, (_, i) => {
      const t = minTime + (timeRange / 4) * i;
      const date = new Date(t);
      return {
        label: `${(date.getMonth() + 1)}/${date.getDate()}`,
        x: scaleX(t),
      };
    });

    return { width, height, padding, paths, yTicks, xTicks };
  }, [trends]);

  const toggleCast = useCallback((name: string) => {
    setSelectedCasts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  if (error) return <ErrorCallout message={error} />;

  return (
    <div className="space-y-3">
      <p className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>
        どのユーザーが複数キャストの配信に来ているか分析します
      </p>
      {/* キャスト選択 */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-2">キャスト選択 (グラフ表示用)</h3>
        <div className="flex flex-wrap gap-1.5">
          {castOptions.map((name, idx) => {
            const isOn = selectedCasts.has(name);
            const color = CHART_COLORS[idx % CHART_COLORS.length];
            return (
              <button key={name} onClick={() => toggleCast(name)}
                className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
                style={{
                  background: isOn ? `${color}15` : 'transparent',
                  color: isOn ? color : 'var(--text-muted)',
                  border: `1px solid ${isOn ? `${color}40` : 'transparent'}`,
                  opacity: isOn ? 1 : 0.5,
                }}>
                {name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 視聴者推移グラフ (SVG) */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">視聴者推移</h3>
        {loading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : !chartData || chartData.paths.length === 0 ? (
          <div className="h-[300px] flex items-center justify-center">
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>データ不足 - 視聴者推移データがありません。viewer_stats の記録が蓄積されると表示されます。</p>
          </div>
        ) : (
          <div className="w-full overflow-x-auto">
            <svg viewBox={`0 0 ${chartData.width} ${chartData.height}`} className="w-full min-w-[600px]"
              style={{ maxHeight: '350px' }}>
              {/* グリッド線 */}
              {chartData.yTicks.map((tick, i) => (
                <g key={`y-${i}`}>
                  <line
                    x1={chartData.padding.left} y1={tick.y}
                    x2={chartData.width - chartData.padding.right} y2={tick.y}
                    stroke="rgba(56,189,248,0.06)" strokeWidth="1"
                  />
                  <text x={chartData.padding.left - 8} y={tick.y + 4}
                    textAnchor="end" fill="#475569" fontSize="10" fontFamily="JetBrains Mono">
                    {fmtNum(tick.value)}
                  </text>
                </g>
              ))}

              {/* X軸目盛り */}
              {chartData.xTicks.map((tick, i) => (
                <text key={`x-${i}`} x={tick.x} y={chartData.height - 10}
                  textAnchor="middle" fill="#475569" fontSize="10" fontFamily="JetBrains Mono">
                  {tick.label}
                </text>
              ))}

              {/* 軸 */}
              <line
                x1={chartData.padding.left} y1={chartData.padding.top}
                x2={chartData.padding.left} y2={chartData.height - chartData.padding.bottom}
                stroke="rgba(56,189,248,0.15)" strokeWidth="1"
              />
              <line
                x1={chartData.padding.left} y1={chartData.height - chartData.padding.bottom}
                x2={chartData.width - chartData.padding.right} y2={chartData.height - chartData.padding.bottom}
                stroke="rgba(56,189,248,0.15)" strokeWidth="1"
              />

              {/* 折れ線 */}
              {chartData.paths.map(p => (
                <path key={p.name} d={p.d} fill="none" stroke={p.color} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
              ))}
            </svg>

            {/* 凡例 */}
            <div className="flex flex-wrap gap-3 mt-2 pl-[50px]">
              {chartData.paths.map(p => (
                <div key={p.name} className="flex items-center gap-1.5">
                  <div className="w-3 h-0.5 rounded-full" style={{ background: p.color }} />
                  <span className="text-[10px]" style={{ color: p.color }}>{p.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ユーザー重複テーブル */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">👥 ユーザー重複分析</h3>
        {loading ? <SkeletonTable rows={6} /> : overlap.length === 0 ? (
          <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>
            データ不足 - 複数キャストに訪問しているユーザーがいません。複数キャストのSPYデータが蓄積されると分析されます。
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>ユーザー名</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>訪問キャスト</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>合計tk</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>メイン先</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>忠誠度</th>
                  <th className="text-center py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>奪取可能</th>
                </tr>
              </thead>
              <tbody>
                {overlap.map(u => (
                  <tr key={u.user_name}
                    className="border-b hover:bg-white/[0.02] transition-colors"
                    style={{ borderColor: 'rgba(56,189,248,0.05)' }}>
                    <td className="py-2.5 px-2">
                      <Link href={`/spy/users/${encodeURIComponent(u.user_name)}`}
                        className="font-semibold hover:text-sky-400 transition-colors">
                        {u.user_name}
                      </Link>
                    </td>
                    <td className="py-2.5 px-2">
                      <div className="flex flex-wrap gap-1">
                        {(u.visited_casts || []).map(c => (
                          <span key={c} className="text-[9px] px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--text-secondary)' }}>
                            {c}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>
                      {formatTokens(u.total_tokens)} <span className="text-[9px] font-normal" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(u.total_tokens)})</span>
                    </td>
                    <td className="py-2.5 px-2 font-medium" style={{ color: 'var(--text-secondary)' }}>
                      {u.main_cast}
                    </td>
                    <td className="py-2.5 px-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="w-16 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                          <div className="h-full rounded-full transition-all"
                            style={{
                              width: `${u.loyalty_pct}%`,
                              background: u.loyalty_pct > 70 ? 'var(--accent-green)' :
                                u.loyalty_pct > 40 ? 'var(--accent-amber)' : 'var(--accent-pink)',
                            }} />
                        </div>
                        <span className="tabular-nums text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                          {u.loyalty_pct}%
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-center">
                      {u.capturable ? (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                          style={{ background: 'rgba(34,197,94,0.12)', color: 'var(--accent-green)' }}>
                          可能
                        </span>
                      ) : (
                        <span className="text-[9px] px-1.5 py-0.5 rounded"
                          style={{ background: 'rgba(100,116,139,0.1)', color: 'var(--text-muted)' }}>
                          困難
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Tab 4: Heatmap（ヒートマップ）
   ============================================================ */
function HeatmapTab({ accountId, days }: { accountId: string; days: number }) {
  const [castOptions, setCastOptions] = useState<string[]>([]);
  const [selectedCasts, setSelectedCasts] = useState<Set<string>>(new Set());
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // キャスト一覧
  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from('spy_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
      supabase.from('registered_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
    ]).then(([spyRes, regRes]) => {
      const names = new Set<string>();
      spyRes.data?.forEach(c => names.add(c.cast_name));
      regRes.data?.forEach(c => names.add(c.cast_name));
      const arr = Array.from(names).sort();
      setCastOptions(arr);
      setSelectedCasts(new Set(arr));
    });
  }, [accountId]);

  // データ取得
  useEffect(() => {
    if (selectedCasts.size === 0) { setHeatmap([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const castParam = Array.from(selectedCasts).join(',');

    apiFetch<HeatmapCell[]>(
      `/api/competitive/heatmap?account_id=${accountId}&cast_names=${encodeURIComponent(castParam)}&days=${days}`,
      supabase
    ).then(data => {
      setHeatmap(Array.isArray(data) ? data : []);
      setLoading(false);
    }).catch(() => {
      setError('ヒートマップデータの取得に失敗しました');
      setLoading(false);
    });
  }, [accountId, days, selectedCasts]);

  // ヒートマップのデータ加工
  const heatmapData = useMemo(() => {
    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let maxTokens = 0;
    if (!Array.isArray(heatmap)) return { grid, maxTokens: 1 };

    heatmap.forEach(cell => {
      if (cell.day_of_week >= 0 && cell.day_of_week < 7 && cell.hour >= 0 && cell.hour < 24) {
        grid[cell.day_of_week][cell.hour] += cell.tokens;
        if (grid[cell.day_of_week][cell.hour] > maxTokens) {
          maxTokens = grid[cell.day_of_week][cell.hour];
        }
      }
    });

    return { grid, maxTokens: maxTokens || 1 };
  }, [heatmap]);

  const dayLabels = ['月', '火', '水', '木', '金', '土', '日'];

  const getHeatColor = (value: number, max: number): string => {
    if (value === 0) return 'rgba(15,23,42,0.3)';
    const intensity = value / max;
    if (intensity < 0.25) return 'rgba(34,197,94,0.2)';
    if (intensity < 0.5)  return 'rgba(34,197,94,0.45)';
    if (intensity < 0.75) return 'rgba(245,158,11,0.5)';
    return 'rgba(244,63,94,0.6)';
  };

  const toggleCast = useCallback((name: string) => {
    setSelectedCasts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  if (error) return <ErrorCallout message={error} />;

  return (
    <div className="space-y-3">
      <p className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>
        曜日x時間帯ごとの売上を可視化。稼げる時間帯を特定します
      </p>
      {/* キャスト選択 */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-2">対象キャスト</h3>
        <div className="flex flex-wrap gap-1.5">
          {castOptions.map(name => {
            const isOn = selectedCasts.has(name);
            return (
              <button key={name} onClick={() => toggleCast(name)}
                className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
                style={{
                  background: isOn ? 'rgba(56,189,248,0.12)' : 'transparent',
                  color: isOn ? 'var(--accent-primary)' : 'var(--text-muted)',
                  border: `1px solid ${isOn ? 'rgba(56,189,248,0.2)' : 'transparent'}`,
                  opacity: isOn ? 1 : 0.5,
                }}>
                {name}
              </button>
            );
          })}
        </div>
      </div>

      {/* ヒートマップ */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">配信時間 x トークン ヒートマップ</h3>
        {loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : heatmap.length === 0 ? (
          <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>
            データ不足 - ヒートマップに表示するデータがありません。SPYログが蓄積されると時間帯別に可視化されます。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[700px]">
              {/* 時間ヘッダー */}
              <div className="flex items-center mb-1">
                <div className="w-8 flex-shrink-0" />
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="flex-1 text-center text-[8px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {h}
                  </div>
                ))}
              </div>

              {/* グリッド */}
              {dayLabels.map((day, dayIdx) => (
                <div key={day} className="flex items-center gap-0.5 mb-0.5">
                  <div className="w-8 flex-shrink-0 text-[10px] font-semibold text-right pr-2"
                    style={{ color: dayIdx >= 5 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                    {day}
                  </div>
                  {Array.from({ length: 24 }, (_, h) => {
                    const value = heatmapData.grid[dayIdx][h];
                    return (
                      <div key={h}
                        className="flex-1 aspect-square rounded-sm cursor-default transition-all hover:ring-1 hover:ring-white/20"
                        style={{ background: getHeatColor(value, heatmapData.maxTokens), minHeight: '16px' }}
                        title={`${day}曜 ${h}:00 - ${fmtNum(value)} tk`}
                      />
                    );
                  })}
                </div>
              ))}

              {/* 凡例 */}
              <div className="flex items-center gap-2 mt-3 pl-8">
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>低</span>
                <div className="flex gap-0.5">
                  {['rgba(15,23,42,0.3)', 'rgba(34,197,94,0.2)', 'rgba(34,197,94,0.45)', 'rgba(245,158,11,0.5)', 'rgba(244,63,94,0.6)'].map((bg, i) => (
                    <div key={i} className="w-4 h-3 rounded-sm" style={{ background: bg }} />
                  ))}
                </div>
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>高</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


/* ============================================================
   Tab 5: Patterns（成功パターン）
   ============================================================ */
function PatternsTab({ accountId, days }: { accountId: string; days: number }) {
  const [castOptions, setCastOptions] = useState<string[]>([]);
  const [selectedCasts, setSelectedCasts] = useState<Set<string>>(new Set());
  const [successSessions, setSuccessSessions] = useState<SuccessSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // キャスト一覧取得
  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from('spy_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
      supabase.from('registered_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
    ]).then(([spyRes, regRes]) => {
      const names = new Set<string>();
      spyRes.data?.forEach(c => names.add(c.cast_name));
      regRes.data?.forEach(c => names.add(c.cast_name));
      const arr = Array.from(names).sort();
      setCastOptions(arr);
      setSelectedCasts(new Set(arr));
    });
  }, [accountId]);

  useEffect(() => {
    if (selectedCasts.size === 0) { setSuccessSessions([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const castParam = Array.from(selectedCasts).join(',');

    apiFetch<SuccessSession[]>(
      `/api/competitive/success-patterns?account_id=${accountId}&min_tokens=10000&cast_names=${encodeURIComponent(castParam)}`,
      supabase
    ).then(data => {
      setSuccessSessions(Array.isArray(data) ? data : []);
      setLoading(false);
    }).catch(() => {
      setError('成功パターンデータの取得に失敗しました');
      setLoading(false);
    });
  }, [accountId, days, selectedCasts]);

  const toggleCast = useCallback((name: string) => {
    setSelectedCasts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  if (error) return <ErrorCallout message={error} />;

  return (
    <div className="space-y-3">
      <p className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>
        売上上位の配信に共通する特徴を分析します
      </p>
      {/* キャスト選択 */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-2">対象キャスト</h3>
        <div className="flex flex-wrap gap-1.5">
          {castOptions.map(name => {
            const isOn = selectedCasts.has(name);
            return (
              <button key={name} onClick={() => toggleCast(name)}
                className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
                style={{
                  background: isOn ? 'rgba(56,189,248,0.12)' : 'transparent',
                  color: isOn ? 'var(--accent-primary)' : 'var(--text-muted)',
                  border: `1px solid ${isOn ? 'rgba(56,189,248,0.2)' : 'transparent'}`,
                  opacity: isOn ? 1 : 0.5,
                }}>
                {name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 成功セッション一覧 */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">高収益セッション (10,000tk+)</h3>
        {loading ? <SkeletonTable rows={4} /> : successSessions.length === 0 ? (
          <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>
            データ不足 - 10,000tk以上の高収益セッションがまだ記録されていません。配信データが蓄積されると自動的に分析されます。
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {successSessions.map((s, i) => (
              <div key={`${s.cast_name}-${s.date}-${i}`}
                className="glass-panel p-4 hover:border-sky-500/20 transition-all">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <Link href={`/spy/${encodeURIComponent(s.cast_name)}`}
                      className="text-[11px] font-bold hover:text-sky-400 transition-colors">
                      {s.cast_name}
                    </Link>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{s.date}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                      {formatTokens(s.tokens)}
                    </p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(s.tokens)}</p>
                    <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                      ピーク視聴者: {fmtNum(s.peak_viewers)}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="text-center">
                    <p className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>初tipまで</p>
                    <p className="text-[11px] font-bold tabular-nums" style={{ color: 'var(--accent-primary)' }}>
                      {s.first_tip_seconds > 0 ? `${Math.round(s.first_tip_seconds / 60)}分` : '-'}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>tip集中度</p>
                    <p className="text-[11px] font-bold tabular-nums" style={{
                      color: s.tip_concentration > 0.7 ? 'var(--accent-pink)' :
                        s.tip_concentration > 0.4 ? 'var(--accent-amber)' : 'var(--accent-green)',
                    }}>
                      {(s.tip_concentration * 100).toFixed(0)}%
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>チャット密度</p>
                    <p className="text-[11px] font-bold tabular-nums" style={{ color: 'var(--accent-purple)' }}>
                      {s.chat_density.toFixed(1)} msg/分
                    </p>
                  </div>
                </div>

                {/* 収益バー */}
                <div className="mt-2">
                  <div className="w-full h-1 rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min((s.tokens / 50000) * 100, 100)}%`,
                        background: 'linear-gradient(90deg, var(--accent-amber), var(--accent-pink))',
                      }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


/* ============================================================
   Tab 6: AI Analysis（AI分析）
   ============================================================ */
function AiTab({ accountId, days }: { accountId: string; days: number }) {
  const [castOptions, setCastOptions] = useState<string[]>([]);
  const [aiCast, setAiCast] = useState<string>('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // キャスト一覧
  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from('spy_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
      supabase.from('registered_casts').select('cast_name').eq('account_id', accountId).eq('is_active', true),
    ]).then(([spyRes, regRes]) => {
      const names = new Set<string>();
      spyRes.data?.forEach(c => names.add(c.cast_name));
      regRes.data?.forEach(c => names.add(c.cast_name));
      setCastOptions(Array.from(names).sort());
    });
  }, [accountId]);

  return (
    <div className="space-y-3">
      <p className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>
        Claude AIによる配信データの総合分析レポートを生成します
      </p>
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold">AI分析</h3>
          <div className="flex items-center gap-2">
            <select
              value={aiCast}
              onChange={e => { setAiCast(e.target.value); setAiReport(null); setAiError(null); }}
              className="text-[11px] px-3 py-1.5 rounded-lg border outline-none"
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">キャストを選択</option>
              {castOptions.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <button
              disabled={!aiCast || aiLoading}
              onClick={async () => {
                if (!aiCast) return;
                setAiLoading(true);
                setAiError(null);
                setAiReport(null);
                try {
                  const supabase = createClient();
                  const result = await apiFetch<{ text: string; tokens_used: number; cost_usd: number }>(
                    `/api/competitive/analyze`,
                    supabase,
                    {
                      method: 'POST',
                      body: JSON.stringify({ account_id: accountId, cast_name: aiCast, analysis_type: 'overview' }),
                    }
                  );
                  if (result?.text) setAiReport(result.text);
                  else setAiError('分析結果を取得できませんでした');
                } catch (e) {
                  const msg = e instanceof Error ? e.message : 'AI分析の実行に失敗しました。APIサーバーを確認してください。';
                  setAiError(msg);
                } finally {
                  setAiLoading(false);
                }
              }}
              className="px-4 py-1.5 rounded-lg text-[11px] font-bold transition-all"
              style={{
                background: aiCast && !aiLoading ? 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(56,189,248,0.3))' : 'rgba(100,116,139,0.1)',
                color: aiCast && !aiLoading ? 'var(--accent-purple)' : 'var(--text-muted)',
                border: '1px solid',
                borderColor: aiCast && !aiLoading ? 'rgba(168,85,247,0.3)' : 'transparent',
                cursor: aiCast && !aiLoading ? 'pointer' : 'not-allowed',
              }}>
              {aiLoading ? '分析中...' : 'AI分析を実行'}
            </button>
          </div>
        </div>

        {aiError && <ErrorCallout message={aiError} />}

        {aiLoading && (
          <div className="py-8 text-center">
            <div className="inline-block w-6 h-6 border-2 rounded-full animate-spin mb-2"
              style={{ borderColor: 'var(--accent-purple)', borderTopColor: 'transparent' }} />
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Claude Sonnet が分析中...（10-20秒）
            </p>
          </div>
        )}

        {aiReport && (
          <div className="prose prose-invert prose-sm max-w-none text-[12px] leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}>
            {aiReport.split('\n').map((line, i) => {
              if (line.startsWith('## ')) {
                return <h3 key={i} className="text-[13px] font-bold mt-4 mb-1" style={{ color: 'var(--text-primary)' }}>{line.replace('## ', '')}</h3>;
              }
              if (line.startsWith('- ')) {
                return <p key={i} className="ml-3 mb-0.5">{line}</p>;
              }
              if (line.trim() === '') return <br key={i} />;
              return <p key={i} className="mb-1">{line}</p>;
            })}
          </div>
        )}

        {!aiCast && !aiReport && !aiLoading && (
          <p className="text-center text-[11px] py-6" style={{ color: 'var(--text-muted)' }}>
            キャストを選択して「AI分析を実行」をクリックすると、蓄積データからAI分析レポートを生成します
          </p>
        )}
      </div>
    </div>
  );
}
