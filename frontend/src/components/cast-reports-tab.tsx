'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, COIN_RATE } from '@/lib/utils';
import { Accordion } from '@/components/accordion';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell, Legend,
} from 'recharts';

/* ============================================================
   Types
   ============================================================ */

interface ViewerTimelinePoint {
  time: string;
  count: number;
}

interface TopTipper {
  username: string;
  amount: number;
  count: number;
}

interface SegmentDistribution {
  new: number;
  light: number;
  regular: number;
  vip: number;
  whale: number;
  churned: number;
  unknown: number;
}

interface PostSessionMetrics {
  session_duration_minutes: number;
  peak_viewers: number;
  avg_viewers: number;
  viewer_timeline: ViewerTimelinePoint[];
  total_tips: number;
  tip_count: number;
  tip_speed_per_minute: number;
  top_tippers: TopTipper[];
  chat_messages_total: number;
  chat_speed_per_minute: number;
  segment_distribution: SegmentDistribution;
  unique_chatters: number;
  returning_viewers_count: number;
}

interface CastYesterday {
  sessions_count: number;
  total_duration_minutes: number;
  total_tips: number;
  peak_viewers: number;
  unique_chatters: number;
}

interface CastTrend7d {
  avg_daily_tips: number;
  avg_session_duration: number;
  avg_peak_viewers: number;
  tip_trend: 'up' | 'down' | 'stable';
}

interface CastBriefing {
  cast_name: string;
  yesterday: CastYesterday;
  trend_7d: CastTrend7d;
  recommended_time_slot: string;
}

interface DailyBriefingMetrics {
  date: string;
  casts: CastBriefing[];
}

interface CastKnowledgeRecord {
  id: string;
  report_type: 'post_session' | 'daily_briefing' | 'weekly_review';
  period_start: string;
  period_end: string | null;
  metrics_json: PostSessionMetrics | DailyBriefingMetrics;
  insights_json: {
    highlights?: string[];
    concerns?: string[];
    suggestions?: string[];
  };
  created_at: string;
}

/* ============================================================
   Props
   ============================================================ */
interface CastReportsTabProps {
  accountId: string;
  castId: number;
  castName: string;
}

/* ============================================================
   Segment Chart Colors
   ============================================================ */
const SEGMENT_COLORS: Record<string, string> = {
  new: '#38bdf8',
  light: '#22c55e',
  regular: '#a78bfa',
  vip: '#f59e0b',
  whale: '#f43f5e',
  churned: '#6b7280',
  unknown: '#334155',
};

const SEGMENT_LABELS: Record<string, string> = {
  new: '新規',
  light: 'ライト',
  regular: 'レギュラー',
  vip: 'VIP',
  whale: 'Whale',
  churned: '離脱',
  unknown: '不明',
};

/* ============================================================
   Component
   ============================================================ */
export default function CastReportsTab({ accountId, castId, castName }: CastReportsTabProps) {
  const [records, setRecords] = useState<CastKnowledgeRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // データ取得
  useEffect(() => {
    const sb = createClient();
    sb.from('cast_knowledge')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_id', castId)
      .order('period_start', { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (!error && data) setRecords(data as CastKnowledgeRecord[]);
        setLoading(false);
      });
  }, [accountId, castId]);

  // レポート分類
  const latestBriefing = useMemo(() =>
    records.find(r => r.report_type === 'daily_briefing') ?? null
  , [records]);

  const sessionReports = useMemo(() =>
    records.filter(r => r.report_type === 'post_session')
  , [records]);

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
        <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
        <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="glass-card p-10 text-center">
        <p className="text-lg mb-2">📊</p>
        <p className="text-sm font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>
          配信レポートがまだありません
        </p>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          配信終了後に自動でレポートが生成されます。
          日次ブリーフィングは毎朝9時に自動作成されます。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ========== 日次ブリーフィング ========== */}
      {latestBriefing && (
        <DailyBriefingCard record={latestBriefing} castName={castName} />
      )}

      {/* ========== インサイト（AI分析結果） ========== */}
      {latestBriefing?.insights_json && Object.keys(latestBriefing.insights_json).length > 0 && (
        <InsightsCard insights={latestBriefing.insights_json} />
      )}

      {/* ========== 配信履歴 ========== */}
      {sessionReports.length > 0 && (
        <Accordion id="cast-reports-sessions" title="配信レポート履歴" icon="📺" badge={`${sessionReports.length}件`} defaultOpen>
          <div className="space-y-3">
            {sessionReports.map(r => (
              <SessionReportCard key={r.id} record={r} castName={castName} />
            ))}
          </div>
        </Accordion>
      )}

      {/* ========== DM施策ボタン ========== */}
      <div className="glass-card p-4">
        <Link
          href={`/casts/${encodeURIComponent(castName)}?tab=dm`}
          className="btn-primary w-full text-center block text-sm py-2.5 rounded-xl"
        >
          DM施策を作成
        </Link>
        <p className="text-[10px] mt-2 text-center" style={{ color: 'var(--text-muted)' }}>
          離脱リスクユーザーやVIPへのDMを作成できます
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   DailyBriefingCard
   ============================================================ */
