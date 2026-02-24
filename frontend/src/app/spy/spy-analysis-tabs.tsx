'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY } from '@/lib/utils';
import Link from 'next/link';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

/* ============================================================
   Types
   ============================================================ */
type AnalysisSubTab = 'schedule' | 'payment' | 'growth' | 'market';

interface SchedulePattern {
  cast_name: string;
  day_of_week: number;
  hour_of_day: number;
  session_count: number;
  avg_duration_min: number;
  avg_viewers: number;
  avg_tokens_per_session: number;
  total_tokens: number;
}

interface PaymentPattern {
  cast_name: string;
  payment_hour: number;
  avg_tip_amount: number;
  median_tip_amount: number;
  tip_count: number;
  unique_tippers: number;
  repeat_tipper_count: number;
  avg_tips_per_user: number;
  whale_count: number;
  micro_count: number;
  mid_count: number;
  high_count: number;
}

interface GrowthCurve {
  cast_name: string;
  report_date: string;
  tokens: number;
  tip_count: number;
  unique_users: number;
  avg_viewers: number;
  peak_viewers: number;
  chat_messages: number;
  tokens_7d_avg: number;
  viewers_7d_avg: number;
}

interface MarketTrend {
  report_date: string;
  own_tokens: number;
  own_viewers: number;
  own_sessions: number;
  competitor_tokens: number;
  competitor_viewers: number;
  competitor_sessions: number;
  market_share_pct: number;
  own_avg_tip: number;
  competitor_avg_tip: number;
}

const SUB_TABS: { key: AnalysisSubTab; label: string; icon: string }[] = [
  { key: 'schedule', label: '配信パターン', icon: '📅' },
  { key: 'payment',  label: '課金パターン', icon: '💰' },
  { key: 'growth',   label: '成長曲線',     icon: '📈' },
  { key: 'market',   label: 'マーケットトレンド', icon: '🌐' },
];

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

const CHART_COLORS = [
  '#38bdf8', '#22c55e', '#f59e0b', '#a78bfa', '#f43f5e',
  '#06b6d4', '#84cc16', '#f97316', '#8b5cf6', '#ec4899',
];

const tooltipStyle = {
  contentStyle: {
    background: 'rgba(10,15,30,0.95)',
    border: '1px solid rgba(56,189,248,0.15)',
    borderRadius: '8px',
    fontSize: '11px',
    color: '#f1f5f9',
  },
  labelStyle: { color: '#94a3b8' },
};

/* ============================================================
   Main Component
   ============================================================ */
