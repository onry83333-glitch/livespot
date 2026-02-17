'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { ChatMessage } from '@/components/chat-message';
import { formatTokens, tokensToJPY, timeAgo, formatJST } from '@/lib/utils';
import type { RegisteredCast, SpyMessage } from '@/types';

/* ============================================================
   Types
   ============================================================ */
type TabKey = 'overview' | 'sessions' | 'dm' | 'analytics' | 'sales' | 'realtime';

interface CastStatsData {
  total_messages: number;
  total_tips: number;
  total_coins: number;
  unique_users: number;
  last_activity: string | null;
}

interface FanItem {
  user_name: string;
  total_tokens: number;
  msg_count: number;
  last_seen: string;
}

interface SessionItem {
  session_date: string;
  session_start: string;
  session_end: string;
  message_count: number;
  tip_count: number;
  total_coins: number;
  unique_users: number;
}

interface RetentionUser {
  user_name: string;
  status: 'active' | 'at_risk' | 'churned' | 'new' | 'free';
  total_tokens: number;
  tip_count: number;
  last_tip: string | null;
  last_seen: string;
  first_tip: string | null;
}

interface CampaignEffect {
  campaign: string;
  sent_count: number;
  success_count: number;
  visited_count: number;
  tipped_count: number;
  tip_amount: number;
}

interface DMLogItem {
  id: number;
  user_name: string;
  message: string | null;
  status: string;
  error: string | null;
  campaign: string;
  queued_at: string;
  sent_at: string | null;
}

interface CoinTxItem {
  id: number;
  user_name: string;
  tokens: number;
  type: string;
  date: string;
  source_detail: string | null;
}

interface PaidUserItem {
  user_name: string;
  total_coins: number;
  last_payment_date: string | null;
}

const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: 'overview',  icon: '📊', label: '概要' },
  { key: 'sessions',  icon: '📺', label: '配信' },
  { key: 'dm',        icon: '💬', label: 'DM' },
  { key: 'analytics', icon: '📈', label: '分析' },
  { key: 'sales',     icon: '💰', label: '売上' },
  { key: 'realtime',  icon: '👁', label: 'リアルタイム' },
];

/* ============================================================
   Helper: 今週の月曜（JST）
   ============================================================ */
function getWeekStart(offset = 0): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(jst);
  monday.setUTCDate(jst.getUTCDate() - diff - offset * 7);
  monday.setUTCHours(0, 0, 0, 0);
  // JSTからUTCに戻す
  return new Date(monday.getTime() - 9 * 60 * 60 * 1000);
}

/* ============================================================
   Inner Component
   ============================================================ */
function CastDetailInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();

  const castName = decodeURIComponent(params.castName as string);
  const activeTab = (searchParams.get('tab') as TabKey) || 'overview';
  const coinRate = 7.7;

  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  // Core state
  const [castInfo, setCastInfo] = useState<RegisteredCast | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [stats, setStats] = useState<CastStatsData | null>(null);
  const [fans, setFans] = useState<FanItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Overview: weekly revenue
  const [thisWeekCoins, setThisWeekCoins] = useState(0);
  const [lastWeekCoins, setLastWeekCoins] = useState(0);

  // Sessions
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionLogs, setSessionLogs] = useState<SpyMessage[]>([]);
  const [sessionLogsLoading, setSessionLogsLoading] = useState(false);

  // DM state
  const [dmLogs, setDmLogs] = useState<DMLogItem[]>([]);
  const [dmTargets, setDmTargets] = useState<Set<string>>(new Set());
  const [dmTargetsText, setDmTargetsText] = useState('');
  const [dmMessage, setDmMessage] = useState('');
  const [dmCampaign, setDmCampaign] = useState('');
  const [dmSendMode, setDmSendMode] = useState<'sequential' | 'pipeline'>('pipeline');
  const [dmTabs, setDmTabs] = useState(3);
  const [dmSending, setDmSending] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  const [dmResult, setDmResult] = useState<{ count: number; batch_id: string } | null>(null);
  const [dmStatusCounts, setDmStatusCounts] = useState({ total: 0, queued: 0, sending: 0, success: 0, error: 0 });
  const [dmBatchId, setDmBatchId] = useState<string | null>(null);

  // DM Safety: 3-step confirmation
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [sendUnlocked, setSendUnlocked] = useState(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sales state
  const [coinTxs, setCoinTxs] = useState<CoinTxItem[]>([]);
  const [paidUsers, setPaidUsers] = useState<PaidUserItem[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesThisWeek, setSalesThisWeek] = useState(0);
  const [salesLastWeek, setSalesLastWeek] = useState(0);
  const [syncStatus, setSyncStatus] = useState<{ last: string | null; count: number }>({ last: null, count: 0 });

  // Analytics: retention
  const [retentionUsers, setRetentionUsers] = useState<RetentionUser[]>([]);
  const [campaignEffects, setCampaignEffects] = useState<CampaignEffect[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  // Realtime
  const { messages: realtimeMessages, isConnected } = useRealtimeSpy({
    castName,
    enabled: !!user && activeTab === 'realtime',
  });

  // Tab switch
  const setTab = useCallback((tab: TabKey) => {
    router.push(`/casts/${encodeURIComponent(castName)}?tab=${tab}`, { scroll: false });
  }, [router, castName]);

  // ============================================================
  // Load account + cast info
  // ============================================================
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  useEffect(() => {
    if (!accountId) return;
    sb.from('registered_casts')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .eq('is_active', true)
      .limit(1)
      .single()
      .then(({ data }) => setCastInfo(data as RegisteredCast | null));
  }, [accountId, castName, sb]);

  // データ分離: キャスト登録日以降のデータのみ表示
  const registeredAt = useMemo(() => castInfo?.created_at || null, [castInfo]);

  // ============================================================
  // Load stats + fans via RPC
  // ============================================================
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    Promise.all([
      sb.rpc('get_cast_stats', { p_account_id: accountId, p_cast_names: [castName] }),
      sb.rpc('get_cast_fans', { p_account_id: accountId, p_cast_name: castName, p_limit: 10 }),
    ]).then(([statsRes, fansRes]) => {
      const s = statsRes.data as CastStatsData[] | null;
      if (s && s.length > 0) setStats(s[0]);
      setFans((fansRes.data || []) as FanItem[]);
      setLoading(false);
    });
  }, [accountId, castName, sb]);

  // ============================================================
  // Overview: weekly revenue
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'overview') return;
    const thisMonday = getWeekStart(0);
    const lastMonday = getWeekStart(1);

    // spy_messagesからtip/giftの週間集計（registeredAt以降のみ）
    const thisStart = registeredAt && registeredAt > thisMonday.toISOString() ? registeredAt : thisMonday.toISOString();
    const lastStart = registeredAt && registeredAt > lastMonday.toISOString() ? registeredAt : lastMonday.toISOString();

    Promise.all([
      sb.from('spy_messages')
        .select('tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .in('msg_type', ['tip', 'gift'])
        .gte('message_time', thisStart),
      sb.from('spy_messages')
        .select('tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .in('msg_type', ['tip', 'gift'])
        .gte('message_time', lastStart)
        .lt('message_time', thisMonday.toISOString()),
    ]).then(([thisRes, lastRes]) => {
      setThisWeekCoins((thisRes.data || []).reduce((s, r) => s + (r.tokens || 0), 0));
      setLastWeekCoins((lastRes.data || []).reduce((s, r) => s + (r.tokens || 0), 0));
    });
  }, [accountId, castName, activeTab, registeredAt, sb]);

  // ============================================================
  // Sessions: RPC
  // ============================================================
  useEffect(() => {
    if (!accountId || (activeTab !== 'overview' && activeTab !== 'sessions')) return;
    sb.rpc('get_cast_sessions', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_since: registeredAt ? new Date(registeredAt).toISOString().split('T')[0] : '2026-01-01',
    }).then(({ data }) => setSessions((data || []) as SessionItem[]));
  }, [accountId, castName, activeTab, registeredAt, sb]);

  // Session expand: load logs
  const handleExpandSession = useCallback(async (sessionKey: string, start: string, end: string) => {
    if (expandedSession === sessionKey) { setExpandedSession(null); return; }
    setExpandedSession(sessionKey);
    setSessionLogsLoading(true);
    const { data } = await sb.from('spy_messages')
      .select('*')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .gte('message_time', start)
      .lte('message_time', end)
      .order('message_time', { ascending: true })
      .limit(1000);
    setSessionLogs((data || []) as SpyMessage[]);
    setSessionLogsLoading(false);
  }, [expandedSession, accountId, castName, sb]);

  // ============================================================
  // DM: load logs + poll
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'dm') return;
    sb.from('dm_send_log')
      .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => setDmLogs((data || []) as DMLogItem[]));
  }, [accountId, castName, activeTab, sb]);

  // DM Realtime status polling
  useEffect(() => {
    if (!user || !dmBatchId) return;
    const channel = sb
      .channel('dm-cast-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_send_log' }, async () => {
        const { data: items } = await sb.from('dm_send_log')
          .select('*').eq('campaign', dmBatchId).order('created_at', { ascending: false });
        const logs = items || [];
        const counts = { total: logs.length, queued: 0, sending: 0, success: 0, error: 0 };
        logs.forEach((l: { status: string }) => { if (l.status in counts) (counts as Record<string, number>)[l.status]++; });
        setDmStatusCounts(counts);
      })
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [user, dmBatchId, sb]);

  // DM send
  const handleDmSend = useCallback(async () => {
    if (dmTargets.size === 0 || !dmMessage.trim() || !accountId) return;
    setDmSending(true); setDmError(null); setDmResult(null);
    try {
      const usernames = Array.from(dmTargets);
      const { data, error: rpcErr } = await sb.rpc('create_dm_batch', {
        p_account_id: accountId,
        p_targets: usernames,
        p_message: dmMessage,
        p_template_name: null,
      });
      if (rpcErr) throw rpcErr;
      if (data?.error) { setDmError(`${data.error} (使用済み: ${data.used}/${data.limit})`); setDmSending(false); return; }

      const originalBid = data?.batch_id;
      const count = data?.count || usernames.length;
      const modePrefix = dmSendMode === 'pipeline' ? `pipe${dmTabs}` : 'seq';
      const tag = dmCampaign.trim() ? `${dmCampaign.trim()}_` : '';
      const bid = `${modePrefix}_${tag}${originalBid}`;

      await sb.from('dm_send_log').update({ campaign: bid, cast_name: castName }).eq('campaign', originalBid);
      setDmBatchId(bid);
      setDmResult({ count, batch_id: bid });
      setDmStatusCounts({ total: count, queued: count, sending: 0, success: 0, error: 0 });
      setDmTargets(new Set());
      setDmMessage('');
      setDmCampaign('');

      // ログ再取得
      const { data: logs } = await sb.from('dm_send_log')
        .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
        .eq('account_id', accountId).eq('cast_name', castName).order('created_at', { ascending: false }).limit(200);
      setDmLogs((logs || []) as DMLogItem[]);
    } catch (e: unknown) { setDmError(e instanceof Error ? e.message : String(e)); }
    setDmSending(false);
  }, [dmTargets, dmMessage, dmCampaign, dmSendMode, dmTabs, accountId, castName, sb]);

  const toggleTarget = useCallback((un: string) => {
    setDmTargets(prev => { const n = new Set(prev); if (n.has(un)) n.delete(un); else n.add(un); return n; });
  }, []);

  // DM quick actions
  const addFansAsTargets = useCallback((filter: 'all' | 'vip' | 'regular') => {
    const filtered = filter === 'vip' ? fans.filter(f => f.total_tokens >= 100)
      : filter === 'regular' ? fans.filter(f => f.msg_count >= 3)
      : fans;
    setDmTargets(new Set(filtered.map(f => f.user_name)));
  }, [fans]);

  // DM text input: parse URLs/usernames and add to targets
  const handleAddTextTargets = useCallback(() => {
    const lines = dmTargetsText.split('\n').map(l => l.trim()).filter(Boolean);
    const usernames = lines.map(l => l.replace(/.*\/user\//, '').replace(/\/$/, '').trim()).filter(Boolean);
    if (usernames.length === 0) return;
    setDmTargets(prev => {
      const next = new Set(prev);
      usernames.forEach(un => next.add(un));
      return next;
    });
    setDmTargetsText('');
  }, [dmTargetsText]);

  const removeTarget = useCallback((un: string) => {
    setDmTargets(prev => {
      const next = new Set(prev);
      next.delete(un);
      return next;
    });
  }, []);

  // DM Safety: unlock toggle + 10秒自動ロック
  const handleUnlockToggle = useCallback(() => {
    if (sendUnlocked) {
      setSendUnlocked(false);
      if (unlockTimerRef.current) { clearTimeout(unlockTimerRef.current); unlockTimerRef.current = null; }
    } else {
      setSendUnlocked(true);
      unlockTimerRef.current = setTimeout(() => {
        setSendUnlocked(false);
        unlockTimerRef.current = null;
      }, 10000);
    }
  }, [sendUnlocked]);

  // DM Safety: 3段階確認済み送信
  const handleConfirmedSend = useCallback(() => {
    if (!sendUnlocked) return;
    setSendUnlocked(false);
    if (unlockTimerRef.current) { clearTimeout(unlockTimerRef.current); unlockTimerRef.current = null; }
    setShowConfirmModal(false);
    handleDmSend();
  }, [sendUnlocked, handleDmSend]);

  // Cleanup: unlock timer
  useEffect(() => {
    return () => { if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current); };
  }, []);

  // ============================================================
  // Analytics: retention + campaign effectiveness
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setAnalyticsLoading(true);
    Promise.all([
      sb.rpc('get_user_retention_status', { p_account_id: accountId, p_cast_name: castName }),
      sb.rpc('get_dm_campaign_effectiveness', { p_account_id: accountId, p_cast_name: castName, p_window_days: 7 }),
    ]).then(([retRes, campRes]) => {
      setRetentionUsers((retRes.data || []) as RetentionUser[]);
      setCampaignEffects((campRes.data || []) as CampaignEffect[]);
      setAnalyticsLoading(false);
    }).catch(() => setAnalyticsLoading(false));
  }, [accountId, castName, activeTab, sb]);

  // ============================================================
  // Sales: coin_transactions + paid_users
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'sales') return;
    setSalesLoading(true);
    const thisMonday = getWeekStart(0);
    const lastMonday = getWeekStart(1);

    // registeredAt以降のデータのみ表示（データ分離）
    const regFilter = registeredAt || null;
    const thisWeekStart = regFilter && regFilter > thisMonday.toISOString() ? regFilter : thisMonday.toISOString();
    const lastWeekStart = regFilter && regFilter > lastMonday.toISOString() ? regFilter : lastMonday.toISOString();

    // coin_transactions: registeredAt以降のみ取得
    let recentTxQuery = sb.from('coin_transactions')
      .select('id, user_name, tokens, type, date, source_detail')
      .eq('account_id', accountId)
      .order('date', { ascending: false })
      .limit(100);
    if (regFilter) recentTxQuery = recentTxQuery.gte('date', regFilter);

    let thisWeekTxQuery = sb.from('coin_transactions')
      .select('tokens')
      .eq('account_id', accountId)
      .gte('date', thisWeekStart);

    let lastWeekTxQuery = sb.from('coin_transactions')
      .select('tokens')
      .eq('account_id', accountId)
      .gte('date', lastWeekStart)
      .lt('date', thisMonday.toISOString());

    let syncQuery = sb.from('coin_transactions')
      .select('date')
      .eq('account_id', accountId)
      .order('date', { ascending: false })
      .limit(1);
    if (regFilter) syncQuery = syncQuery.gte('date', regFilter);

    Promise.all([
      recentTxQuery,
      // Paid users who appear in this cast's spy_messages
      sb.rpc('get_cast_fans', { p_account_id: accountId, p_cast_name: castName, p_limit: 50 }),
      thisWeekTxQuery,
      lastWeekTxQuery,
      syncQuery,
    ]).then(([txRes, fansRes, thisWeekRes, lastWeekRes, lastTxRes]) => {
      setCoinTxs((txRes.data || []) as CoinTxItem[]);
      // Convert fans to paid user format
      const fanData = (fansRes.data || []) as FanItem[];
      setPaidUsers(fanData.map(f => ({
        user_name: f.user_name,
        total_coins: f.total_tokens,
        last_payment_date: f.last_seen,
      })));
      setSalesThisWeek((thisWeekRes.data || []).reduce((s: number, r: { tokens: number }) => s + (r.tokens || 0), 0));
      setSalesLastWeek((lastWeekRes.data || []).reduce((s: number, r: { tokens: number }) => s + (r.tokens || 0), 0));
      const lastTx = lastTxRes.data?.[0];
      setSyncStatus({ last: lastTx?.date || null, count: txRes.data?.length || 0 });
      setSalesLoading(false);
    }).catch(() => setSalesLoading(false));
  }, [accountId, castName, activeTab, registeredAt, sb]);

  // Retention stats
  const retentionCounts = useMemo(() => {
    const counts = { active: 0, at_risk: 0, churned: 0, new: 0 };
    retentionUsers.forEach(u => { if (u.status in counts) (counts as Record<string, number>)[u.status]++; });
    return counts;
  }, [retentionUsers]);

  // Navigate to DM tab with pre-filled targets
  const sendRetentionDm = useCallback((usernames: string[], campaign: string) => {
    setDmTargets(new Set(usernames));
    setDmCampaign(campaign);
    setDmMessage('{username}さん、お久しぶりです！また配信遊びに来てくれたら嬉しいです！');
    setTab('dm');
  }, [setTab]);

  // Weekly change %
  const weeklyChange = lastWeekCoins > 0 ? ((thisWeekCoins - lastWeekCoins) / lastWeekCoins * 100) : 0;

  if (!user) return null;

  return (
    <div className="space-y-4 anim-fade-up">
      {/* ============ HEADER ============ */}
      <div className="glass-card px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              🎭 {castName}
              {castInfo?.display_name && (
                <span className="text-sm font-normal" style={{ color: 'var(--text-muted)' }}>
                  ({castInfo.display_name})
                </span>
              )}
            </h1>
            {castInfo?.stripchat_url && (
              <a href={castInfo.stripchat_url} target="_blank" rel="noopener noreferrer"
                className="text-[10px] hover:underline" style={{ color: 'var(--accent-primary)' }}>
                {castInfo.stripchat_url}
              </a>
            )}
          </div>
          {stats && (
            <div className="flex items-center gap-5 text-[11px]">
              <span style={{ color: 'var(--text-muted)' }}>
                MSG <span className="font-bold text-slate-300">{stats.total_messages.toLocaleString()}</span>
              </span>
              <span style={{ color: 'var(--accent-amber)' }}>
                TIP <span className="font-bold">{formatTokens(stats.total_coins)}</span>
              </span>
              <span style={{ color: 'var(--accent-green)' }}>
                <span className="font-bold">{tokensToJPY(stats.total_coins, coinRate)}</span>
              </span>
              <span style={{ color: 'var(--accent-purple, #a855f7)' }}>
                USERS <span className="font-bold">{stats.unique_users}</span>
              </span>
            </div>
          )}
        </div>
        <div className="flex gap-1 mt-4 flex-wrap">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className="text-[11px] px-3 py-1.5 rounded-lg font-medium transition-all"
              style={{
                background: activeTab === t.key ? 'rgba(56,189,248,0.15)' : 'transparent',
                color: activeTab === t.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                border: activeTab === t.key ? '1px solid rgba(56,189,248,0.25)' : '1px solid transparent',
              }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading && activeTab !== 'realtime' ? (
        <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>
      ) : (
        <>
          {/* ============ OVERVIEW ============ */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                {/* Weekly revenue */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>
                      {tokensToJPY(thisWeekCoins, coinRate)}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週の売上</p>
                    <p className="text-[9px]" style={{ color: 'var(--accent-amber)' }}>{formatTokens(thisWeekCoins)}</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--text-secondary)' }}>
                      {tokensToJPY(lastWeekCoins, coinRate)}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>先週の売上</p>
                    <p className="text-[9px]" style={{ color: 'var(--accent-amber)' }}>{formatTokens(lastWeekCoins)}</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{
                      color: weeklyChange >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)'
                    }}>
                      {weeklyChange >= 0 ? '↑' : '↓'} {Math.abs(weeklyChange).toFixed(0)}%
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>前週比</p>
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold">{stats?.total_messages.toLocaleString() || 0}</p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>総メッセージ</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--accent-purple, #a855f7)' }}>
                      {stats?.unique_users || 0}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>ユニークユーザー</p>
                  </div>
                </div>

                {/* Recent sessions */}
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold mb-3">直近の配信</h3>
                  {sessions.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>配信データなし</p>
                  ) : (
                    <div className="space-y-2">
                      {sessions.slice(0, 5).map(s => (
                        <div key={s.session_start} className="glass-panel p-3 flex items-center justify-between">
                          <div>
                            <p className="text-xs font-semibold">{s.session_date}</p>
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {formatJST(s.session_start).split(' ')[1]?.slice(0, 5)} - {formatJST(s.session_end).split(' ')[1]?.slice(0, 5)} / {s.message_count} msg / {s.unique_users} users
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(s.total_coins)}</p>
                            <p className="text-[10px]" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(s.total_coins, coinRate)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Top fans */}
              <div className="glass-card p-4">
                <h3 className="text-sm font-bold mb-3">💰 トップファン</h3>
                {fans.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>データなし</p>
                ) : (
                  <div className="space-y-2">
                    {fans.map((f, i) => (
                      <div key={f.user_name} className="flex items-center justify-between text-[11px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-bold w-4 text-center" style={{
                            color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)'
                          }}>{i + 1}</span>
                          <span className="truncate font-medium">{f.user_name}</span>
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>{f.total_tokens.toLocaleString()} tk</span>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{f.msg_count} msg</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============ SESSIONS ============ */}
          {activeTab === 'sessions' && (
            <div className="space-y-2">
              {sessions.length === 0 ? (
                <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>配信セッションデータなし</div>
              ) : sessions.map(s => {
                const key = s.session_start;
                const isOpen = expandedSession === key;
                return (
                  <div key={key} className="glass-card overflow-hidden">
                    {/* Session header (clickable) */}
                    <button onClick={() => handleExpandSession(key, s.session_start, s.session_end)}
                      className="w-full text-left px-5 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors">
                      <div className="flex items-center gap-3">
                        <span className="text-xs">{isOpen ? '▼' : '►'}</span>
                        <div>
                          <p className="text-xs font-semibold">
                            {s.session_date} {formatJST(s.session_start).split(' ')[1]?.slice(0, 5)}〜{formatJST(s.session_end).split(' ')[1]?.slice(0, 5)}
                          </p>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {s.message_count} msg / {s.unique_users} users
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(s.total_coins)}</span>
                        <span style={{ color: 'var(--accent-green)' }}>{tokensToJPY(s.total_coins, coinRate)}</span>
                      </div>
                    </button>

                    {/* Expanded: chat logs */}
                    {isOpen && (
                      <div className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                        {sessionLogsLoading ? (
                          <div className="p-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>ログ読み込み中...</div>
                        ) : (
                          <>
                            <div className="max-h-96 overflow-auto p-3 space-y-0.5">
                              {sessionLogs.map(msg => (
                                <ChatMessage key={msg.id} message={msg} />
                              ))}
                            </div>
                            {/* Session summary */}
                            <div className="px-5 py-3 flex gap-4 text-[10px]" style={{ background: 'rgba(15,23,42,0.4)', color: 'var(--text-muted)' }}>
                              <span>チップ数: <b className="text-slate-300">{s.tip_count}</b></span>
                              <span>コイン: <b style={{ color: 'var(--accent-amber)' }}>{formatTokens(s.total_coins)}</b></span>
                              <span>ユーザー: <b style={{ color: 'var(--accent-purple, #a855f7)' }}>{s.unique_users}</b></span>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ============ DM ============ */}
          {activeTab === 'dm' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                {/* Send form */}
                <div className="glass-card p-5">
                  <h3 className="text-sm font-bold mb-4">💬 DM送信</h3>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>キャンペーンタグ</label>
                      <input type="text" value={dmCampaign} onChange={e => setDmCampaign(e.target.value)}
                        className="input-glass text-xs w-full" placeholder="例: バレンタイン復帰DM" />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>送信モード</label>
                      <div className="flex gap-2">
                        <button onClick={() => setDmSendMode('pipeline')}
                          className={`text-[10px] px-3 py-1.5 rounded-lg ${dmSendMode === 'pipeline' ? 'btn-primary' : 'btn-ghost'}`}>
                          パイプライン ({dmTabs}tab)
                        </button>
                        <button onClick={() => setDmSendMode('sequential')}
                          className={`text-[10px] px-3 py-1.5 rounded-lg ${dmSendMode === 'sequential' ? 'btn-primary' : 'btn-ghost'}`}>
                          順次
                        </button>
                        {dmSendMode === 'pipeline' && (
                          <select value={dmTabs} onChange={e => setDmTabs(Number(e.target.value))}
                            className="input-glass text-[10px] py-1 px-2 w-16">
                            {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}tab</option>)}
                          </select>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mb-3">
                    <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      メッセージ <span style={{ color: 'var(--accent-pink)' }}>*</span>
                    </label>
                    <textarea value={dmMessage} onChange={e => setDmMessage(e.target.value)}
                      className="input-glass text-xs w-full h-24 resize-none"
                      placeholder="メッセージを入力... {username}でユーザー名置換" />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      選択中: <span className="font-bold text-white">{dmTargets.size}</span> 名
                    </span>
                    <button onClick={() => setShowConfirmModal(true)}
                      disabled={dmSending || dmTargets.size === 0 || !dmMessage.trim()}
                      className="btn-primary text-xs py-1.5 px-5 disabled:opacity-50">
                      {dmSending ? '送信中...' : '送信確認'}
                    </button>
                  </div>

                  {dmError && <p className="mt-2 text-xs" style={{ color: 'var(--accent-pink)' }}>{dmError}</p>}
                  {dmResult && (
                    <p className="mt-2 text-xs" style={{ color: 'var(--accent-green)' }}>
                      {dmResult.count}件をキューに登録 (batch: {dmResult.batch_id})
                    </p>
                  )}
                  {dmBatchId && dmStatusCounts.total > 0 && (
                    <div className="mt-2 flex gap-3 text-[10px]">
                      <span style={{ color: 'var(--text-muted)' }}>待機: {dmStatusCounts.queued}</span>
                      <span style={{ color: 'var(--accent-amber)' }}>送信中: {dmStatusCounts.sending}</span>
                      <span style={{ color: 'var(--accent-green)' }}>成功: {dmStatusCounts.success}</span>
                      <span style={{ color: 'var(--accent-pink)' }}>エラー: {dmStatusCounts.error}</span>
                    </div>
                  )}
                </div>

                {/* DM History */}
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold mb-3">送信履歴</h3>
                  {dmLogs.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>DM送信履歴なし</p>
                  ) : (
                    <div className="space-y-1.5 max-h-80 overflow-auto">
                      {dmLogs.map(log => (
                        <div key={log.id} className="glass-panel px-3 py-2 flex items-center justify-between text-[11px]">
                          <div className="min-w-0 flex-1">
                            <span className="font-semibold">{log.user_name}</span>
                            {log.campaign && (
                              <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded"
                                style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                                {log.campaign}
                              </span>
                            )}
                            <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{log.message}</p>
                          </div>
                          <div className="flex-shrink-0 ml-2 text-right">
                            <span className={`text-[10px] font-bold ${
                              log.status === 'success' ? 'text-emerald-400' : log.status === 'error' ? 'text-rose-400' :
                              log.status === 'sending' ? 'text-amber-400' : 'text-slate-400'
                            }`}>{log.status}</span>
                            <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{timeAgo(log.queued_at)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Target selection */}
              <div className="space-y-4">
                {/* Text input for targets */}
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold mb-2">テキスト入力</h3>
                  <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                    URLまたはユーザー名を1行ずつ入力
                  </p>
                  <textarea
                    value={dmTargetsText}
                    onChange={e => setDmTargetsText(e.target.value)}
                    className="input-glass font-mono text-[11px] leading-relaxed w-full h-28 resize-none"
                    placeholder={'https://ja.stripchat.com/user/username\nまたはユーザー名を1行ずつ'}
                  />
                  <button onClick={handleAddTextTargets}
                    disabled={!dmTargetsText.trim()}
                    className="btn-primary text-[10px] py-1.5 px-4 mt-2 w-full disabled:opacity-50">
                    ターゲットに追加 ({dmTargetsText.split('\n').filter(l => l.trim()).length}件)
                  </button>
                </div>

                {/* Confirmed targets */}
                {dmTargets.size > 0 && (
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-bold">確定ターゲット ({dmTargets.size}名)</h3>
                      <button onClick={() => setDmTargets(new Set())}
                        className="text-[9px] px-2 py-1 rounded-lg hover:bg-rose-500/10 transition-all"
                        style={{ color: 'var(--accent-pink)' }}>全クリア</button>
                    </div>
                    <div className="space-y-0.5 max-h-40 overflow-auto">
                      {Array.from(dmTargets).map(un => (
                        <div key={un} className="flex items-center justify-between px-2 py-1.5 rounded-lg text-[11px] hover:bg-white/[0.03]">
                          <span className="font-medium truncate">{un}</span>
                          <button onClick={() => removeTarget(un)}
                            className="text-slate-500 hover:text-rose-400 transition-colors text-xs flex-shrink-0 ml-2"
                            title="削除">x</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Fan list selection */}
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold mb-2">ファン選択</h3>
                  <div className="flex gap-1.5 mb-3 flex-wrap">
                    <button onClick={() => addFansAsTargets('all')} className="btn-ghost text-[9px] py-1 px-2">全ファン</button>
                    <button onClick={() => addFansAsTargets('vip')} className="btn-ghost text-[9px] py-1 px-2">VIP (100tk+)</button>
                    <button onClick={() => addFansAsTargets('regular')} className="btn-ghost text-[9px] py-1 px-2">常連 (3回+)</button>
                  </div>
                  {fans.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>ファンデータなし</p>
                  ) : (
                    <div className="space-y-1 max-h-60 overflow-auto">
                      {fans.map(f => {
                        const checked = dmTargets.has(f.user_name);
                        return (
                          <button key={f.user_name} onClick={() => toggleTarget(f.user_name)}
                            className={`w-full text-left p-2 rounded-lg text-[11px] transition-all ${checked ? 'border' : 'hover:bg-white/[0.03]'}`}
                            style={checked ? { background: 'rgba(56,189,248,0.08)', borderColor: 'rgba(56,189,248,0.2)' } : {}}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className={`w-3 h-3 rounded-sm border ${checked ? 'bg-sky-500 border-sky-500' : 'border-slate-600'}`} />
                                <span className="font-medium">{f.user_name}</span>
                              </div>
                              <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>{f.total_tokens.toLocaleString()} tk</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ============ ANALYTICS ============ */}
          {activeTab === 'analytics' && (
            <div className="space-y-4">
              {analyticsLoading ? (
                <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>
              ) : (
                <>
                  {/* Retention status badges */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="glass-card p-4 text-center">
                      <p className="text-2xl font-bold" style={{ color: '#22c55e' }}>{retentionCounts.active}</p>
                      <p className="text-[10px] mt-1">🟢 アクティブ</p>
                      <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>7日以内にチップ</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-2xl font-bold" style={{ color: '#f59e0b' }}>{retentionCounts.at_risk}</p>
                      <p className="text-[10px] mt-1">🟡 離脱危機</p>
                      <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>7〜14日</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-2xl font-bold" style={{ color: '#f43f5e' }}>{retentionCounts.churned}</p>
                      <p className="text-[10px] mt-1">🔴 離脱</p>
                      <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>14日以上</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-2xl font-bold" style={{ color: '#38bdf8' }}>{retentionCounts.new}</p>
                      <p className="text-[10px] mt-1">🆕 新規</p>
                      <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>初チップ7日以内</p>
                    </div>
                  </div>

                  {/* At-risk users */}
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-bold">🟡 離脱危機ファン</h3>
                      {retentionUsers.filter(u => u.status === 'at_risk').length > 0 && (
                        <button onClick={() => sendRetentionDm(
                          retentionUsers.filter(u => u.status === 'at_risk').map(u => u.user_name),
                          '復帰DM'
                        )} className="btn-primary text-[10px] py-1 px-3">全員に復帰DM</button>
                      )}
                    </div>
                    {retentionUsers.filter(u => u.status === 'at_risk').length === 0 ? (
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>離脱危機ファンなし</p>
                    ) : (
                      <div className="overflow-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}>
                              <th className="text-left px-3 py-2 font-semibold">ユーザー名</th>
                              <th className="text-right px-3 py-2 font-semibold">最終チップ</th>
                              <th className="text-right px-3 py-2 font-semibold">合計チップ</th>
                              <th className="text-right px-3 py-2 font-semibold">最終訪問</th>
                              <th className="text-center px-3 py-2 font-semibold">アクション</th>
                            </tr>
                          </thead>
                          <tbody>
                            {retentionUsers.filter(u => u.status === 'at_risk').map(u => (
                              <tr key={u.user_name} style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                <td className="px-3 py-2 font-semibold">{u.user_name}</td>
                                <td className="text-right px-3 py-2" style={{ color: 'var(--accent-amber)' }}>
                                  {u.last_tip ? timeAgo(u.last_tip) : '--'}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                  {u.total_tokens.toLocaleString()} tk
                                </td>
                                <td className="text-right px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                                  {timeAgo(u.last_seen)}
                                </td>
                                <td className="text-center px-3 py-2">
                                  <button onClick={() => sendRetentionDm([u.user_name], '復帰DM')}
                                    className="text-[10px] px-2 py-1 rounded-lg hover:bg-sky-500/10 transition-all"
                                    style={{ color: 'var(--accent-primary)' }}>復帰DM</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Campaign effectiveness */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3">📊 DMキャンペーン効果</h3>
                    {campaignEffects.length === 0 ? (
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>キャンペーンデータなし</p>
                    ) : (
                      <div className="overflow-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}>
                              <th className="text-left px-3 py-2 font-semibold">キャンペーン</th>
                              <th className="text-right px-3 py-2 font-semibold">送信数</th>
                              <th className="text-right px-3 py-2 font-semibold">来訪率</th>
                              <th className="text-right px-3 py-2 font-semibold">課金率</th>
                              <th className="text-right px-3 py-2 font-semibold">売上貢献</th>
                            </tr>
                          </thead>
                          <tbody>
                            {campaignEffects.map(c => (
                              <tr key={c.campaign} style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                <td className="px-3 py-2 font-semibold">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded"
                                    style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                                    {c.campaign}
                                  </span>
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums">{c.sent_count}</td>
                                <td className="text-right px-3 py-2 tabular-nums" style={{ color: 'var(--accent-green)' }}>
                                  {c.success_count > 0 ? `${Math.round(c.visited_count / c.success_count * 100)}%` : '--'}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                  {c.success_count > 0 ? `${Math.round(c.tipped_count / c.success_count * 100)}%` : '--'}
                                </td>
                                <td className="text-right px-3 py-2 font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                  {formatTokens(c.tip_amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ============ SALES ============ */}
          {activeTab === 'sales' && (
            <div className="space-y-4">
              {salesLoading ? (
                <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>
              ) : (
                <>
                  {/* Weekly summary cards */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>
                        {tokensToJPY(thisWeekCoins, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週売上</p>
                      <p className="text-[9px]" style={{ color: 'var(--accent-primary)' }}>SPY (tip/gift)</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--accent-amber)' }}>
                        {tokensToJPY(salesThisWeek, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週コイン API</p>
                      <p className="text-[9px]" style={{ color: 'var(--accent-purple, #a855f7)' }}>coin_transactions</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--text-secondary)' }}>
                        {tokensToJPY(salesLastWeek, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>先週コイン API</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{
                        color: salesLastWeek > 0 ? ((salesThisWeek - salesLastWeek) >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)') : 'var(--text-muted)'
                      }}>
                        {salesLastWeek > 0
                          ? `${(salesThisWeek - salesLastWeek) >= 0 ? '↑' : '↓'} ${Math.abs(Math.round((salesThisWeek - salesLastWeek) / salesLastWeek * 100))}%`
                          : '--'}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>前週比 (API)</p>
                    </div>
                  </div>

                  {/* Data source info + sync */}
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-bold">データソース</h3>
                      <div className="flex items-center gap-2">
                        {syncStatus.last && (
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            最終同期: {timeAgo(syncStatus.last)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="glass-panel p-3 rounded-xl">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="w-2 h-2 rounded-full bg-sky-400" />
                          <span className="text-[11px] font-semibold">SPY (spy_messages)</span>
                        </div>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          リアルタイムチャット監視からのtip/giftデータ。このキャスト固有。
                        </p>
                        <p className="text-xs mt-1 font-bold" style={{ color: 'var(--accent-amber)' }}>
                          {formatTokens(stats?.total_coins || 0)}
                        </p>
                      </div>
                      <div className="glass-panel p-3 rounded-xl">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="w-2 h-2 rounded-full bg-purple-400" />
                          <span className="text-[11px] font-semibold">Coin API (coin_transactions)</span>
                        </div>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Stripchat Earnings APIからの課金履歴。アカウント全体。
                        </p>
                        <p className="text-xs mt-1 font-bold" style={{ color: 'var(--accent-amber)' }}>
                          {coinTxs.length > 0 ? `${coinTxs.length}件取得済み` : '未同期'}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Paid users for this cast */}
                    <div className="glass-card p-4">
                      <h3 className="text-sm font-bold mb-3">有料ユーザー (このキャスト)</h3>
                      {paidUsers.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>有料ユーザーデータなし</p>
                      ) : (
                        <div className="space-y-1.5 max-h-80 overflow-auto">
                          {paidUsers.map((u, i) => (
                            <div key={u.user_name} className="glass-panel px-3 py-2 flex items-center justify-between text-[11px]">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-bold w-4 text-center" style={{
                                  color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)'
                                }}>{i + 1}</span>
                                <span className="truncate font-medium">{u.user_name}</span>
                              </div>
                              <div className="flex-shrink-0 text-right">
                                <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                  {u.total_coins.toLocaleString()} tk
                                </span>
                                <p className="text-[9px]" style={{ color: 'var(--accent-green)' }}>
                                  {tokensToJPY(u.total_coins, coinRate)}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Recent coin transactions */}
                    <div className="glass-card p-4">
                      <h3 className="text-sm font-bold mb-3">直近のコイン履歴 (アカウント全体)</h3>
                      {coinTxs.length === 0 ? (
                        <div className="text-center py-6">
                          <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>コイン履歴なし</p>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            Chrome拡張からStripchatにログインし、Popupの「名簿同期」で取得できます
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-1 max-h-80 overflow-auto">
                          {coinTxs.slice(0, 50).map(tx => (
                            <div key={tx.id} className="glass-panel px-3 py-2 flex items-center justify-between text-[11px]">
                              <div className="min-w-0 flex-1">
                                <span className="font-semibold">{tx.user_name}</span>
                                <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded"
                                  style={{ background: 'rgba(168,139,250,0.1)', color: 'var(--accent-purple, #a855f7)' }}>
                                  {tx.type}
                                </span>
                              </div>
                              <div className="flex-shrink-0 ml-2 text-right">
                                <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                  {tx.tokens.toLocaleString()} tk
                                </span>
                                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{timeAgo(tx.date)}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ============ REALTIME ============ */}
          {activeTab === 'realtime' && (
            <div className="glass-card p-4" style={{ height: 'calc(100vh - 220px)' }}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold flex items-center gap-2">
                  👁 リアルタイムログ
                  {isConnected && <span className="text-emerald-400 text-[10px]">● LIVE</span>}
                </h3>
                <span className="text-[10px] px-2 py-1 rounded-lg"
                  style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
                  {realtimeMessages.length} 件
                </span>
              </div>
              <div className="overflow-auto space-y-0.5 pr-1" style={{ height: 'calc(100% - 40px)' }}>
                {realtimeMessages.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>リアルタイムメッセージを待機中...</p>
                  </div>
                ) : realtimeMessages.map(msg => <ChatMessage key={msg.id} message={msg} />)}
              </div>
            </div>
          )}
        </>
      )}

      {/* DM Safety: 3段階確認モーダル */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
          <div className="glass-card p-6 w-full max-w-md mx-4 anim-fade-up">
            <h3 className="text-base font-bold mb-4 flex items-center gap-2">
              <span style={{ color: 'var(--accent-pink)' }}>⚠</span>
              DM送信確認
            </h3>

            <div className="space-y-3 mb-4">
              <div className="glass-panel p-3 rounded-xl">
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>ターゲット</p>
                <p className="text-sm font-bold">{dmTargets.size} 名</p>
                <div className="mt-1 max-h-20 overflow-auto">
                  {Array.from(dmTargets).slice(0, 10).map(un => (
                    <span key={un} className="inline-block text-[10px] mr-1.5 mb-1 px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>{un}</span>
                  ))}
                  {dmTargets.size > 10 && (
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>... 他{dmTargets.size - 10}名</span>
                  )}
                </div>
              </div>

              <div className="glass-panel p-3 rounded-xl">
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>メッセージ</p>
                <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{dmMessage}</p>
              </div>

              {dmCampaign && (
                <div className="glass-panel p-3 rounded-xl">
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>キャンペーン</p>
                  <p className="text-xs">{dmCampaign}</p>
                </div>
              )}

              <div className="p-3 rounded-xl" style={{ background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)' }}>
                <p className="text-[11px] font-semibold" style={{ color: 'var(--accent-pink)' }}>
                  DM送信は取り消せません。ターゲットとメッセージを必ず確認してください。
                </p>
              </div>
            </div>

            {/* 送信ロックトグル */}
            <div className="flex items-center justify-between mb-4 p-3 rounded-xl"
              style={{
                background: sendUnlocked ? 'rgba(244,63,94,0.1)' : 'rgba(15,23,42,0.4)',
                border: `1px solid ${sendUnlocked ? 'rgba(244,63,94,0.3)' : 'var(--border-glass)'}`,
              }}>
              <div>
                <p className="text-[11px] font-semibold">{sendUnlocked ? '送信ロック解除済み' : '送信ロック中'}</p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  {sendUnlocked ? '10秒後に自動ロックされます' : 'トグルで解除してください'}
                </p>
              </div>
              <button onClick={handleUnlockToggle}
                className="w-12 h-6 rounded-full relative transition-all duration-300"
                style={{ background: sendUnlocked ? 'var(--accent-pink)' : 'rgba(100,116,139,0.3)' }}>
                <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-300"
                  style={{ left: sendUnlocked ? '26px' : '2px' }} />
              </button>
            </div>

            {/* アクションボタン */}
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowConfirmModal(false);
                  setSendUnlocked(false);
                  if (unlockTimerRef.current) { clearTimeout(unlockTimerRef.current); unlockTimerRef.current = null; }
                }}
                className="btn-ghost text-xs py-2 px-4 flex-1">
                キャンセル
              </button>
              <button onClick={handleConfirmedSend}
                disabled={!sendUnlocked || dmSending}
                className="text-xs py-2 px-4 flex-1 rounded-xl font-semibold transition-all disabled:opacity-30"
                style={{
                  background: sendUnlocked ? 'linear-gradient(135deg, var(--accent-pink), #dc2626)' : 'rgba(100,116,139,0.2)',
                  color: 'white',
                }}>
                {dmSending ? '送信中...' : '送信実行'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Page (Suspense wrapper)
   ============================================================ */
export default function CastDetailPage() {
  return (
    <Suspense fallback={<div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>}>
      <CastDetailInner />
    </Suspense>
  );
}