function DailyBriefingCard({ record, castName }: { record: CastKnowledgeRecord; castName: string }) {
  const metrics = record.metrics_json as DailyBriefingMetrics;
  const castData = metrics.casts?.find(c => c.cast_name === castName);

  if (!castData) {
    return (
      <div className="glass-card p-5">
        <h3 className="text-sm font-bold mb-2 flex items-center gap-2">
          📋 日次ブリーフィング
          <span className="text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>
            {metrics.date}
          </span>
        </h3>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          このキャストのデータはブリーフィングに含まれていません
        </p>
      </div>
    );
  }

  const { yesterday, trend_7d } = castData;
  const trendIcon = trend_7d.tip_trend === 'up' ? '📈' : trend_7d.tip_trend === 'down' ? '📉' : '➡️';
  const trendColor = trend_7d.tip_trend === 'up' ? 'var(--accent-green)' :
                     trend_7d.tip_trend === 'down' ? 'var(--accent-pink)' : 'var(--text-secondary)';

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold flex items-center gap-2">
          📋 日次ブリーフィング
        </h3>
        <span className="text-[10px] px-2 py-0.5 rounded-full"
          style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
          {metrics.date}
        </span>
      </div>

      {/* 昨日の実績 */}
      <div className="mb-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
          昨日の実績
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
          <MetricCard label="配信数" value={yesterday.sessions_count} unit="回" />
          <MetricCard label="合計時間" value={yesterday.total_duration_minutes} unit="分" />
          <MetricCard label="チップ合計" value={formatTokens(yesterday.total_tips)} color="var(--accent-amber)" />
          <MetricCard label="最大視聴者" value={yesterday.peak_viewers} unit="人" />
          <MetricCard label="チャット参加" value={yesterday.unique_chatters} unit="人" />
        </div>
      </div>

      {/* 7日トレンド */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
          7日間トレンド
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="glass-panel p-3 rounded-xl">
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>チップ傾向</p>
            <p className="text-lg font-bold" style={{ color: trendColor }}>
              {trendIcon} {trend_7d.tip_trend === 'up' ? '上昇' : trend_7d.tip_trend === 'down' ? '下降' : '横ばい'}
            </p>
          </div>
          <MetricCard label="平均日次チップ" value={formatTokens(Math.round(trend_7d.avg_daily_tips))} color="var(--accent-amber)" />
          <MetricCard label="平均配信時間" value={Math.round(trend_7d.avg_session_duration)} unit="分" />
          <MetricCard label="平均最大視聴者" value={Math.round(trend_7d.avg_peak_viewers)} unit="人" />
        </div>
        {castData.recommended_time_slot && (
          <p className="text-[10px] mt-3 px-3 py-1.5 rounded-lg inline-block"
            style={{ background: 'rgba(34,197,94,0.08)', color: 'var(--accent-green)' }}>
            推奨配信時間帯: {castData.recommended_time_slot}
          </p>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   InsightsCard
   ============================================================ */
function InsightsCard({ insights }: { insights: CastKnowledgeRecord['insights_json'] }) {
  const sections = [
    { key: 'highlights' as const, label: '好調ポイント', color: 'var(--accent-green)', bg: 'rgba(34,197,94,0.06)', border: 'rgb(34,197,94)' },
    { key: 'concerns' as const, label: '注意点', color: 'var(--accent-pink)', bg: 'rgba(244,63,94,0.06)', border: 'rgb(244,63,94)' },
    { key: 'suggestions' as const, label: '改善提案', color: 'var(--accent-primary)', bg: 'rgba(56,189,248,0.06)', border: 'rgb(56,189,248)' },
  ];

  return (
    <div className="space-y-2">
      {sections.map(s => {
        const items = insights[s.key];
        if (!items || items.length === 0) return null;
        return (
          <div key={s.key} className="glass-card p-4" style={{ background: s.bg, borderLeft: `3px solid ${s.border}` }}>
            <p className="text-[11px] font-bold mb-2" style={{ color: s.color }}>{s.label}</p>
            <ul className="space-y-1">
              {items.map((item, i) => (
                <li key={i} className="text-xs flex items-start gap-2" style={{ color: 'var(--text-secondary)' }}>
                  <span className="mt-0.5 shrink-0" style={{ color: s.color }}>•</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   SessionReportCard
   ============================================================ */
function SessionReportCard({ record, castName }: { record: CastKnowledgeRecord; castName: string }) {
  const [expanded, setExpanded] = useState(false);
  const m = record.metrics_json as PostSessionMetrics;

  const startDate = new Date(record.period_start);
  const dateStr = startDate.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const timeStr = startDate.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="glass-card overflow-hidden">
      {/* Header（クリックで展開） */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 text-left flex items-center gap-3 transition-colors hover:bg-white/[0.02]"
      >
        <span className="text-[10px] transition-transform duration-200"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', color: 'var(--accent-primary)' }}>
          ▶
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
              {dateStr} {timeStr}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {m.session_duration_minutes}分
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[10px]">
            <span style={{ color: 'var(--text-muted)' }}>
              視聴者 <span className="font-bold text-slate-300">{m.peak_viewers}</span>
            </span>
            <span style={{ color: 'var(--accent-amber)' }}>
              TIP <span className="font-bold">{formatTokens(m.total_tips)}</span>
            </span>
            <span style={{ color: 'var(--accent-green)' }}>
              <span className="font-bold">{tokensToJPY(m.total_tips, COIN_RATE)}</span>
            </span>
            <span style={{ color: 'var(--text-muted)' }}>
              Chat <span className="font-bold text-slate-300">{m.chat_messages_total}</span>
            </span>
          </div>
        </div>
      </button>

      {/* 展開エリア */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-4" style={{ borderColor: 'var(--border-glass)' }}>
          {/* KPI カード */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <MetricCard label="配信時間" value={m.session_duration_minutes} unit="分" />
            <MetricCard label="チップ速度" value={m.tip_speed_per_minute?.toFixed(1) ?? '0'} unit="tk/分" color="var(--accent-amber)" />
            <MetricCard label="チャット速度" value={m.chat_speed_per_minute?.toFixed(1) ?? '0'} unit="msg/分" />
            <MetricCard label="リピーター" value={m.returning_viewers_count ?? 0} unit="人" color="var(--accent-purple, #a855f7)" />
          </div>

          {/* 視聴者タイムライン */}
          {m.viewer_timeline && m.viewer_timeline.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                視聴者推移
              </p>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={m.viewer_timeline.map(p => ({
                    time: new Date(p.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
                    viewers: p.count,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={30} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 8, fontSize: 11 }}
                      labelStyle={{ color: '#94a3b8' }}
                    />
                    <Line type="monotone" dataKey="viewers" stroke="#38bdf8" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top Tippers テーブル */}
          {m.top_tippers && m.top_tippers.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                Top Tippers
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr style={{ color: 'var(--text-muted)' }}>
                      <th className="text-left py-1.5 px-2">#</th>
                      <th className="text-left py-1.5 px-2">ユーザー</th>
                      <th className="text-right py-1.5 px-2">コイン</th>
                      <th className="text-right py-1.5 px-2">回数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.top_tippers.map((t, i) => (
                      <tr key={t.username} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                        <td className="py-1.5 px-2" style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                        <td className="py-1.5 px-2">
                          <Link href={`/spy/users/${encodeURIComponent(t.username)}`}
                            className="hover:underline" style={{ color: 'var(--accent-primary)' }}>
                            {t.username}
                          </Link>
                        </td>
                        <td className="py-1.5 px-2 text-right font-bold" style={{ color: 'var(--accent-amber)' }}>
                          {t.amount.toLocaleString()}
                        </td>
                        <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>
                          {t.count}回
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* セグメント分布 */}
          {m.segment_distribution && (
            <SegmentChart distribution={m.segment_distribution} />
          )}

          {/* インサイト */}
          {record.insights_json && Object.keys(record.insights_json).length > 0 && (
            <InsightsCard insights={record.insights_json} />
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   SegmentChart（円グラフ）
   ============================================================ */
function SegmentChart({ distribution }: { distribution: SegmentDistribution }) {
  const data = Object.entries(distribution)
    .filter(([, v]) => v > 0)
    .map(([key, value]) => ({
      name: SEGMENT_LABELS[key] || key,
      value,
      color: SEGMENT_COLORS[key] || '#64748b',
    }));

  if (data.length === 0) return null;

  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
        セグメント分布
      </p>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              outerRadius={70}
              dataKey="value"
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              labelLine={false}
              style={{ fontSize: 10 }}
            >
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 8, fontSize: 11 }}
            />
            <Legend
              wrapperStyle={{ fontSize: 10 }}
              formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ============================================================
   MetricCard（小型KPIカード）
   ============================================================ */
function MetricCard({ label, value, unit, color }: {
  label: string;
  value: string | number;
  unit?: string;
  color?: string;
}) {
  return (
    <div className="glass-panel p-3 rounded-xl">
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-lg font-bold" style={{ color: color || 'var(--text-primary)' }}>
        {value}{unit && <span className="text-[10px] font-normal ml-0.5" style={{ color: 'var(--text-muted)' }}>{unit}</span>}
      </p>
    </div>
  );
}