export function SpyAnalysisTabs() {
  const { user } = useAuth();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<AnalysisSubTab>('schedule');
  const [days, setDays] = useState(30);
  const [castFilter, setCastFilter] = useState<string | null>(null);
  const [castNames, setCastNames] = useState<string[]>([]);

  const sb = useMemo(() => createClient(), []);

  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  // Load cast names for filter
  useEffect(() => {
    if (!accountId) return;
    sb.from('registered_casts')
      .select('cast_name')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .order('cast_name')
      .then(({ data }) => {
        if (data) setCastNames(data.map(d => d.cast_name));
      });
  }, [accountId, sb]);

  if (!user || !accountId) return null;

  return (
    <div className="flex-1 flex flex-col gap-2 overflow-hidden">
      {/* Sub-tab & Controls */}
      <div className="flex items-center justify-between flex-shrink-0 flex-wrap gap-2">
        <div className="flex items-center gap-1">
          {SUB_TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setSubTab(t.key)}
              className="px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all"
              style={{
                background: subTab === t.key ? 'rgba(245,158,11,0.10)' : 'transparent',
                color: subTab === t.key ? '#f59e0b' : 'var(--text-muted)',
                border: subTab === t.key ? '1px solid rgba(245,158,11,0.2)' : '1px solid transparent',
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {/* Cast filter */}
          <select
            value={castFilter ?? ''}
            onChange={e => setCastFilter(e.target.value || null)}
            className="input-glass text-[10px] py-1 px-2 rounded-lg"
            style={{ minWidth: '100px' }}
          >
            <option value="">全キャスト</option>
            {castNames.map(cn => (
              <option key={cn} value={cn}>{cn}</option>
            ))}
          </select>
          {/* Period */}
          <div className="flex items-center gap-1">
            {[7, 30, 90].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className="px-2 py-1 rounded-lg text-[10px] font-semibold transition-all"
                style={{
                  background: days === d ? 'rgba(245,158,11,0.12)' : 'transparent',
                  color: days === d ? '#f59e0b' : 'var(--text-muted)',
                  border: days === d ? '1px solid rgba(245,158,11,0.3)' : '1px solid transparent',
                }}
              >{d}日</button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        {subTab === 'schedule' && <ScheduleTab accountId={accountId} castFilter={castFilter} days={days} />}
        {subTab === 'payment' && <PaymentTab accountId={accountId} castFilter={castFilter} days={days} />}
        {subTab === 'growth' && <GrowthTab accountId={accountId} castFilter={castFilter} days={days} />}
        {subTab === 'market' && <MarketTab accountId={accountId} days={days} />}
      </div>
    </div>
  );
}

/* ============================================================
   配信パターン分析
   ============================================================ */
function ScheduleTab({ accountId, castFilter, days }: { accountId: string; castFilter: string | null; days: number }) {
  const [data, setData] = useState<SchedulePattern[]>([]);
  const [loading, setLoading] = useState(true);
  const sb = useMemo(() => createClient(), []);

  useEffect(() => {
    setLoading(true);
    sb.rpc('get_spy_cast_schedule_pattern', {
      p_account_id: accountId,
      p_cast_name: castFilter,
      p_days: days,
    }).then(({ data: res }) => {
      if (res) setData(res);
      setLoading(false);
    });
  }, [accountId, castFilter, days, sb]);

  if (loading) return <LoadingSpinner label="配信パターン分析中..." />;
  if (data.length === 0) return <EmptyState label="配信パターンデータなし" desc="SPYデータが蓄積されると分析が表示されます" />;

  // Heatmap: DOW × Hour
  const casts = Array.from(new Set(data.map(d => d.cast_name)));
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const maxSessions = Math.max(...data.map(d => d.session_count), 1);

  // Summary cards
  const totalSessions = data.reduce((s, d) => s + d.session_count, 0);
  const avgDuration = data.length > 0 ? data.reduce((s, d) => s + d.avg_duration_min, 0) / data.length : 0;
  const totalTokens = data.reduce((s, d) => s + Number(d.total_tokens), 0);

  // Chart: 曜日別セッション数
  const dowData = DOW_LABELS.map((label, i) => {
    const rows = data.filter(d => d.day_of_week === i);
    return {
      name: label,
      sessions: rows.reduce((s, r) => s + r.session_count, 0),
      tokens: rows.reduce((s, r) => s + Number(r.total_tokens), 0),
      avgViewers: rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.avg_viewers, 0) / rows.length) : 0,
    };
  });

  return (
    <div className="space-y-4 p-1">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="総セッション数" value={`${totalSessions}`} color="#f59e0b" />
        <SummaryCard label="平均配信時間" value={`${avgDuration.toFixed(0)}分`} color="#38bdf8" />
        <SummaryCard label="総トークン" value={formatTokens(totalTokens)} color="#22c55e" />
        <SummaryCard label="キャスト数" value={`${casts.length}`} color="#a78bfa" />
      </div>

      {/* 曜日別チャート */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>曜日別配信セッション数</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={dowData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <Tooltip {...tooltipStyle} />
            <Bar dataKey="sessions" fill="#f59e0b" name="セッション数" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 時間帯ヒートマップ */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>曜日×時間帯 配信ヒートマップ</p>
        <div className="overflow-x-auto">
          <table className="text-[9px] w-full" style={{ minWidth: '700px' }}>
            <thead>
              <tr>
                <th className="text-left px-1 py-1 sticky left-0" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', minWidth: '40px', zIndex: 1 }}>曜日</th>
                {hours.map(h => (
                  <th key={h} className="px-0.5 py-1 text-center font-normal" style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DOW_LABELS.map((label, dow) => (
                <tr key={dow}>
                  <td className="px-1 py-0.5 sticky left-0" style={{ background: 'var(--bg-card)', color: dow === 0 || dow === 6 ? '#f43f5e' : 'var(--text-secondary)', zIndex: 1 }}>
                    {label}
                  </td>
                  {hours.map(h => {
                    const cells = data.filter(d => d.day_of_week === dow && d.hour_of_day === h);
                    const val = cells.reduce((s, c) => s + c.session_count, 0);
                    const intensity = val / maxSessions;
                    return (
                      <td key={h} className="px-0.5 py-0.5 text-center"
                        title={val > 0 ? `${label}${h}時: ${val}セッション` : ''}
                        style={{
                          background: val > 0 ? `rgba(245,158,11,${Math.max(0.08, intensity * 0.6)})` : 'transparent',
                          color: val > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                        }}
                      >
                        {val > 0 ? val : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>値 = セッション数 / 濃い色 = 高頻度</p>
      </div>

      {/* キャスト別テーブル */}
      {casts.length > 1 && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>キャスト別配信傾向</p>
          <div className="overflow-x-auto">
            <table className="text-[10px] w-full">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left px-2 py-1.5">キャスト</th>
                  <th className="text-right px-2 py-1.5">セッション</th>
                  <th className="text-right px-2 py-1.5">平均時間</th>
                  <th className="text-right px-2 py-1.5">平均視聴者</th>
                  <th className="text-right px-2 py-1.5">平均tk/回</th>
                  <th className="text-right px-2 py-1.5">合計tk</th>
                </tr>
              </thead>
              <tbody>
                {casts.map(cn => {
                  const rows = data.filter(d => d.cast_name === cn);
                  const sess = rows.reduce((s, r) => s + r.session_count, 0);
                  const avgDur = rows.length > 0 ? rows.reduce((s, r) => s + r.avg_duration_min, 0) / rows.length : 0;
                  const avgV = rows.length > 0 ? rows.reduce((s, r) => s + r.avg_viewers, 0) / rows.length : 0;
                  const avgTk = rows.length > 0 ? rows.reduce((s, r) => s + r.avg_tokens_per_session, 0) / rows.length : 0;
                  const tk = rows.reduce((s, r) => s + Number(r.total_tokens), 0);
                  return (
                    <tr key={cn} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                      <td className="px-2 py-1.5 truncate" style={{ color: 'var(--text-secondary)', maxWidth: '100px' }}>
                        <Link href={`/spy/${encodeURIComponent(cn)}`} className="hover:underline">{cn}</Link>
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: 'var(--accent-amber)' }}>{sess}</td>
                      <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-secondary)' }}>{avgDur.toFixed(0)}分</td>
                      <td className="px-2 py-1.5 text-right" style={{ color: 'var(--accent-primary)' }}>{avgV.toFixed(0)}人</td>
                      <td className="px-2 py-1.5 text-right" style={{ color: 'var(--accent-green)' }}>{formatTokens(avgTk)}</td>
                      <td className="px-2 py-1.5 text-right font-bold" style={{ color: 'var(--accent-green)' }}>{formatTokens(tk)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   課金パターン分析
   ============================================================ */
function PaymentTab({ accountId, castFilter, days }: { accountId: string; castFilter: string | null; days: number }) {
  const [data, setData] = useState<PaymentPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const sb = useMemo(() => createClient(), []);

  useEffect(() => {
    setLoading(true);
    sb.rpc('get_user_payment_pattern', {
      p_account_id: accountId,
      p_cast_name: castFilter,
      p_days: days,
    }).then(({ data: res }) => {
      if (res) setData(res);
      setLoading(false);
    });
  }, [accountId, castFilter, days, sb]);

  if (loading) return <LoadingSpinner label="課金パターン分析中..." />;
  if (data.length === 0) return <EmptyState label="課金データなし" desc="チップ・ギフトのSPYデータが蓄積されると分析が表示されます" />;

  // Aggregate across casts for hourly chart
  const hourlyMap = new Map<number, { tips: number; tokens: number; tippers: number }>();
  data.forEach(d => {
    const prev = hourlyMap.get(d.payment_hour) || { tips: 0, tokens: 0, tippers: 0 };
    hourlyMap.set(d.payment_hour, {
      tips: prev.tips + Number(d.tip_count),
      tokens: prev.tokens + Number(d.avg_tip_amount) * Number(d.tip_count),
      tippers: prev.tippers + Number(d.unique_tippers),
    });
  });
  const hourlyChart = Array.from({ length: 24 }, (_, h) => {
    const val = hourlyMap.get(h);
    return {
      hour: `${h}時`,
      tips: val?.tips ?? 0,
      tippers: val?.tippers ?? 0,
    };
  });

  // Amount tier summary
  const totalWhale = data.reduce((s, d) => s + Number(d.whale_count), 0);
  const totalHigh = data.reduce((s, d) => s + Number(d.high_count), 0);
  const totalMid = data.reduce((s, d) => s + Number(d.mid_count), 0);
  const totalMicro = data.reduce((s, d) => s + Number(d.micro_count), 0);
  const totalTips = data.reduce((s, d) => s + Number(d.tip_count), 0);
  const totalTippers = data.reduce((s, d) => s + Number(d.unique_tippers), 0);

  const tierData = [
    { name: 'Whale (1000+tk)', count: totalWhale, color: '#f43f5e' },
    { name: 'High (500-999tk)', count: totalHigh, color: '#a78bfa' },
    { name: 'Mid (50-499tk)', count: totalMid, color: '#38bdf8' },
    { name: 'Micro (1-49tk)', count: totalMicro, color: '#94a3b8' },
  ];

  return (
    <div className="space-y-4 p-1">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="総チップ回数" value={`${totalTips}`} color="#f59e0b" />
        <SummaryCard label="ユニーク課金者" value={`${totalTippers}`} color="#38bdf8" />
        <SummaryCard label="Whale課金" value={`${totalWhale}回`} color="#f43f5e" />
        <SummaryCard label="平均チップ額" value={totalTips > 0 ? `${(data.reduce((s, d) => s + d.avg_tip_amount * Number(d.tip_count), 0) / totalTips).toFixed(0)}tk` : '-'} color="#22c55e" />
      </div>

      {/* 時間帯別課金チャート */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>時間帯別課金回数</p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={hourlyChart}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#94a3b8' }} interval={1} />
            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <Tooltip {...tooltipStyle} />
            <Bar dataKey="tips" fill="#f59e0b" name="課金回数" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 金額帯分布 */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>金額帯分布</p>
        <div className="space-y-2">
          {tierData.map(tier => {
            const pct = totalTips > 0 ? (tier.count / totalTips) * 100 : 0;
            return (
              <div key={tier.name} className="flex items-center gap-3">
                <span className="text-[10px] font-semibold" style={{ color: tier.color, width: '130px', minWidth: '130px' }}>{tier.name}</span>
                <div className="flex-1 h-5 rounded" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <div className="h-full rounded flex items-center px-2" style={{ width: `${Math.max(pct, 2)}%`, background: `${tier.color}33`, minWidth: '30px' }}>
                    <span className="text-[9px] font-bold" style={{ color: tier.color }}>{tier.count} ({pct.toFixed(1)}%)</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* キャスト別課金パターン */}
      {(() => {
        const casts = Array.from(new Set(data.map(d => d.cast_name)));
        if (casts.length <= 1) return null;
        return (
          <div className="glass-card p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>キャスト別課金パターン</p>
            <div className="overflow-x-auto">
              <table className="text-[10px] w-full">
                <thead>
                  <tr style={{ color: 'var(--text-muted)' }}>
                    <th className="text-left px-2 py-1.5">キャスト</th>
                    <th className="text-right px-2 py-1.5">チップ数</th>
                    <th className="text-right px-2 py-1.5">課金者数</th>
                    <th className="text-right px-2 py-1.5">平均額</th>
                    <th className="text-right px-2 py-1.5">中央値</th>
                    <th className="text-right px-2 py-1.5">Whale</th>
                  </tr>
                </thead>
                <tbody>
                  {casts.map(cn => {
                    const rows = data.filter(d => d.cast_name === cn);
                    const tips = rows.reduce((s, r) => s + Number(r.tip_count), 0);
                    const tippers = rows.reduce((s, r) => s + Number(r.unique_tippers), 0);
                    const avgTip = tips > 0 ? rows.reduce((s, r) => s + r.avg_tip_amount * Number(r.tip_count), 0) / tips : 0;
                    const medianTip = rows.length > 0 ? rows.reduce((s, r) => s + r.median_tip_amount, 0) / rows.length : 0;
                    const whales = rows.reduce((s, r) => s + Number(r.whale_count), 0);
                    return (
                      <tr key={cn} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                        <td className="px-2 py-1.5 truncate" style={{ color: 'var(--text-secondary)', maxWidth: '100px' }}>
                          <Link href={`/spy/${encodeURIComponent(cn)}`} className="hover:underline">{cn}</Link>
                        </td>
                        <td className="px-2 py-1.5 text-right" style={{ color: 'var(--accent-amber)' }}>{tips}</td>
                        <td className="px-2 py-1.5 text-right" style={{ color: 'var(--accent-primary)' }}>{tippers}</td>
                        <td className="px-2 py-1.5 text-right" style={{ color: 'var(--accent-green)' }}>{avgTip.toFixed(0)}tk</td>
                        <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-secondary)' }}>{medianTip.toFixed(0)}tk</td>
                        <td className="px-2 py-1.5 text-right font-bold" style={{ color: whales > 0 ? '#f43f5e' : 'var(--text-muted)' }}>{whales}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ============================================================
   成長曲線
   ============================================================ */
function GrowthTab({ accountId, castFilter, days }: { accountId: string; castFilter: string | null; days: number }) {
  const [data, setData] = useState<GrowthCurve[]>([]);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<'tokens' | 'viewers' | 'users'>('tokens');
  const sb = useMemo(() => createClient(), []);

  useEffect(() => {
    setLoading(true);
    sb.rpc('get_cast_growth_curve', {
      p_account_id: accountId,
      p_cast_name: castFilter,
      p_days: days,
    }).then(({ data: res }) => {
      if (res) setData(res);
      setLoading(false);
    });
  }, [accountId, castFilter, days, sb]);

  if (loading) return <LoadingSpinner label="成長曲線計算中..." />;
  if (data.length === 0) return <EmptyState label="成長データなし" desc="日次SPYデータが蓄積されると成長曲線が表示されます" />;

  const casts = Array.from(new Set(data.map(d => d.cast_name)));

  // For chart: if single cast, show daily + 7d avg; if multiple, show 7d avg per cast
  const chartData = (() => {
    if (casts.length === 1) {
      return data.map(d => ({
        date: d.report_date.substring(5), // MM-DD
        tokens: Number(d.tokens),
        tokens_7d: Number(d.tokens_7d_avg),
        viewers: Number(d.avg_viewers),
        viewers_7d: Number(d.viewers_7d_avg),
        users: Number(d.unique_users),
      }));
    }
    // Multiple casts: pivot dates
    const dates = Array.from(new Set(data.map(d => d.report_date))).sort();
    return dates.map(date => {
      const row: Record<string, string | number> = { date: date.substring(5) };
      casts.forEach(cn => {
        const entry = data.find(d => d.cast_name === cn && d.report_date === date);
        if (metric === 'tokens') {
          row[cn] = entry ? Number(entry.tokens_7d_avg) : 0;
        } else if (metric === 'viewers') {
          row[cn] = entry ? Number(entry.viewers_7d_avg) : 0;
        } else {
          row[cn] = entry ? Number(entry.unique_users) : 0;
        }
      });
      return row;
    });
  })();

  // Summary
  const latestDate = data.reduce((max, d) => d.report_date > max ? d.report_date : max, '');
  const latest = data.filter(d => d.report_date === latestDate);
  const totalTokens = latest.reduce((s, d) => s + Number(d.tokens), 0);
  const avgViewers = latest.length > 0 ? latest.reduce((s, d) => s + Number(d.avg_viewers), 0) / latest.length : 0;
  const peakViewers = Math.max(...data.map(d => d.peak_viewers), 0);

  return (
    <div className="space-y-4 p-1">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="直近日売上" value={formatTokens(totalTokens)} color="#22c55e" />
        <SummaryCard label="直近平均視聴者" value={`${avgViewers.toFixed(0)}人`} color="#38bdf8" />
        <SummaryCard label="期間ピーク視聴者" value={`${peakViewers}人`} color="#a78bfa" />
        <SummaryCard label="データ日数" value={`${Array.from(new Set(data.map(d => d.report_date))).length}日`} color="#f59e0b" />
      </div>

      {/* Metric Selector */}
      <div className="flex items-center gap-1">
        {([
          { key: 'tokens' as const, label: 'トークン' },
          { key: 'viewers' as const, label: '視聴者' },
          { key: 'users' as const, label: 'ユニーク数' },
        ]).map(m => (
          <button
            key={m.key}
            onClick={() => setMetric(m.key)}
            className="px-3 py-1 rounded-lg text-[10px] font-semibold transition-all"
            style={{
              background: metric === m.key ? 'rgba(34,197,94,0.12)' : 'transparent',
              color: metric === m.key ? '#22c55e' : 'var(--text-muted)',
              border: metric === m.key ? '1px solid rgba(34,197,94,0.3)' : '1px solid transparent',
            }}
          >{m.label}</button>
        ))}
      </div>

      {/* Growth Chart */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          {casts.length === 1 ? `${casts[0]} 成長曲線` : 'キャスト別成長曲線 (7日移動平均)'}
        </p>
        <ResponsiveContainer width="100%" height={280}>
          {casts.length === 1 ? (
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip {...tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: '10px' }} />
              {metric === 'tokens' && (
                <>
                  <Area type="monotone" dataKey="tokens" stroke="#22c55e" fill="rgba(34,197,94,0.1)" strokeWidth={1} name="日次トークン" />
                  <Line type="monotone" dataKey="tokens_7d" stroke="#f59e0b" strokeWidth={2} dot={false} name="7日平均" />
                </>
              )}
              {metric === 'viewers' && (
                <>
                  <Area type="monotone" dataKey="viewers" stroke="#38bdf8" fill="rgba(56,189,248,0.1)" strokeWidth={1} name="平均視聴者" />
                  <Line type="monotone" dataKey="viewers_7d" stroke="#f59e0b" strokeWidth={2} dot={false} name="7日平均" />
                </>
              )}
              {metric === 'users' && (
                <Area type="monotone" dataKey="users" stroke="#a78bfa" fill="rgba(167,139,250,0.1)" strokeWidth={2} name="ユニークユーザー" />
              )}
            </AreaChart>
          ) : (
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip {...tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: '10px' }} />
              {casts.map((cn, i) => (
                <Line key={cn} type="monotone" dataKey={cn} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ============================================================
   マーケットトレンド
   ============================================================ */
function MarketTab({ accountId, days }: { accountId: string; days: number }) {
  const [data, setData] = useState<MarketTrend[]>([]);
  const [loading, setLoading] = useState(true);
  const sb = useMemo(() => createClient(), []);

  useEffect(() => {
    setLoading(true);
    sb.rpc('get_market_trend', {
      p_account_id: accountId,
      p_days: days,
    }).then(({ data: res }) => {
      if (res) setData(res);
      setLoading(false);
    });
  }, [accountId, days, sb]);

  if (loading) return <LoadingSpinner label="マーケットトレンド計算中..." />;
  if (data.length === 0) return <EmptyState label="マーケットデータなし" desc="自社+他社のSPYデータが蓄積されると表示されます" />;

  const chartData = data.map(d => ({
    date: d.report_date.substring(5),
    own: Number(d.own_tokens),
    competitor: Number(d.competitor_tokens),
    share: Number(d.market_share_pct),
    ownViewers: Number(d.own_viewers),
    compViewers: Number(d.competitor_viewers),
  }));

  // Latest summary
  const latest = data[data.length - 1];
  const avgShare = data.length > 0 ? data.reduce((s, d) => s + Number(d.market_share_pct), 0) / data.length : 0;
  const totalOwn = data.reduce((s, d) => s + Number(d.own_tokens), 0);
  const totalComp = data.reduce((s, d) => s + Number(d.competitor_tokens), 0);

  return (
    <div className="space-y-4 p-1">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="平均マーケットシェア" value={`${avgShare.toFixed(1)}%`} color="#f59e0b" />
        <SummaryCard label="自社合計tk" value={formatTokens(totalOwn)} color="#22c55e" />
        <SummaryCard label="他社合計tk" value={formatTokens(totalComp)} color="#f43f5e" />
        <SummaryCard label="直近シェア" value={latest ? `${Number(latest.market_share_pct).toFixed(1)}%` : '-'} color="#38bdf8" />
      </div>

      {/* トークン比較チャート */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>自社 vs 他社 日次トークン推移</p>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} />
            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <Tooltip {...tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: '10px' }} />
            <Bar dataKey="own" fill="#22c55e" name="自社" radius={[3, 3, 0, 0]} />
            <Bar dataKey="competitor" fill="rgba(244,63,94,0.5)" name="他社" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* マーケットシェア推移 */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>マーケットシェア推移 (%)</p>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} />
            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} domain={[0, 100]} />
            <Tooltip {...tooltipStyle} />
            <Area type="monotone" dataKey="share" stroke="#f59e0b" fill="rgba(245,158,11,0.15)" strokeWidth={2} name="シェア%" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* 視聴者数比較 */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>平均視聴者数推移</p>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} />
            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <Tooltip {...tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: '10px' }} />
            <Line type="monotone" dataKey="ownViewers" stroke="#22c55e" strokeWidth={2} dot={false} name="自社視聴者" />
            <Line type="monotone" dataKey="compViewers" stroke="#f43f5e" strokeWidth={2} dot={false} name="他社視聴者" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Daily detail table */}
      <div className="glass-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>日次詳細</p>
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          <table className="text-[10px] w-full">
            <thead className="sticky top-0" style={{ background: 'var(--bg-card)' }}>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="text-left px-2 py-1.5">日付</th>
                <th className="text-right px-2 py-1.5">自社tk</th>
                <th className="text-right px-2 py-1.5">他社tk</th>
                <th className="text-right px-2 py-1.5">シェア</th>
                <th className="text-right px-2 py-1.5">自社視聴者</th>
                <th className="text-right px-2 py-1.5">他社視聴者</th>
              </tr>
            </thead>
            <tbody>
              {data.slice().reverse().map(d => (
                <tr key={d.report_date} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                  <td className="px-2 py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.report_date.substring(5)}</td>
                  <td className="px-2 py-1.5 text-right font-bold" style={{ color: 'var(--accent-green)' }}>{formatTokens(Number(d.own_tokens))}</td>
                  <td className="px-2 py-1.5 text-right" style={{ color: 'var(--accent-pink)' }}>{formatTokens(Number(d.competitor_tokens))}</td>
                  <td className="px-2 py-1.5 text-right" style={{ color: Number(d.market_share_pct) >= 50 ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
                    {Number(d.market_share_pct).toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-secondary)' }}>{Number(d.own_viewers).toFixed(0)}</td>
                  <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-secondary)' }}>{Number(d.competitor_viewers).toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Shared Components
   ============================================================ */
function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl p-3 text-center" style={{ background: `${color}08`, border: `1px solid ${color}22` }}>
      <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-base font-bold" style={{ color }}>{value}</p>
    </div>
  );
}

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center">
        <div className="inline-block w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>{label}</p>
      </div>
    </div>
  );
}

function EmptyState({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="glass-card p-8 text-center max-w-md">
        <p className="text-2xl mb-3">📊</p>
        <p className="text-sm font-bold mb-2">{label}</p>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{desc}</p>
      </div>
    </div>
  );
}
