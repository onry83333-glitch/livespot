'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { tokensToJPY, getUserLeagueColor } from '@/lib/utils';

/* ============================================================
   Types
   ============================================================ */
interface Account {
  id: string;
  account_name: string;
}

interface CampaignRow {
  campaign: string;
  sent: number;
  converted: number;
  rate: number;
  revenue: number;
}

interface EffectivenessSummary {
  total_sent: number;
  total_converted: number;
  conversion_rate: number;
  total_revenue_after_dm: number;
  avg_revenue_per_converted: number;
}

interface TimelineDay {
  date: string;
  sent: number;
  success: number;
  error: number;
  converted: number;
}

interface FunnelSegment {
  key: string;
  label: string;
  count: number;
  tokens: number;
  color: string;
}

interface FunnelUser {
  user_name: string;
  total_tokens: number;
  segment: string;
  segmentLabel: string;
  segmentColor: string;
  last_paid?: string;
  tx_count?: number;
  user_level?: number;
}

/* ============================================================
   Mock data for payroll tab (既存)
   ============================================================ */
const payrollStats = [
  { label: '総売上', value: '\u00A512,450,000', change: '+12.4%', positive: true },
  { label: 'エージェンシー利益', value: '\u00A53,735,000', change: '+10.2%', positive: true },
  { label: 'キャスト総支払額', value: '\u00A58,715,000', change: '+15.8%', positive: true },
];

const castPayroll = [
  { name: '宮崎 さくら', tier: 'PREMIUM CAST', revenue: '\u00A52,450,000', rate: '30%', payout: '\u00A51,715,000', adj: '-\u00A5245,000', status: '送金済み', statusColor: '#22c55e' },
  { name: '佐藤 美月', tier: 'Standard', revenue: '\u00A5850,000', rate: '35%', payout: '\u00A5552,500', adj: '-\u00A585,000', status: '処理中', statusColor: '#38bdf8' },
  { name: '田中 絵里', tier: 'Standard', revenue: '\u00A51,200,000', rate: '32%', payout: '\u00A5816,000', adj: '-\u00A5120,000', status: '送金済み', statusColor: '#22c55e' },
  { name: '渡辺 凛', tier: 'PREMIUM CAST', revenue: '\u00A51,980,000', rate: '30%', payout: '\u00A51,386,000', adj: '-\u00A5198,000', status: '送金済み', statusColor: '#22c55e' },
];

/* ============================================================
   Page
   ============================================================ */
