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
   Page
   ============================================================ */
const exportCSV = (data: Record<string, unknown>[], filename: string) => {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const csv = [headers.join(','), ...data.map(row => headers.map(h => JSON.stringify(row[h] ?? '')).join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${filename}_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
};

export default function AnalyticsPage() {
  const { user, session } = useAuth();
  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [tab, setTab] = useState<'monthly_pl' | 'dm' | 'funnel'>('dm');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');

  // DM効果測定 state
  const [daysWindow, setDaysWindow] = useState<number | 'custom'>(7);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('');
  const [summary, setSummary] = useState<EffectivenessSummary | null>(null);
  const [byCampaign, setByCampaign] = useState<CampaignRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allCampaigns, setAllCampaigns] = useState<string[]>([]);
  const [dmCastFilter, setDmCastFilter] = useState<string>('');

  // ファネル分析 state
  const [funnelSegments, setFunnelSegments] = useState<FunnelSegment[]>([]);
  const [funnelUsers, setFunnelUsers] = useState<FunnelUser[]>([]);
  const [funnelLoading, setFunnelLoading] = useState(false);
  const [funnelFilter, setFunnelFilter] = useState<string>('all');
  const [funnelCastFilter, setFunnelCastFilter] = useState<string>('');
  const [funnelCasts, setFunnelCasts] = useState<string[]>([]);

  // 月次P/L state
  interface MonthlyPL {
    month: string;
    cast_name: string;
    total_sessions: number;
    total_hours: number;
    total_tokens: number;
    gross_revenue_jpy: number;
    platform_fee_jpy: number;
    net_revenue_jpy: number;
    total_cast_cost_jpy: number;
    monthly_fixed_cost_jpy: number;
    gross_profit_jpy: number;
    profit_margin: number;
  }
  const [monthlyPL, setMonthlyPL] = useState<MonthlyPL[]>([]);
  const [plMonths, setPlMonths] = useState(6);
  const [plCastFilter, setPlCastFilter] = useState('');
  const [plLoading, setPlLoading] = useState(false);
  const [plError, setPlError] = useState<string | null>(null);
  const [plCasts, setPlCasts] = useState<string[]>([]);

  // アカウント取得
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id, account_name').order('created_at').then(({ data }) => {
      const list = data || [];
      setAccounts(list);
      if (list.length > 0) setSelectedAccount(list[0].id);
    });
  }, [user, sb]);

  // ファネル用キャスト一覧取得
  useEffect(() => {
    if (!selectedAccount) return;
    sb.from('registered_casts')
      .select('cast_name')
      .eq('account_id', selectedAccount)
      .eq('is_active', true)
      .then(({ data }) => {
        setFunnelCasts((data || []).map((r: { cast_name: string }) => r.cast_name).sort());
      });
  }, [selectedAccount, sb]);

  // DM効果測定データ取得
  const loadEffectiveness = useCallback(async () => {
    if (!selectedAccount || !session) return;
    setLoading(true);
    setError(null);
    try {
      const since = daysWindow === 'custom' && customStart
        ? new Date(customStart).toISOString()
        : new Date(Date.now() - (typeof daysWindow === 'number' ? daysWindow : 7) * 86400000).toISOString();
      const until = daysWindow === 'custom' && customEnd
        ? new Date(customEnd + 'T23:59:59').toISOString()
        : undefined;

      // DM送信ログ取得
      let query = sb.from('dm_send_log')
        .select('*')
        .eq('account_id', selectedAccount)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50000);

      if (until) {
        query = query.lte('created_at', until);
      }

      if (dmCastFilter) {
        query = query.eq('cast_name', dmCastFilter);
      }

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
  }, [selectedAccount, session, daysWindow, campaignFilter, dmCastFilter, customStart, customEnd, sb]);

  useEffect(() => {
    if (tab === 'dm') loadEffectiveness();
  }, [tab, loadEffectiveness]);

  // ファネル分析データ取得
  const loadFunnel = useCallback(async () => {
    if (!selectedAccount) return;
    setFunnelLoading(true);

    try {
      // 応援ユーザー
      let payingQuery = sb.from('paying_users')
        .select('user_name, total_tokens, last_paid, first_paid, tx_count')
        .eq('account_id', selectedAccount);
      if (funnelCastFilter) {
        payingQuery = payingQuery.eq('cast_name', funnelCastFilter);
      }
      const { data: payingData } = await payingQuery.limit(50000);

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
      let chatQuery = sb.from('spy_messages')
        .select('user_name')
        .eq('account_id', selectedAccount)
        .eq('msg_type', 'chat')
        .gte('message_time', since);
      if (funnelCastFilter) {
        chatQuery = chatQuery.eq('cast_name', funnelCastFilter);
      }
      const { data: chatData } = await chatQuery.limit(50000);

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
      let levelQuery = sb.from('spy_messages')
        .select('user_name, user_level')
        .eq('account_id', selectedAccount)
        .filter('user_level', 'not.is', null);
      if (funnelCastFilter) {
        levelQuery = levelQuery.eq('cast_name', funnelCastFilter);
      }
      const { data: levelData } = await levelQuery
        .order('message_time', { ascending: false })
        .limit(50000);

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
  }, [selectedAccount, funnelCastFilter, sb]);

  useEffect(() => {
    if (tab === 'funnel') loadFunnel();
  }, [tab, loadFunnel]);

  // 月次P/Lデータ取得
  const loadMonthlyPL = useCallback(async () => {
    if (!selectedAccount) return;
    setPlLoading(true);
    setPlError(null);
    try {
      const { data, error } = await sb.rpc('get_monthly_pl', {
        p_account_id: selectedAccount,
        p_cast_name: plCastFilter || null,
        p_months: plMonths,
      });
      if (error) throw error;
      const rows = (data || []) as MonthlyPL[];
      setMonthlyPL(rows);
      // Extract unique cast names
      setPlCasts(Array.from(new Set(rows.map(r => r.cast_name))).sort());
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: string }).message) : '';
      if (msg.includes('cast_cost_settings')) {
        setPlError('コスト設定がありません。設定 → コスト設定タブでキャストのコストを登録してください。');
      } else if (msg.includes('could not find') || msg.includes('schema cache')) {
        setPlError('P/L集計関数が未登録です。管理者にマイグレーション 082 の適用を依頼してください。');
      } else {
        setPlError(msg || 'データ取得に失敗しました');
      }
      setMonthlyPL([]);
    } finally {
      setPlLoading(false);
    }
  }, [selectedAccount, plCastFilter, plMonths, sb]);

  useEffect(() => {
    if (tab === 'monthly_pl') loadMonthlyPL();
  }, [tab, loadMonthlyPL]);

  if (!user) return null;

  // ============================================================
  // Render helpers
  // ============================================================
  const maxTimelineSent = Math.max(...timeline.map((d) => d.sent), 1);

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
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.location.href = '/analytics/compare'}
            className="btn-ghost text-xs flex items-center gap-1.5"
          >
            📊 キャスト比較
          </button>
        {(tab === 'dm' || tab === 'funnel' || tab === 'monthly_pl') && accounts.length > 0 && (
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
      </div>

      {/* Tab Switch */}
      <div className="flex gap-1">
        {([
          { key: 'dm' as const, label: 'DM効果測定' },
          { key: 'funnel' as const, label: 'ファネル分析' },
          { key: 'monthly_pl' as const, label: '月次P/L' },
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
                onChange={(e) => setDaysWindow(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}
              >
                <option value={7}>7日間</option>
                <option value={14}>14日間</option>
                <option value={30}>30日間</option>
                <option value="custom">カスタム</option>
              </select>
            </div>
            {daysWindow === 'custom' && (
              <>
                <div>
                  <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>開始日</label>
                  <input
                    type="date"
                    className="input-glass text-xs px-3 py-2 w-36"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>終了日</label>
                  <input
                    type="date"
                    className="input-glass text-xs px-3 py-2 w-36"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </div>
              </>
            )}
            <div>
              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>キャスト</label>
              <select
                className="input-glass text-xs px-3 py-2 w-36"
                value={dmCastFilter}
                onChange={(e) => setDmCastFilter(e.target.value)}
              >
                <option value="">全キャスト</option>
                {funnelCasts.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
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
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="glass-card p-5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>DM送信数</p>
                <p className="text-3xl font-bold mt-2 text-sky-400">{summary.total_sent.toLocaleString()}</p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>成功済み</p>
              </div>
              <div className="glass-card p-5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>再応援率</p>
                <p className={`text-3xl font-bold mt-2 ${
                  summary.conversion_rate >= 10 ? 'text-emerald-400' :
                  summary.conversion_rate >= 5 ? 'text-amber-400' : 'text-slate-300'
                }`}>
                  {summary.conversion_rate.toFixed(1)}%
                </p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {summary.total_converted}人が再応援
                </p>
              </div>
              {summary.total_revenue_after_dm > 0 && (
              <div className="glass-card p-5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>DM後 売上</p>
                <p className="text-3xl font-bold mt-2 text-emerald-400">
                  {tokensToJPY(summary.total_revenue_after_dm)}
                </p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {summary.total_revenue_after_dm.toLocaleString()} tk
                </p>
              </div>
              )}
              {summary.avg_revenue_per_converted > 0 && (
              <div className="glass-card p-5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>1人あたり平均</p>
                <p className="text-3xl font-bold mt-2 text-violet-400">
                  {tokensToJPY(summary.avg_revenue_per_converted)}
                </p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {summary.avg_revenue_per_converted.toLocaleString()} tk
                </p>
              </div>
              )}
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

          {/* Campaign Table + Timeline Chart in 2-column layout */}
          {!loading && (byCampaign.length > 0 || timeline.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Campaign Comparison Table (AB Test) */}
              {byCampaign.length > 0 && (
                <div className="glass-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold">
                      キャンペーン別比較
                    </h3>
                    <button
                      onClick={() => exportCSV(byCampaign.map(r => ({
                        キャンペーン: r.campaign,
                        送信数: r.sent,
                        成功: r.converted,
                        CVR: `${r.rate.toFixed(1)}%`,
                      })), 'dm_campaign_comparison')}
                      className="btn-ghost text-[10px] px-3 py-1.5"
                    >
                      CSV
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                          <th className="pb-3 font-medium text-xs">キャンペーン</th>
                          <th className="pb-3 font-medium text-xs text-right">送信</th>
                          <th className="pb-3 font-medium text-xs text-right">成功</th>
                          <th className="pb-3 font-medium text-xs text-right">CVR</th>
                          <th className="pb-3 font-medium text-xs w-24"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {byCampaign.map((r, i) => {
                          const maxRate = Math.max(...byCampaign.map((c) => c.rate), 1);
                          const barWidth = (r.rate / maxRate) * 100;
                          return (
                            <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                              <td className="py-2">
                                <span className="text-xs font-mono px-2 py-0.5 rounded bg-white/[0.03] truncate inline-block max-w-[140px]">
                                  {r.campaign || '(未設定)'}
                                </span>
                              </td>
                              <td className="py-2 text-right tabular-nums text-xs">{r.sent}</td>
                              <td className="py-2 text-right tabular-nums text-xs text-emerald-400">{r.converted}</td>
                              <td className="py-2 text-right tabular-nums text-xs font-semibold">
                                <span className={
                                  r.rate >= 10 ? 'text-emerald-400' :
                                  r.rate >= 5 ? 'text-amber-400' : 'text-slate-300'
                                }>
                                  {r.rate.toFixed(1)}%
                                </span>
                              </td>
                              <td className="py-2 w-24">
                                <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
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

              {/* Timeline Chart */}
              {timeline.length > 0 && (
                <div className="glass-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold">日別推移</h3>
                    <button
                      onClick={() => exportCSV(timeline.map(d => ({
                        日付: d.date,
                        送信数: d.sent,
                        成功: d.success,
                        エラー: d.error,
                        再応援: d.converted,
                      })), 'dm_timeline')}
                      className="btn-ghost text-[10px] px-3 py-1.5"
                    >
                      CSV
                    </button>
                  </div>

                  {/* Legend */}
                  <div className="flex items-center gap-3 mb-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'rgba(56,189,248,0.6)' }} /> 送信
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'rgba(34,197,94,0.6)' }} /> 成功
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'rgba(244,63,94,0.6)' }} /> エラー
                    </span>
                  </div>

                  {/* Bar Chart */}
                  <div className="relative" style={{ height: '180px' }}>
                    <div className="flex items-end gap-[2px] h-full">
                      {timeline.map((day, i) => {
                        const barH = (day.sent / maxTimelineSent) * 150;
                        const successH = (day.success / maxTimelineSent) * 150;
                        const errorH = (day.error / maxTimelineSent) * 150;

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
                                <p>エラー: {day.error}</p>
                              </div>
                            </div>

                            {/* Stacked Bar */}
                            <div className="w-full flex flex-col items-center justify-end" style={{ height: '150px' }}>
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
        </div>
      )}

      {/* ============ ファネル分析 Tab ============ */}
      {tab === 'funnel' && (
        <div className="space-y-6 anim-fade-up">
          {/* Cast Filter */}
          {funnelCasts.length > 0 && (
            <div className="flex items-center gap-3">
              <div>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>キャスト</label>
                <select
                  className="input-glass text-xs px-3 py-2 w-48"
                  value={funnelCastFilter}
                  onChange={(e) => setFunnelCastFilter(e.target.value)}
                >
                  <option value="">全キャスト</option>
                  {funnelCasts.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

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
                      label: '応援転換率',
                      value: totalAll > 0 ? `${(totalPayers / totalAll * 100).toFixed(1)}%` : '0%',
                      sub: `${totalPayers} / ${totalAll} ユーザー`,
                      color: 'text-emerald-400',
                    },
                    {
                      label: 'Whale比率',
                      value: totalPayers > 0 ? `${(whaleCount / totalPayers * 100).toFixed(1)}%` : '0%',
                      sub: `${whaleCount} Whale / ${totalPayers} サポーター`,
                      color: 'text-rose-400',
                    },
                    {
                      label: 'Whale売上集中度',
                      value: totalTokens > 0 ? `${(whaleTokens / totalTokens * 100).toFixed(1)}%` : '0%',
                      sub: `${whaleTokens.toLocaleString()} / ${totalTokens.toLocaleString()} tk`,
                      color: 'text-amber-400',
                    },
                    {
                      label: 'Lead→応援ポテンシャル',
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
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => exportCSV(
                        funnelUsers
                          .filter(u => funnelFilter === 'all' || u.segment === funnelFilter)
                          .map(u => ({
                            ユーザー名: u.user_name,
                            セグメント: u.segmentLabel,
                            累計トークン: u.total_tokens,
                            取引回数: u.tx_count ?? '',
                            最終応援: u.last_paid ? new Date(u.last_paid).toLocaleDateString('ja-JP') : '',
                          })),
                        'funnel_users'
                      )}
                      className="btn-ghost text-[10px] px-3 py-1.5"
                    >
                      CSVエクスポート
                    </button>
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
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                        <th className="pb-3 font-medium text-xs">ユーザー名</th>
                        <th className="pb-3 font-medium text-xs">セグメント</th>
                        <th className="pb-3 font-medium text-xs text-right">累計トークン</th>
                        <th className="pb-3 font-medium text-xs text-right">取引回数</th>
                        <th className="pb-3 font-medium text-xs text-right">最終応援</th>
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

      {/* ============ 月次P/L Tab ============ */}
      {tab === 'monthly_pl' && (
        <div className="space-y-6 anim-fade-up">
          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>期間</label>
              <select
                className="input-glass text-xs px-3 py-2 w-28"
                value={plMonths}
                onChange={(e) => setPlMonths(Number(e.target.value))}
              >
                <option value={3}>3ヶ月</option>
                <option value={6}>6ヶ月</option>
                <option value={12}>12ヶ月</option>
              </select>
            </div>
            {plCasts.length > 1 && (
              <div>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>キャスト</label>
                <select
                  className="input-glass text-xs px-3 py-2 w-36"
                  value={plCastFilter}
                  onChange={(e) => setPlCastFilter(e.target.value)}
                >
                  <option value="">全キャスト</option>
                  {plCasts.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Error */}
          {plError && (
            <div className="glass-card p-4 text-center" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <p className="text-xs" style={{ color: 'var(--accent-amber)' }}>{plError}</p>
              <button onClick={() => window.location.href = '/settings'} className="btn-ghost text-[10px] px-4 py-1.5 mt-2">
                設定画面へ
              </button>
            </div>
          )}

          {/* Loading */}
          {plLoading && (
            <div className="grid grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="glass-card p-5 h-28 animate-pulse" />
              ))}
            </div>
          )}

          {/* Summary Cards */}
          {!plLoading && !plError && monthlyPL.length > 0 && (() => {
            const latest = monthlyPL[0];
            const totalGrossProfit = monthlyPL
              .filter(r => r.month === latest.month)
              .reduce((s, r) => s + (r.gross_profit_jpy || 0), 0);
            const totalNetRevenue = monthlyPL
              .filter(r => r.month === latest.month)
              .reduce((s, r) => s + (r.net_revenue_jpy || 0), 0);
            const totalSessions = monthlyPL
              .filter(r => r.month === latest.month)
              .reduce((s, r) => s + r.total_sessions, 0);
            const totalHours = monthlyPL
              .filter(r => r.month === latest.month)
              .reduce((s, r) => s + r.total_hours, 0);
            const isProfit = totalGrossProfit >= 0;

            return (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="glass-card p-5">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ネット売上（{latest.month}）</p>
                  <p className="text-2xl font-bold mt-2 text-emerald-400">{'\u00A5'}{Math.round(totalNetRevenue).toLocaleString()}</p>
                </div>
                <div className="glass-card p-5">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>粗利（{latest.month}）</p>
                  <p className={`text-2xl font-bold mt-2 ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {isProfit ? '' : '-'}{'\u00A5'}{Math.abs(Math.round(totalGrossProfit)).toLocaleString()}
                  </p>
                </div>
                <div className="glass-card p-5">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>配信数（{latest.month}）</p>
                  <p className="text-2xl font-bold mt-2 text-sky-400">{totalSessions}回</p>
                  <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>{totalHours.toFixed(1)}時間</p>
                </div>
                <div className="glass-card p-5">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>赤字/黒字比率</p>
                  {(() => {
                    const latestMonthRows = monthlyPL.filter(r => r.month === latest.month);
                    const profitCount = latestMonthRows.filter(r => r.gross_profit_jpy >= 0).length;
                    const lossCount = latestMonthRows.filter(r => r.gross_profit_jpy < 0).length;
                    return (
                      <>
                        <p className="text-2xl font-bold mt-2">
                          <span className="text-emerald-400">{profitCount}</span>
                          <span className="text-xs mx-1" style={{ color: 'var(--text-muted)' }}>/</span>
                          <span className="text-rose-400">{lossCount}</span>
                        </p>
                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>黒字/赤字キャスト</p>
                      </>
                    );
                  })()}
                </div>
              </div>
            );
          })()}

          {/* Monthly P/L Table */}
          {!plLoading && !plError && monthlyPL.length > 0 && (
            <div className="glass-card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">月次P/L明細</h3>
                <button
                  onClick={() => exportCSV(monthlyPL.map(r => ({
                    月: r.month,
                    キャスト: r.cast_name,
                    配信数: r.total_sessions,
                    時間: r.total_hours,
                    トークン: r.total_tokens,
                    粗売上: Math.round(r.gross_revenue_jpy),
                    手数料: Math.round(r.platform_fee_jpy),
                    ネット売上: Math.round(r.net_revenue_jpy),
                    キャスト費用: Math.round(r.total_cast_cost_jpy),
                    固定費: r.monthly_fixed_cost_jpy,
                    粗利: Math.round(r.gross_profit_jpy),
                    粗利率: `${r.profit_margin}%`,
                  })), 'monthly_pl')}
                  className="btn-ghost text-[10px] px-3 py-1.5"
                >
                  CSVエクスポート
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                      <th className="pb-3 font-medium">月</th>
                      <th className="pb-3 font-medium">キャスト</th>
                      <th className="pb-3 font-medium text-right">配信</th>
                      <th className="pb-3 font-medium text-right">時間</th>
                      <th className="pb-3 font-medium text-right">ネット売上</th>
                      <th className="pb-3 font-medium text-right">キャスト費用</th>
                      <th className="pb-3 font-medium text-right">固定費</th>
                      <th className="pb-3 font-medium text-right">粗利</th>
                      <th className="pb-3 font-medium text-right">粗利率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyPL.map((r, i) => {
                      const isProfit = r.gross_profit_jpy >= 0;
                      return (
                        <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                          <td className="py-2.5 font-mono">{r.month}</td>
                          <td className="py-2.5" style={{ color: 'var(--accent-primary)' }}>{r.cast_name}</td>
                          <td className="py-2.5 text-right tabular-nums">{r.total_sessions}回</td>
                          <td className="py-2.5 text-right tabular-nums">{r.total_hours}h</td>
                          <td className="py-2.5 text-right tabular-nums text-emerald-400">{'\u00A5'}{Math.round(r.net_revenue_jpy).toLocaleString()}</td>
                          <td className="py-2.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{'\u00A5'}{Math.round(r.total_cast_cost_jpy).toLocaleString()}</td>
                          <td className="py-2.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{'\u00A5'}{r.monthly_fixed_cost_jpy.toLocaleString()}</td>
                          <td className={`py-2.5 text-right tabular-nums font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {isProfit ? '' : '-'}{'\u00A5'}{Math.abs(Math.round(r.gross_profit_jpy)).toLocaleString()}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                              r.profit_margin >= 20 ? 'bg-emerald-500/10 text-emerald-400' :
                              r.profit_margin >= 0 ? 'bg-amber-500/10 text-amber-400' :
                              'bg-rose-500/10 text-rose-400'
                            }`}>
                              {r.profit_margin}%
                            </span>
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
          {!plLoading && !plError && monthlyPL.length === 0 && (
            <div className="glass-card p-10 text-center">
              <p className="text-lg mb-2" style={{ color: 'var(--text-secondary)' }}>
                P/Lデータがありません
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                コスト設定を登録し、配信セッションデータがある場合に表示されます。
              </p>
              <button onClick={() => window.location.href = '/settings'} className="btn-ghost text-xs px-4 py-2 mt-3">
                コスト設定へ
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