export default function AnalyticsPage() {
  const { user, session } = useAuth();
  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [tab, setTab] = useState<'payroll' | 'dm' | 'funnel'>('dm');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');

  // DM効果測定 state
  const [daysWindow, setDaysWindow] = useState(7);
  const [campaignFilter, setCampaignFilter] = useState('');
  const [summary, setSummary] = useState<EffectivenessSummary | null>(null);
  const [byCampaign, setByCampaign] = useState<CampaignRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allCampaigns, setAllCampaigns] = useState<string[]>([]);

  // ファネル分析 state
  const [funnelSegments, setFunnelSegments] = useState<FunnelSegment[]>([]);
  const [funnelUsers, setFunnelUsers] = useState<FunnelUser[]>([]);
  const [funnelLoading, setFunnelLoading] = useState(false);
  const [funnelFilter, setFunnelFilter] = useState<string>('all');

  // アカウント取得
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id, account_name').order('created_at').then(({ data }) => {
      const list = data || [];
      setAccounts(list);
      if (list.length > 0) setSelectedAccount(list[0].id);
    });
  }, [user, sb]);

  // DM効果測定データ取得
  const loadEffectiveness = useCallback(async () => {
    if (!selectedAccount || !session) return;
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();

      // DM送信ログ取得
      let query = sb.from('dm_send_log')
        .select('*')
        .eq('account_id', selectedAccount)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1000);

      if (campaignFilter) {
        query = query.eq('campaign', campaignFilter);
      }

      const { data: logs } = await query;
      const items = logs || [];

      // Summary計算
      const total_sent = items.length;
      const successItems = items.filter(i => i.status === 'success');
      const total_converted = successItems.length;
      const conversion_rate = total_sent > 0 ? (total_converted / total_sent) * 100 : 0;

      setSummary({
        total_sent,
        total_converted,
        conversion_rate,
        total_revenue_after_dm: 0,
        avg_revenue_per_converted: 0,
      });

      // キャンペーン別集計
      const campMap: Record<string, { sent: number; converted: number; revenue: number }> = {};
      items.forEach(i => {
        const c = i.campaign || '(なし)';
        if (!campMap[c]) campMap[c] = { sent: 0, converted: 0, revenue: 0 };
        campMap[c].sent++;
        if (i.status === 'success') campMap[c].converted++;
      });
      setByCampaign(Object.entries(campMap).map(([campaign, v]) => ({
        campaign,
        sent: v.sent,
        converted: v.converted,
        rate: v.sent > 0 ? (v.converted / v.sent) * 100 : 0,
        revenue: v.revenue,
      })));

      if (!campaignFilter) {
        setAllCampaigns(Object.keys(campMap));
      }

      // タイムライン（日別集計）
      const dayMap: Record<string, { sent: number; success: number; error: number; converted: number }> = {};
      items.forEach(i => {
        const d = (i.created_at || '').slice(0, 10);
        if (!d) return;
        if (!dayMap[d]) dayMap[d] = { sent: 0, success: 0, error: 0, converted: 0 };
        dayMap[d].sent++;
        if (i.status === 'success') { dayMap[d].success++; dayMap[d].converted++; }
        if (i.status === 'error') dayMap[d].error++;
      });
      setTimeline(Object.entries(dayMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v })));

    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'データ取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, [selectedAccount, session, daysWindow, campaignFilter, sb]);

  useEffect(() => {
    if (tab === 'dm') loadEffectiveness();
  }, [tab, loadEffectiveness]);

  // ファネル分析データ取得
  const loadFunnel = useCallback(async () => {
    if (!selectedAccount) return;
    setFunnelLoading(true);

    try {
      // 課金ユーザー
      const { data: payingData } = await sb.from('paying_users')
        .select('user_name, total_tokens, last_paid, first_paid, tx_count')
        .eq('account_id', selectedAccount);

      const segs: Record<string, any[]> = { whale: [], regular: [], light: [], free: [] };
      const payingNames = new Set<string>();
      for (const u of (payingData || [])) {
        payingNames.add(u.user_name);
        const t = u.total_tokens || 0;
        if (t >= 1000) segs.whale.push(u);
        else if (t >= 100) segs.regular.push(u);
        else if (t >= 10) segs.light.push(u);
        else segs.free.push(u);
      }

      // チャットユーザー（Lead検出）
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: chatData } = await sb.from('spy_messages')
        .select('user_name')
        .eq('account_id', selectedAccount)
        .eq('msg_type', 'chat')
        .gte('message_time', since)
        .limit(2000);

      const chatOnly = new Set<string>();
      for (const m of (chatData || [])) {
        if (m.user_name && !payingNames.has(m.user_name)) {
          chatOnly.add(m.user_name);
        }
      }

      // キャスト除外
      const { data: acctData } = await sb.from('accounts')
        .select('cast_usernames')
        .eq('id', selectedAccount)
        .single();
      const castNames = new Set<string>(acctData?.cast_usernames || []);
      const leadNames = Array.from(chatOnly).filter(n => !castNames.has(n));

      // user_level取得（spy_messagesから最新）
      const { data: levelData } = await sb.from('spy_messages')
        .select('user_name, user_level')
        .eq('account_id', selectedAccount)
        .not('user_level', 'is', null)
        .order('message_time', { ascending: false })
        .limit(2000);

      const levelMap = new Map<string, number>();
      for (const r of (levelData || [])) {
        if (r.user_name && r.user_level != null && !levelMap.has(r.user_name)) {
          levelMap.set(r.user_name, r.user_level);
        }
      }

      // セグメントデータ
      const tokSum = (arr: any[]) => arr.reduce((s: number, u: any) => s + (u.total_tokens || 0), 0);
      setFunnelSegments([
        { key: 'whale', label: 'Whale (1000+ tk)', count: segs.whale.length, tokens: tokSum(segs.whale), color: '#ef4444' },
        { key: 'regular', label: 'Regular (100-999)', count: segs.regular.length, tokens: tokSum(segs.regular), color: '#f59e0b' },
        { key: 'light', label: 'Light (10-99)', count: segs.light.length, tokens: tokSum(segs.light), color: '#38bdf8' },
        { key: 'free', label: 'Free (0-9)', count: segs.free.length, tokens: tokSum(segs.free), color: '#94a3b8' },
        { key: 'lead', label: 'Lead (チャットのみ)', count: leadNames.length, tokens: 0, color: '#64748b' },
      ]);

      // ユーザーリスト
      const users: FunnelUser[] = [];
      const addUsers = (arr: any[], seg: string, label: string, color: string) => {
        for (const u of arr) {
          users.push({
            user_name: u.user_name,
            total_tokens: u.total_tokens || 0,
            segment: seg,
            segmentLabel: label,
            segmentColor: color,
            last_paid: u.last_paid,
            tx_count: u.tx_count,
            user_level: levelMap.get(u.user_name),
          });
        }
      };
      addUsers(segs.whale, 'whale', 'Whale', '#ef4444');
      addUsers(segs.regular, 'regular', 'Regular', '#f59e0b');
      addUsers(segs.light, 'light', 'Light', '#38bdf8');
      addUsers(segs.free, 'free', 'Free', '#94a3b8');
      for (const name of leadNames.slice(0, 100)) {
        users.push({
          user_name: name,
          total_tokens: 0,
          segment: 'lead',
          segmentLabel: 'Lead',
          segmentColor: '#64748b',
          user_level: levelMap.get(name),
        });
      }
      setFunnelUsers(users);
    } finally {
      setFunnelLoading(false);
    }
  }, [selectedAccount, sb]);

  useEffect(() => {
    if (tab === 'funnel') loadFunnel();
  }, [tab, loadFunnel]);

  if (!user) return null;

  // ============================================================
  // Render helpers
  // ============================================================
  const maxTimelineSent = Math.max(...timeline.map((d) => d.sent), 1);
  const maxTimelineConverted = Math.max(...timeline.map((d) => d.converted), 1);

  return (
    <div className="max-w-[1200px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Analytics</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            売上分析・DM効果測定
          </p>
        </div>
        {(tab === 'dm' || tab === 'funnel') && accounts.length > 0 && (
          <select
            className="input-glass text-xs px-3 py-2 w-48"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.account_name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Tab Switch */}
      <div className="flex gap-1">
        {([
          { key: 'dm' as const, label: 'DM効果測定' },
          { key: 'funnel' as const, label: 'ファネル分析' },
          { key: 'payroll' as const, label: '給与計算' },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-all ${
              tab === t.key
                ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ============ DM効果測定 Tab ============ */}
      {tab === 'dm' && (
        <div className="space-y-6 anim-fade-up">
          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>測定期間</label>
              <select
                className="input-glass text-xs px-3 py-2 w-28"
                value={daysWindow}
                onChange={(e) => setDaysWindow(Number(e.target.value))}
              >
                <option value={7}>7日間</option>
                <option value={14}>14日間</option>
                <option value={30}>30日間</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>キャンペーン</label>
              <select
                className="input-glass text-xs px-3 py-2 w-48"
                value={campaignFilter}
                onChange={(e) => setCampaignFilter(e.target.value)}
              >
                <option value="">全キャンペーン</option>
                {allCampaigns.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="glass-card p-4 border-rose-500/30 text-rose-400 text-xs">{error}</div>
          )}

          {/* Loading */}
          {loading && (
            <div className="grid grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="glass-card p-5 h-28 animate-pulse" />
              ))}
            </div>
          )}

          {/* Summary Cards */}
          {!loading && summary && (
            <div className="grid grid-cols-4 gap-4">
              <div className="glass-card p-5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>DM送信数</p>
                <p className="text-3xl font-bold mt-2 text-sky-400">{summary.total_sent.toLocaleString()}</p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>成功済み</p>
              </div>
              <div className="glass-card p-5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>再課金率</p>
                <p className={`text-3xl font-bold mt-2 ${
                  summary.conversion_rate >= 10 ? 'text-emerald-400' :
                  summary.conversion_rate >= 5 ? 'text-amber-400' : 'text-slate-300'
                }`}>
                  {summary.conversion_rate}%
                </p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {summary.total_converted}人が再課金
                </p>
              </div>
              <div className="glass-card p-5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>DM後 売上</p>
                <p className="text-3xl font-bold mt-2 text-emerald-400">
                  {tokensToJPY(summary.total_revenue_after_dm)}
                </p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {summary.total_revenue_after_dm.toLocaleString()} tk
                </p>
              </div>
              <div className="glass-card p-5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>1人あたり平均</p>
                <p className="text-3xl font-bold mt-2 text-violet-400">
                  {tokensToJPY(summary.avg_revenue_per_converted)}
                </p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {summary.avg_revenue_per_converted.toLocaleString()} tk
                </p>
              </div>
            </div>
          )}

          {/* Campaign Comparison Table (AB Test) */}
          {!loading && byCampaign.length > 0 && (
            <div className="glass-card p-6">
              <h3 className="text-sm font-semibold mb-4">
                キャンペーン別比較（ABテスト）
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                      <th className="pb-3 font-medium text-xs">キャンペーン</th>
                      <th className="pb-3 font-medium text-xs text-right">送信数</th>
                      <th className="pb-3 font-medium text-xs text-right">再課金</th>
                      <th className="pb-3 font-medium text-xs text-right">CVR</th>
                      <th className="pb-3 font-medium text-xs text-right">売上 (tk)</th>
                      <th className="pb-3 font-medium text-xs">CVR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCampaign.map((r, i) => {
                      const maxRate = Math.max(...byCampaign.map((c) => c.rate), 1);
                      const barWidth = (r.rate / maxRate) * 100;
                      return (
                        <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                          <td className="py-3">
                            <span className="text-xs font-mono px-2 py-1 rounded bg-white/[0.03]">
                              {r.campaign || '(未設定)'}
                            </span>
                          </td>
                          <td className="py-3 text-right tabular-nums">{r.sent}</td>
                          <td className="py-3 text-right tabular-nums text-emerald-400">{r.converted}</td>
                          <td className="py-3 text-right tabular-nums font-semibold">
                            <span className={
                              r.rate >= 10 ? 'text-emerald-400' :
                              r.rate >= 5 ? 'text-amber-400' : 'text-slate-300'
                            }>
                              {r.rate}%
                            </span>
                          </td>
                          <td className="py-3 text-right tabular-nums text-emerald-400">
                            {r.revenue.toLocaleString()}
                          </td>
                          <td className="py-3 w-32">
                            <div className="h-2 rounded-full bg-white/[0.04] overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{
                                  width: `${barWidth}%`,
                                  background: r.rate >= 10
                                    ? 'linear-gradient(90deg, #22c55e, #16a34a)'
                                    : r.rate >= 5
                                    ? 'linear-gradient(90deg, #f59e0b, #d97706)'
                                    : 'linear-gradient(90deg, #64748b, #475569)',
                                }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!loading && summary && summary.total_sent === 0 && (
            <div className="glass-card p-10 text-center">
              <p className="text-lg mb-2" style={{ color: 'var(--text-secondary)' }}>
                DM送信データがありません
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                DMページからメッセージを送信すると、ここに効果測定データが表示されます。
              </p>
            </div>
          )}

          {/* Timeline Chart */}
          {!loading && timeline.length > 0 && (
            <div className="glass-card p-6">
              <h3 className="text-sm font-semibold mb-4">日別推移（直近30日）</h3>

              {/* Legend */}
              <div className="flex items-center gap-4 mb-4 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(56,189,248,0.6)' }} /> 送信数
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(34,197,94,0.6)' }} /> 成功
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(244,63,94,0.6)' }} /> エラー
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full border-2 border-amber-400" /> 再課金
                </span>
              </div>

              {/* Bar + Line Chart */}
              <div className="relative" style={{ height: '220px' }}>
                <div className="flex items-end gap-[2px] h-full">
                  {timeline.map((day, i) => {
                    const barH = (day.sent / maxTimelineSent) * 180;
                    const successH = (day.success / maxTimelineSent) * 180;
                    const errorH = (day.error / maxTimelineSent) * 180;
                    const convertedY = maxTimelineConverted > 0
                      ? 180 - (day.converted / maxTimelineConverted) * 160
                      : 180;

                    return (
                      <div
                        key={i}
                        className="flex-1 flex flex-col items-center justify-end relative group"
                        style={{ minWidth: 0 }}
                      >
                        {/* Tooltip */}
                        <div className="absolute bottom-full mb-2 hidden group-hover:block z-10 pointer-events-none">
                          <div className="glass-card p-2 text-[10px] whitespace-nowrap" style={{ background: '#0f172a', border: '1px solid rgba(56,189,248,0.2)' }}>
                            <p className="font-semibold">{day.date}</p>
                            <p>送信: {day.sent} / 成功: {day.success}</p>
                            <p>エラー: {day.error} / 再課金: {day.converted}</p>
                          </div>
                        </div>

                        {/* Stacked Bar */}
                        <div className="w-full flex flex-col items-center justify-end" style={{ height: '180px' }}>
                          {day.error > 0 && (
                            <div
                              className="w-full rounded-t-sm"
                              style={{
                                height: `${Math.max(errorH, 2)}px`,
                                background: 'rgba(244,63,94,0.5)',
                              }}
                            />
                          )}
                          {day.success > 0 && (
                            <div
                              className="w-full"
                              style={{
                                height: `${Math.max(successH, 2)}px`,
                                background: 'rgba(34,197,94,0.5)',
                                borderRadius: day.error > 0 ? '0' : '2px 2px 0 0',
                              }}
                            />
                          )}
                          {day.sent > day.success + day.error && (
                            <div
                              className="w-full"
                              style={{
                                height: `${Math.max(barH - successH - errorH, 1)}px`,
                                background: 'rgba(56,189,248,0.3)',
                              }}
                            />
                          )}
                        </div>

                        {/* Conversion dot (overlay) */}
                        {day.converted > 0 && (
                          <div
                            className="absolute w-2 h-2 rounded-full bg-amber-400 border border-amber-300"
                            style={{
                              bottom: `${180 - convertedY + 20}px`,
                              left: '50%',
                              transform: 'translateX(-50%)',
                              boxShadow: '0 0 6px rgba(245,158,11,0.5)',
                            }}
                          />
                        )}

                        {/* Date label (every 5th) */}
                        {(i % 5 === 0 || i === timeline.length - 1) && (
                          <p className="text-[8px] mt-1 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                            {day.date.slice(5)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============ ファネル分析 Tab ============ */}
      {tab === 'funnel' && (
        <div className="space-y-6 anim-fade-up">
          {/* Loading */}
          {funnelLoading && (
            <div className="grid grid-cols-5 gap-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="glass-card p-4 h-24 animate-pulse" />
              ))}
            </div>
          )}

          {!funnelLoading && funnelSegments.length > 0 && (
            <>
              {/* Funnel Visual */}
              <div className="glass-card p-6">
                <h3 className="text-sm font-semibold mb-4">ユーザーファネル</h3>
                <div className="flex flex-col items-center gap-1">
                  {[...funnelSegments].reverse().map((seg) => {
                    const maxCount = Math.max(...funnelSegments.map(s => s.count), 1);
                    const widthPct = Math.max((seg.count / maxCount) * 100, 20);
                    const totalAll = funnelSegments.reduce((s, x) => s + x.count, 0);
                    const pct = totalAll > 0 ? ((seg.count / totalAll) * 100).toFixed(1) : '0';

                    return (
                      <div
                        key={seg.key}
                        className="relative flex items-center justify-center py-3 rounded-lg transition-all cursor-pointer hover:brightness-125"
                        style={{
                          width: `${widthPct}%`,
                          minWidth: '240px',
                          background: `${seg.color}20`,
                          borderLeft: `3px solid ${seg.color}`,
                        }}
                        onClick={() => setFunnelFilter(seg.key === funnelFilter ? 'all' : seg.key)}
                      >
                        <div className="flex items-center gap-3 text-xs">
                          <span className="font-semibold" style={{ color: seg.color }}>{seg.label}</span>
                          <span className="tabular-nums font-bold text-lg" style={{ color: seg.color }}>
                            {seg.count}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>({pct}%)</span>
                          {seg.tokens > 0 && (
                            <span className="text-emerald-400 text-[10px]">{seg.tokens.toLocaleString()} tk</span>
                          )}
                        </div>
                        {funnelFilter === seg.key && (
                          <div className="absolute right-3 w-2 h-2 rounded-full" style={{ background: seg.color }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Conversion Cards */}
              <div className="grid grid-cols-4 gap-4">
                {(() => {
                  const totalAll = funnelSegments.reduce((s, x) => s + x.count, 0);
                  const totalPayers = totalAll - (funnelSegments.find(s => s.key === 'lead')?.count || 0);
                  const whaleCount = funnelSegments.find(s => s.key === 'whale')?.count || 0;
                  const totalTokens = funnelSegments.reduce((s, x) => s + x.tokens, 0);
                  const whaleTokens = funnelSegments.find(s => s.key === 'whale')?.tokens || 0;

                  return [
                    {
                      label: '課金転換率',
                      value: totalAll > 0 ? `${(totalPayers / totalAll * 100).toFixed(1)}%` : '0%',
                      sub: `${totalPayers} / ${totalAll} ユーザー`,
                      color: 'text-emerald-400',
                    },
                    {
                      label: 'Whale比率',
                      value: totalPayers > 0 ? `${(whaleCount / totalPayers * 100).toFixed(1)}%` : '0%',
                      sub: `${whaleCount} Whale / ${totalPayers} 課金者`,
                      color: 'text-rose-400',
                    },
                    {
                      label: 'Whale売上集中度',
                      value: totalTokens > 0 ? `${(whaleTokens / totalTokens * 100).toFixed(1)}%` : '0%',
                      sub: `${whaleTokens.toLocaleString()} / ${totalTokens.toLocaleString()} tk`,
                      color: 'text-amber-400',
                    },
                    {
                      label: 'Lead→課金ポテンシャル',
                      value: `${funnelSegments.find(s => s.key === 'lead')?.count || 0}`,
                      sub: 'DM未送信のチャットユーザー',
                      color: 'text-sky-400',
                    },
                  ];
                })().map((card, i) => (
                  <div key={i} className="glass-card p-5">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{card.label}</p>
                    <p className={`text-3xl font-bold mt-2 ${card.color}`}>{card.value}</p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>{card.sub}</p>
                  </div>
                ))}
              </div>

              {/* User Table */}
              <div className="glass-card p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold">ユーザー一覧</h3>
                  <div className="flex gap-1">
                    {['all', 'whale', 'regular', 'light', 'free', 'lead'].map((f) => (
                      <button
                        key={f}
                        onClick={() => setFunnelFilter(f)}
                        className={`px-3 py-1.5 rounded text-[10px] font-medium transition-all ${
                          funnelFilter === f
                            ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {f === 'all' ? '全て' : f.charAt(0).toUpperCase() + f.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                        <th className="pb-3 font-medium text-xs">ユーザー名</th>
                        <th className="pb-3 font-medium text-xs">セグメント</th>
                        <th className="pb-3 font-medium text-xs text-right">累計トークン</th>
                        <th className="pb-3 font-medium text-xs text-right">取引回数</th>
                        <th className="pb-3 font-medium text-xs text-right">最終課金</th>
                      </tr>
                    </thead>
                    <tbody>
                      {funnelUsers
                        .filter(u => funnelFilter === 'all' || u.segment === funnelFilter)
                        .slice(0, 50)
                        .map((u, i) => (
                          <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                            <td className="py-3">
                              <span
                                className="font-medium text-xs"
                                style={{ color: u.user_level ? getUserLeagueColor(u.user_level) : 'inherit' }}
                              >
                                {u.user_name}
                              </span>
                            </td>
                            <td className="py-3">
                              <span
                                className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                                style={{ background: `${u.segmentColor}20`, color: u.segmentColor }}
                              >
                                {u.segmentLabel}
                              </span>
                            </td>
                            <td className="py-3 text-right tabular-nums text-emerald-400">
                              {u.total_tokens > 0 ? u.total_tokens.toLocaleString() : '-'}
                            </td>
                            <td className="py-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                              {u.tx_count ?? '-'}
                            </td>
                            <td className="py-3 text-right text-xs" style={{ color: 'var(--text-muted)' }}>
                              {u.last_paid ? new Date(u.last_paid).toLocaleDateString('ja-JP') : '-'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                {funnelUsers.filter(u => funnelFilter === 'all' || u.segment === funnelFilter).length === 0 && (
                  <p className="text-center py-8 text-xs" style={{ color: 'var(--text-muted)' }}>
                    データがありません
                  </p>
                )}
              </div>
            </>
          )}

          {/* Empty state */}
          {!funnelLoading && funnelSegments.length === 0 && (
            <div className="glass-card p-10 text-center">
              <p className="text-lg mb-2" style={{ color: 'var(--text-secondary)' }}>
                ファネルデータがありません
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                SPYでチャットデータを収集するか、CSVをインポートしてください。
              </p>
            </div>
          )}
        </div>
      )}

      {/* ============ Payroll Tab (既存モック) ============ */}
      {tab === 'payroll' && (
        <div className="space-y-6 anim-fade-up">
          {/* Stats Row */}
          <div className="grid grid-cols-3 gap-4">
            {payrollStats.map((s, i) => (
              <div key={i} className="glass-card p-5">
                <div className="flex items-center justify-between">
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.label}</p>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    s.positive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                  }`}>{s.change}</span>
                </div>
                <p className="text-3xl font-bold mt-2 tracking-tight" style={{ color: 'var(--accent-green)' }}>
                  {s.value}
                </p>
              </div>
            ))}
          </div>

          {/* Payroll Table */}
          <div className="glass-card p-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                    <th className="pb-4 font-medium text-xs">キャスト名</th>
                    <th className="pb-4 font-medium text-xs">総売上</th>
                    <th className="pb-4 font-medium text-xs">紹介料率 (%)</th>
                    <th className="pb-4 font-medium text-xs">最終支払額</th>
                    <th className="pb-4 font-medium text-xs">源泉徴収・調整</th>
                    <th className="pb-4 font-medium text-xs">ステータス</th>
                  </tr>
                </thead>
                <tbody>
                  {castPayroll.map((c, i) => (
                    <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                      <td className="py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm"
                            style={{ background: 'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(168,85,247,0.2))' }}>
                            {c.name.charAt(0)}
                          </div>
                          <div>
                            <p className="font-semibold">{c.name}</p>
                            <p className={`text-[10px] ${c.tier === 'PREMIUM CAST' ? 'text-amber-400' : ''}`}
                              style={c.tier !== 'PREMIUM CAST' ? { color: 'var(--text-muted)' } : {}}>
                              {c.tier}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-4 font-semibold text-emerald-400">{c.revenue}</td>
                      <td className="py-4" style={{ color: 'var(--text-secondary)' }}>{c.rate}</td>
                      <td className="py-4 font-semibold">{c.payout}</td>
                      <td className="py-4 text-rose-400">{c.adj}</td>
                      <td className="py-4">
                        <span className="text-xs px-2.5 py-1 rounded-full"
                          style={{ background: `${c.statusColor}15`, color: c.statusColor }}>
                          {c.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
