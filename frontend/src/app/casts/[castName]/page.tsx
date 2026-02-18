'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { ChatMessage } from '@/components/chat-message';
import { formatTokens, tokensToJPY, timeAgo, formatJST } from '@/lib/utils';
import type { RegisteredCast, SpyMessage, UserSegment } from '@/types';
import { getUserColorFromCoins } from '@/lib/stripchat-levels';

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

interface AcquisitionUser {
  user_name: string;
  total_coins: number;
  last_payment_date: string | null;
  first_seen: string | null;
  tx_count: number;
  dm_sent: boolean;
  dm_sent_date: string | null;
  dm_campaign: string | null;
  segment: string;
  is_new_user: boolean;
  converted_after_dm: boolean;
}

interface DmScheduleItem {
  id: string;
  cast_name: string;
  message: string;
  target_segment: string | null;
  target_usernames: string[] | null;
  scheduled_at: string;
  status: string;
  sent_count: number;
  total_count: number;
  error_message: string | null;
  campaign: string | null;
  send_mode: string;
  tab_count: number;
  created_at: string;
  completed_at: string | null;
}

interface AlertRule {
  id: string;
  rule_type: string;
  threshold_value: number;
  enabled: boolean;
}

interface PopAlert {
  id: string;
  type: string;
  title: string;
  body: string;
  detail: string;
  timestamp: number;
}

const ALERT_RULE_LABELS: Record<string, { icon: string; label: string; defaultThreshold: number }> = {
  high_tip: { icon: '💎', label: '高額チップ', defaultThreshold: 100 },
  vip_enter: { icon: '👑', label: 'VIP入室', defaultThreshold: 0 },
  whale_enter: { icon: '🐋', label: 'Whale入室', defaultThreshold: 0 },
  new_user_tip: { icon: '🆕', label: '新規ユーザーチップ', defaultThreshold: 0 },
  viewer_milestone: { icon: '👀', label: '視聴者数マイルストーン', defaultThreshold: 50 },
};

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

  // DM Schedule state
  const [dmScheduleMode, setDmScheduleMode] = useState(false);
  const [dmScheduleDate, setDmScheduleDate] = useState('');
  const [dmScheduleTime, setDmScheduleTime] = useState('');
  const [dmSchedules, setDmSchedules] = useState<DmScheduleItem[]>([]);
  const [dmScheduleSaving, setDmScheduleSaving] = useState(false);

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

  // Analytics: segments
  const [segments, setSegments] = useState<UserSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);

  // Coin sync alert
  const [daysSinceSync, setDaysSinceSync] = useState<number | null>(null);

  // New paying users detection
  const [newPayingUsers, setNewPayingUsers] = useState<{ user_name: string; total_coins: number; tx_count: number; is_completely_new: boolean }[]>([]);

  // Alert system
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [popAlerts, setPopAlerts] = useState<PopAlert[]>([]);
  const [showAlertSettings, setShowAlertSettings] = useState(false);

  // Analytics: 直近チップ + チケットチャット
  const [lastTips, setLastTips] = useState<{user_name: string; tokens: number; message_time: string; message: string}[]>([]);
  const [lastTicketChats, setLastTicketChats] = useState<{user_name: string; tokens: number; date: string}[]>([]);

  // Acquisition dashboard
  const [acqUsers, setAcqUsers] = useState<AcquisitionUser[]>([]);
  const [acqLoading, setAcqLoading] = useState(false);
  const [acqDays, setAcqDays] = useState(30);
  const [acqMinCoins, setAcqMinCoins] = useState(150);
  const [acqCustomCoins, setAcqCustomCoins] = useState('');
  const [acqFilter, setAcqFilter] = useState<'all' | 'new' | 'dm_sent' | 'dm_converted'>('all');
  const [acqSortKey, setAcqSortKey] = useState<'total_coins' | 'tx_count' | 'last_payment_date' | 'user_name'>('total_coins');
  const [acqSortAsc, setAcqSortAsc] = useState(false);
  const acqDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Realtime: paid_users color cache
  const [paidUserCoins, setPaidUserCoins] = useState<Map<string, number>>(new Map());

  // Realtime
  const { messages: realtimeMessages, isConnected } = useRealtimeSpy({
    castName,
    enabled: !!user && activeTab === 'realtime',
  });

  // Alert matching: check new realtime messages against rules
  const prevMsgCountRef = useRef(0);
  useEffect(() => {
    if (alertRules.length === 0 || realtimeMessages.length <= prevMsgCountRef.current) {
      prevMsgCountRef.current = realtimeMessages.length;
      return;
    }
    const newMsgs = realtimeMessages.slice(prevMsgCountRef.current);
    prevMsgCountRef.current = realtimeMessages.length;

    for (const msg of newMsgs) {
      for (const rule of alertRules) {
        if (!rule.enabled) continue;
        let matched = false;
        let title = '';
        let body = '';
        let detail = '';

        if (rule.rule_type === 'high_tip' && msg.tokens >= rule.threshold_value && msg.tokens > 0) {
          matched = true;
          title = '💎 高額チップ！';
          body = `${msg.user_name} → ${msg.tokens} tk`;
          detail = msg.message || '';
        } else if (rule.rule_type === 'vip_enter' && msg.msg_type === 'enter' && paidUserCoins.has(msg.user_name || '')) {
          const coins = paidUserCoins.get(msg.user_name || '') || 0;
          if (coins >= 1000) {
            matched = true;
            title = '👑 VIP入室！';
            body = `${msg.user_name} (累計 ${formatTokens(coins)})`;
          }
        } else if (rule.rule_type === 'whale_enter' && msg.msg_type === 'enter' && paidUserCoins.has(msg.user_name || '')) {
          const coins = paidUserCoins.get(msg.user_name || '') || 0;
          if (coins >= 5000) {
            matched = true;
            title = '🐋 Whale入室！';
            body = `${msg.user_name} (累計 ${formatTokens(coins)})`;
          }
        } else if (rule.rule_type === 'new_user_tip' && msg.tokens > 0 && msg.user_name && !paidUserCoins.has(msg.user_name)) {
          matched = true;
          title = '🆕 新規ユーザーチップ！';
          body = `${msg.user_name} → ${msg.tokens} tk`;
        }

        if (matched) {
          const alert: PopAlert = {
            id: `${msg.id}_${rule.rule_type}`,
            type: rule.rule_type,
            title,
            body,
            detail,
            timestamp: Date.now(),
          };
          setPopAlerts(prev => [alert, ...prev].slice(0, 50));
        }
      }
    }
  }, [realtimeMessages, alertRules, paidUserCoins]);

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

  // Alert rules loading
  useEffect(() => {
    if (!accountId) return;
    sb.from('alert_rules')
      .select('id, rule_type, threshold_value, enabled')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .then(({ data }) => setAlertRules((data || []) as AlertRule[]));
  }, [accountId, castName, sb]);

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
  // Coin sync alert: 最終同期からの経過日数
  // ============================================================
  useEffect(() => {
    if (!accountId) return;
    sb.from('coin_transactions')
      .select('date')
      .eq('account_id', accountId)
      .order('date', { ascending: false })
      .limit(1)
      .single()
      .then(({ data }) => {
        if (data?.date) {
          const diff = Math.floor((Date.now() - new Date(data.date).getTime()) / (1000 * 60 * 60 * 24));
          setDaysSinceSync(diff);
        }
      });
  }, [accountId, sb]);

  // ============================================================
  // Realtime: paid_users color cache
  // ============================================================
  useEffect(() => {
    if (activeTab !== 'realtime' || !accountId) return;
    sb.from('paid_users')
      .select('user_name, total_coins')
      .eq('account_id', accountId)
      .order('total_coins', { ascending: false })
      .limit(500)
      .then(({ data }) => {
        const map = new Map<string, number>();
        (data || []).forEach((u: { user_name: string; total_coins: number }) => {
          map.set(u.user_name, u.total_coins);
        });
        setPaidUserCoins(map);
      });
  }, [activeTab, accountId, sb]);

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

    // 新規課金ユーザー検出（直近24時間）
    sb.rpc('detect_new_paying_users', {
      p_account_id: accountId,
      p_cast_name: castName,
    }).then(({ data, error }) => {
      if (!error && Array.isArray(data)) {
        setNewPayingUsers(data as typeof newPayingUsers);
      }
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

    // スケジュール一覧取得
    sb.from('dm_schedules')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('scheduled_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setDmSchedules((data || []) as DmScheduleItem[]));
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
      // プラン上限チェック — 警告表示のみ（送信は継続）
      if (data?.error && !data?.batch_id) { setDmError(`${data.error} (使用済み: ${data.used}/${data.limit})`); setDmSending(false); return; }

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

  // DM Schedule: 予約作成
  const handleScheduleDm = useCallback(async () => {
    if (dmTargets.size === 0 || !dmMessage.trim() || !accountId || !dmScheduleDate || !dmScheduleTime) return;
    setDmScheduleSaving(true);
    setDmError(null);

    try {
      const scheduledAt = new Date(`${dmScheduleDate}T${dmScheduleTime}:00`).toISOString();
      const usernames = Array.from(dmTargets);
      const campaignTag = dmCampaign.trim() || null;

      const { data, error } = await sb.from('dm_schedules').insert({
        account_id: accountId,
        cast_name: castName,
        message: dmMessage,
        target_segment: null,
        target_usernames: usernames,
        scheduled_at: scheduledAt,
        total_count: usernames.length,
        campaign: campaignTag,
        send_mode: dmSendMode,
        tab_count: dmTabs,
      }).select().single();

      if (error) throw error;

      // Chrome拡張がdm_schedulesテーブルを30秒ごとにポーリングして自動実行する
      // （webページからchrome.runtime.sendMessageは不可のため、DB経由で連携）

      // UIリセット
      setDmSchedules(prev => [data as DmScheduleItem, ...prev]);
      setDmTargets(new Set());
      setDmMessage('');
      setDmCampaign('');
      setDmScheduleDate('');
      setDmScheduleTime('');
      setDmScheduleMode(false);
    } catch (e: unknown) {
      setDmError(e instanceof Error ? e.message : String(e));
    }
    setDmScheduleSaving(false);
  }, [dmTargets, dmMessage, dmCampaign, dmSendMode, dmTabs, dmScheduleDate, dmScheduleTime, accountId, castName, sb]);

  // DM Schedule: キャンセル
  const handleCancelSchedule = useCallback(async (scheduleId: string) => {
    const { error } = await sb
      .from('dm_schedules')
      .update({ status: 'cancelled' })
      .eq('id', scheduleId)
      .eq('status', 'pending');

    if (error) return;

    // キャンセルはDBステータス更新のみ（拡張が30秒ポーリングで検知してスキップ）
    setDmSchedules(prev => prev.map(s => s.id === scheduleId ? { ...s, status: 'cancelled' } : s));
  }, [sb]);

  // Alert rule toggle
  const handleToggleAlertRule = useCallback(async (ruleType: string) => {
    if (!accountId) return;
    const existing = alertRules.find(r => r.rule_type === ruleType);
    if (existing) {
      // toggle enabled
      const newEnabled = !existing.enabled;
      await sb.from('alert_rules').update({ enabled: newEnabled }).eq('id', existing.id);
      setAlertRules(prev => prev.map(r => r.id === existing.id ? { ...r, enabled: newEnabled } : r));
    } else {
      // create new rule
      const meta = ALERT_RULE_LABELS[ruleType];
      const { data } = await sb.from('alert_rules').insert({
        account_id: accountId,
        cast_name: castName,
        rule_type: ruleType,
        threshold_value: meta?.defaultThreshold || 0,
        enabled: true,
      }).select().single();
      if (data) setAlertRules(prev => [...prev, data as AlertRule]);
    }
  }, [accountId, castName, alertRules, sb]);

  const handleUpdateThreshold = useCallback(async (ruleId: string, value: number) => {
    await sb.from('alert_rules').update({ threshold_value: value }).eq('id', ruleId);
    setAlertRules(prev => prev.map(r => r.id === ruleId ? { ...r, threshold_value: value } : r));
  }, [sb]);

  // Dismiss pop alert
  const dismissAlert = useCallback((alertId: string) => {
    setPopAlerts(prev => prev.filter(a => a.id !== alertId));
  }, []);

  // Auto-dismiss alerts after 8 seconds
  useEffect(() => {
    if (popAlerts.length === 0) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      setPopAlerts(prev => prev.filter(a => now - a.timestamp < 8000));
    }, 8000);
    return () => clearTimeout(timer);
  }, [popAlerts]);

  // ============================================================
  // Analytics: retention + campaign effectiveness
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setAnalyticsLoading(true);
    setSegmentsLoading(true);

    // 各RPCを独立して呼び出し（1つ失敗しても他に影響しない）
    sb.rpc('get_user_retention_status', { p_account_id: accountId, p_cast_name: castName })
      .then(({ data, error }) => {
        if (error) console.warn('[analytics] retention RPC error:', error.message);
        else setRetentionUsers((data || []) as RetentionUser[]);
      });

    sb.rpc('get_dm_campaign_effectiveness', { p_account_id: accountId, p_cast_name: castName, p_window_days: 7 })
      .then(({ data, error }) => {
        if (error) console.warn('[analytics] campaign RPC error:', error.message);
        else setCampaignEffects((data || []) as CampaignEffect[]);
      });

    sb.rpc('get_user_segments', { p_account_id: accountId, p_cast_name: castName })
      .then(({ data, error }) => {
        if (error) {
          console.error('[analytics] segments RPC error:', error.message);
        } else {
          // RETURNS JSONB → data は JSONB値そのもの（配列）
          const parsed = Array.isArray(data) ? data : [];
          console.log('[analytics] segments loaded:', parsed.length, 'segments');
          setSegments(parsed as UserSegment[]);
        }
        setSegmentsLoading(false);
        setAnalyticsLoading(false);
      });
  }, [accountId, castName, activeTab, sb]);

  // ============================================================
  // Analytics: 直近チップ（このキャスト）+ チケットチャット（このキャスト）
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    // 最後のチップ（このキャストのspy_messages）
    sb.from('spy_messages')
      .select('user_name, tokens, message_time, message')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .gt('tokens', 0)
      .order('message_time', { ascending: false })
      .limit(5)
      .then(({ data }) => setLastTips((data || []) as typeof lastTips));

    // 直近のチケットチャット（このキャスト）
    sb.from('coin_transactions')
      .select('user_name, tokens, date')
      .eq('account_id', accountId)
      .eq('type', 'ticketShow')
      .eq('cast_name', castName)
      .order('date', { ascending: false })
      .limit(5)
      .then(({ data }) => setLastTicketChats((data || []) as typeof lastTicketChats));
  }, [accountId, castName, activeTab, sb]);

  // ============================================================
  // Acquisition Dashboard: RPC呼び出し（debounce 300ms）
  // ============================================================
  const loadAcquisitionData = useCallback(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setAcqLoading(true);
    sb.rpc('get_user_acquisition_dashboard', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_days: acqDays,
      p_min_coins: acqMinCoins,
    }).then(({ data, error }) => {
      if (error) {
        console.warn('[acquisition] RPC error:', error.message);
        setAcqUsers([]);
      } else {
        setAcqUsers((data || []) as AcquisitionUser[]);
      }
      setAcqLoading(false);
    });
  }, [accountId, castName, activeTab, acqDays, acqMinCoins, sb]);

  useEffect(() => {
    if (acqDebounceRef.current) clearTimeout(acqDebounceRef.current);
    acqDebounceRef.current = setTimeout(loadAcquisitionData, 300);
    return () => { if (acqDebounceRef.current) clearTimeout(acqDebounceRef.current); };
  }, [loadAcquisitionData]);

  // Acquisition: filtered + sorted results
  const acqFiltered = useMemo(() => {
    let list = [...acqUsers];
    if (acqFilter === 'new') list = list.filter(u => u.is_new_user);
    else if (acqFilter === 'dm_sent') list = list.filter(u => u.dm_sent);
    else if (acqFilter === 'dm_converted') list = list.filter(u => u.converted_after_dm);
    list.sort((a, b) => {
      let cmp = 0;
      if (acqSortKey === 'total_coins') cmp = a.total_coins - b.total_coins;
      else if (acqSortKey === 'tx_count') cmp = a.tx_count - b.tx_count;
      else if (acqSortKey === 'last_payment_date') cmp = (a.last_payment_date || '').localeCompare(b.last_payment_date || '');
      else if (acqSortKey === 'user_name') cmp = a.user_name.localeCompare(b.user_name);
      return acqSortAsc ? cmp : -cmp;
    });
    return list;
  }, [acqUsers, acqFilter, acqSortKey, acqSortAsc]);

  const acqSummary = useMemo(() => {
    const total = acqUsers.length;
    const newUsers = acqUsers.filter(u => u.is_new_user).length;
    const dmSent = acqUsers.filter(u => u.dm_sent).length;
    const dmConverted = acqUsers.filter(u => u.converted_after_dm).length;
    const cvr = dmSent > 0 ? Math.round(dmConverted / dmSent * 100) : 0;
    const ticketCandidates = acqUsers.filter(u => u.total_coins >= 150 && u.total_coins <= 300 && u.tx_count <= 3);
    return { total, newUsers, dmSent, dmConverted, cvr, ticketCandidates };
  }, [acqUsers]);

  const toggleAcqSort = (key: typeof acqSortKey) => {
    if (acqSortKey === key) setAcqSortAsc(!acqSortAsc);
    else { setAcqSortKey(key); setAcqSortAsc(false); }
  };

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

  // Navigate to DM tab with segment targets
  const sendSegmentDm = useCallback((segmentId: string, segmentName: string) => {
    const seg = segments.find(s => s.segment_id === segmentId);
    if (!seg) return;
    const usernames = seg.users.map(u => u.user_name);
    setDmTargets(new Set(usernames));
    setDmCampaign(`${segmentName}_復帰DM`);
    setDmMessage('{username}さん、お久しぶりです！また配信の方に来てくれたら嬉しいです！');
    setTab('dm');
  }, [segments, setTab]);

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

      {/* Coin sync alert */}
      {daysSinceSync !== null && daysSinceSync >= 3 && (
        <div className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs mb-2 ${
          daysSinceSync >= 7 ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
          daysSinceSync >= 5 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
          'bg-blue-500/20 text-blue-400 border border-blue-500/30'
        }`}>
          <span>{daysSinceSync >= 7 ? '🔴' : daysSinceSync >= 5 ? '🟡' : '🔵'}</span>
          <span>
            コイン履歴が <strong>{daysSinceSync}日間</strong> 更新されていません。
            <a href="https://ja.stripchat.com/earnings/tokens-history"
               target="_blank" rel="noopener" className="underline ml-1">
              Earningsページを開いて同期 →
            </a>
          </span>
        </div>
      )}

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

                {/* New paying users */}
                {newPayingUsers.length > 0 && (
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3">🆕 新規課金ユーザー（直近24時間）</h3>
                    <div className="space-y-1.5">
                      {newPayingUsers.map(u => (
                        <div key={u.user_name} className="glass-panel px-3 py-2 flex items-center justify-between text-[11px]">
                          <div className="flex items-center gap-2 min-w-0">
                            {u.is_completely_new && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                                style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--accent-green)' }}>完全新規</span>
                            )}
                            <span className="font-semibold truncate">{u.user_name}</span>
                            {u.tx_count > 1 && (
                              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>×{u.tx_count}回</span>
                            )}
                          </div>
                          <span className="font-bold flex-shrink-0 ml-2" style={{ color: 'var(--accent-amber)' }}>
                            {formatTokens(u.total_coins)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      <span>合計: {newPayingUsers.length}名</span>
                      <span style={{ color: 'var(--accent-amber)' }}>
                        {formatTokens(newPayingUsers.reduce((s, u) => s + u.total_coins, 0))}
                      </span>
                    </div>
                  </div>
                )}

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
                          <span className="truncate font-medium" style={{ color: getUserColorFromCoins(f.total_tokens || 0) }}>{f.user_name}</span>
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

                  {/* 送信モード: 即時 / スケジュール */}
                  <div className="mb-3 flex items-center gap-3">
                    <label className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>送信タイミング</label>
                    <button onClick={() => setDmScheduleMode(false)}
                      className={`text-[10px] px-3 py-1.5 rounded-lg ${!dmScheduleMode ? 'btn-primary' : 'btn-ghost'}`}>
                      即時送信
                    </button>
                    <button onClick={() => setDmScheduleMode(true)}
                      className={`text-[10px] px-3 py-1.5 rounded-lg ${dmScheduleMode ? 'btn-primary' : 'btn-ghost'}`}>
                      🕐 スケジュール
                    </button>
                  </div>

                  {dmScheduleMode && (
                    <div className="mb-3 flex items-center gap-3">
                      <input type="date" value={dmScheduleDate} onChange={e => setDmScheduleDate(e.target.value)}
                        className="input-glass text-xs py-1.5 px-3"
                        min={new Date().toISOString().split('T')[0]} />
                      <input type="time" value={dmScheduleTime} onChange={e => setDmScheduleTime(e.target.value)}
                        className="input-glass text-xs py-1.5 px-3" />
                      {dmScheduleDate && dmScheduleTime && (
                        <span className="text-[10px]" style={{ color: 'var(--accent-primary)' }}>
                          {new Date(`${dmScheduleDate}T${dmScheduleTime}`).toLocaleString('ja-JP')} に送信予約
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      選択中: <span className="font-bold text-white">{dmTargets.size}</span> 名
                    </span>
                    {dmScheduleMode ? (
                      <button onClick={handleScheduleDm}
                        disabled={dmScheduleSaving || dmTargets.size === 0 || !dmMessage.trim() || !dmScheduleDate || !dmScheduleTime}
                        className="text-xs py-1.5 px-5 rounded-xl font-semibold disabled:opacity-50 transition-all"
                        style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple, #a855f7))', color: 'white' }}>
                        {dmScheduleSaving ? '予約中...' : '🕐 送信予約'}
                      </button>
                    ) : (
                      <button onClick={() => setShowConfirmModal(true)}
                        disabled={dmSending || dmTargets.size === 0 || !dmMessage.trim()}
                        className="btn-primary text-xs py-1.5 px-5 disabled:opacity-50">
                        {dmSending ? '送信中...' : '送信確認'}
                      </button>
                    )}
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

                {/* Scheduled DMs */}
                {dmSchedules.length > 0 && (
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3">📋 予約済みDM</h3>
                    <div className="space-y-2 max-h-60 overflow-auto">
                      {dmSchedules.map(sched => {
                        const statusIcon = sched.status === 'pending' ? '⏳' : sched.status === 'sending' ? '📤' :
                          sched.status === 'completed' ? '✅' : sched.status === 'cancelled' ? '🚫' : '❌';
                        const statusColor = sched.status === 'pending' ? 'var(--accent-amber)' : sched.status === 'sending' ? 'var(--accent-primary)' :
                          sched.status === 'completed' ? 'var(--accent-green)' : 'var(--text-muted)';
                        return (
                          <div key={sched.id} className="glass-panel px-3 py-2.5 rounded-xl">
                            <div className="flex items-start justify-between">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 text-[11px]">
                                  <span>{statusIcon}</span>
                                  <span className="font-semibold">{new Date(sched.scheduled_at).toLocaleString('ja-JP')}</span>
                                  <span style={{ color: 'var(--text-muted)' }}>
                                    対象: {sched.target_usernames ? `${sched.target_usernames.length}名` : sched.target_segment || '--'}
                                  </span>
                                </div>
                                <p className="text-[10px] mt-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                                  {sched.message}
                                </p>
                                {sched.campaign && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded mt-1 inline-block"
                                    style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                                    {sched.campaign}
                                  </span>
                                )}
                              </div>
                              <div className="flex-shrink-0 ml-2 text-right">
                                <span className="text-[10px] font-bold" style={{ color: statusColor }}>
                                  {sched.status === 'completed' ? `${sched.sent_count}/${sched.total_count}` : sched.status}
                                </span>
                                {sched.status === 'pending' && (
                                  <button onClick={() => handleCancelSchedule(sched.id)}
                                    className="block text-[9px] mt-1 px-2 py-0.5 rounded-lg hover:bg-rose-500/10 transition-all"
                                    style={{ color: 'var(--accent-pink)' }}>
                                    キャンセル
                                  </button>
                                )}
                                {sched.error_message && (
                                  <p className="text-[9px] mt-1" style={{ color: 'var(--accent-pink)' }}>{sched.error_message}</p>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
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
                  {/* ============ SEGMENT ANALYSIS ============ */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3">📊 ユーザーセグメント分析</h3>
                    <p className="text-[10px] mb-4" style={{ color: 'var(--text-muted)' }}>
                      このキャストの有料ユーザーをコイン累計額 × 最終課金日の2軸で10パターンに分類（コイン同期データ基準）
                    </p>

                    {segmentsLoading ? (
                      <div className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>セグメント分析中...</div>
                    ) : segments.length === 0 ? (
                      <div className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                        セグメントデータなし（コイン同期を先に実行してください）
                      </div>
                    ) : (
                      <>
                        {/* パレートサマリー */}
                        <div className="grid grid-cols-3 gap-3 mb-4">
                          <div className="glass-panel p-3 rounded-xl text-center">
                            <p className="text-lg font-bold" style={{ color: 'var(--accent-amber)' }}>
                              {segments.reduce((s, seg) => s + seg.user_count, 0).toLocaleString()}
                            </p>
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>有料ユーザー総数</p>
                          </div>
                          <div className="glass-panel p-3 rounded-xl text-center">
                            <p className="text-lg font-bold" style={{ color: 'var(--accent-green)' }}>
                              {segments.reduce((s, seg) => s + seg.total_coins, 0).toLocaleString()} tk
                            </p>
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>総コイン</p>
                          </div>
                          <div className="glass-panel p-3 rounded-xl text-center">
                            <p className="text-lg font-bold" style={{ color: 'var(--accent-primary)' }}>
                              {segments.filter(s => ['S1','S2','S3','S4','S5'].includes(s.segment_id)).reduce((s, seg) => s + seg.user_count, 0).toLocaleString()}
                            </p>
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>高優先ターゲット</p>
                          </div>
                        </div>

                        {/* 直近チップ + チケットチャット */}
                        {(lastTips.length > 0 || lastTicketChats.length > 0) && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                            {/* 最後のチップ（このキャスト） */}
                            {lastTips.length > 0 && (
                              <div className="glass-panel p-3 rounded-xl">
                                <p className="text-[10px] font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
                                  💰 直近のチップ（このキャスト）
                                </p>
                                <div className="space-y-1">
                                  {lastTips.map((t, i) => (
                                    <div key={i} className="flex items-center justify-between text-[11px]">
                                      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                                        {t.user_name || '?'}
                                      </span>
                                      <div className="flex items-center gap-2 flex-shrink-0">
                                        <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                          {(t.tokens || 0).toLocaleString()} tk
                                        </span>
                                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                          {t.message_time ? new Date(t.message_time).toLocaleDateString('ja-JP') : '--'}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {/* 直近のチケットチャット（このキャスト） */}
                            {lastTicketChats.length > 0 && (
                              <div className="glass-panel p-3 rounded-xl">
                                <p className="text-[10px] font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
                                  🎟 直近のチケットチャット（{castName}）
                                </p>
                                <div className="space-y-1">
                                  {lastTicketChats.map((t, i) => (
                                    <div key={i} className="flex items-center justify-between text-[11px]">
                                      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                                        {t.user_name || '?'}
                                      </span>
                                      <div className="flex items-center gap-2 flex-shrink-0">
                                        <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                          {(t.tokens || 0).toLocaleString()} tk
                                        </span>
                                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                          {t.date ? new Date(t.date).toLocaleDateString('ja-JP') : '--'}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* セグメント一覧 */}
                        <div className="space-y-1.5">
                          {[...segments].sort((a, b) => parseInt(a.segment_id.replace('S','')) - parseInt(b.segment_id.replace('S',''))).map(seg => {
                            const isExpanded = expandedSegment === seg.segment_id;
                            const grandTotal = segments.reduce((s, x) => s + x.total_coins, 0);
                            const coinPct = grandTotal > 0 ? (seg.total_coins / grandTotal * 100).toFixed(1) : '0';
                            const priorityColor =
                              seg.priority.includes('最優先') ? '#ef4444' :
                              seg.priority.includes('高') ? '#f59e0b' :
                              seg.priority.includes('中') ? '#eab308' :
                              seg.priority.includes('通常') ? '#22c55e' :
                              seg.priority.includes('低') ? '#38bdf8' : '#64748b';

                            return (
                              <div key={seg.segment_id} className="glass-panel rounded-xl overflow-hidden">
                                {/* Header row */}
                                <button
                                  onClick={() => setExpandedSegment(isExpanded ? null : seg.segment_id)}
                                  className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
                                >
                                  <div className="flex items-center gap-3">
                                    <span className="text-xs">{isExpanded ? '▼' : '▶'}</span>
                                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: priorityColor }} />
                                    <div>
                                      <span className="text-xs font-bold">{seg.segment_id}: {seg.segment_name}</span>
                                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{seg.tier}</p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-4 text-[11px]">
                                    <span className="tabular-nums">{seg.user_count.toLocaleString()}名</span>
                                    <span className="tabular-nums font-bold" style={{ color: 'var(--accent-amber)' }}>
                                      {seg.total_coins.toLocaleString()} tk
                                    </span>
                                    <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                      ({coinPct}%)
                                    </span>
                                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                      平均 {Math.round(seg.avg_coins).toLocaleString()} tk
                                    </span>
                                  </div>
                                </button>

                                {/* Expanded: user list + DM button */}
                                {isExpanded && (
                                  <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-glass)' }}>
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                                        ユーザー一覧（コイン順・上位50名表示）
                                      </span>
                                      <button
                                        onClick={() => sendSegmentDm(seg.segment_id, seg.segment_name)}
                                        className="btn-primary text-[10px] py-1 px-3"
                                      >
                                        📩 {seg.user_count}名にDM送信
                                      </button>
                                    </div>
                                    <div className="max-h-60 overflow-auto space-y-0.5">
                                      {seg.users.slice(0, 50).map((u, i) => (
                                        <div key={u.user_name} className="flex items-center justify-between text-[11px] px-2 py-1 rounded hover:bg-white/[0.03]">
                                          <div className="flex items-center gap-2 min-w-0">
                                            <span className="font-bold w-5 text-center text-[10px]" style={{
                                              color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)'
                                            }}>{i + 1}</span>
                                            <span className="truncate font-medium" style={{ color: getUserColorFromCoins(u.total_coins) }}>{u.user_name}</span>
                                          </div>
                                          <div className="flex items-center gap-3 flex-shrink-0">
                                            <span className="tabular-nums font-bold" style={{ color: 'var(--accent-amber)' }}>
                                              {u.total_coins.toLocaleString()} tk
                                            </span>
                                            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                              {u.last_payment_date ? new Date(u.last_payment_date).toLocaleDateString('ja-JP') : '--'}
                                            </span>
                                          </div>
                                        </div>
                                      ))}
                                      {seg.users.length > 50 && (
                                        <p className="text-[10px] text-center py-1" style={{ color: 'var(--text-muted)' }}>
                                          ... 他 {seg.users.length - 50}名
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>

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

                  {/* ============ ACQUISITION DASHBOARD ============ */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-1">📊 ユーザー獲得ダッシュボード</h3>
                    <p className="text-[10px] mb-4" style={{ color: 'var(--text-muted)' }}>
                      新規課金ユーザーの特定・DM施策の効果測定・チケットチャット初回ユーザー抽出
                    </p>

                    {/* Filter bar - sticky */}
                    <div className="sticky top-0 z-10 glass-panel rounded-xl p-3 mb-4 space-y-2" style={{ backdropFilter: 'blur(16px)' }}>
                      {/* Period */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold w-12" style={{ color: 'var(--text-muted)' }}>期間:</span>
                        {[7, 14, 30, 60, 90].map(d => (
                          <button key={d} onClick={() => setAcqDays(d)}
                            className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                            style={{
                              background: acqDays === d ? 'rgba(56,189,248,0.2)' : 'rgba(255,255,255,0.03)',
                              color: acqDays === d ? 'var(--accent-primary)' : 'var(--text-secondary)',
                              border: `1px solid ${acqDays === d ? 'rgba(56,189,248,0.3)' : 'var(--border-glass)'}`,
                            }}>
                            {d}日
                          </button>
                        ))}
                      </div>
                      {/* Min coins */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold w-12" style={{ color: 'var(--text-muted)' }}>閾値:</span>
                        {[150, 300, 500, 1000].map(c => (
                          <button key={c} onClick={() => { setAcqMinCoins(c); setAcqCustomCoins(''); }}
                            className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                            style={{
                              background: acqMinCoins === c && !acqCustomCoins ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.03)',
                              color: acqMinCoins === c && !acqCustomCoins ? 'var(--accent-amber)' : 'var(--text-secondary)',
                              border: `1px solid ${acqMinCoins === c && !acqCustomCoins ? 'rgba(245,158,11,0.3)' : 'var(--border-glass)'}`,
                            }}>
                            {c}tk+
                          </button>
                        ))}
                        <input
                          type="number"
                          placeholder="カスタム"
                          value={acqCustomCoins}
                          onChange={e => {
                            setAcqCustomCoins(e.target.value);
                            const v = parseInt(e.target.value);
                            if (v > 0) setAcqMinCoins(v);
                          }}
                          className="input-glass text-[10px] w-20 py-1 px-2"
                        />
                      </div>
                      {/* View filter */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold w-12" style={{ color: 'var(--text-muted)' }}>表示:</span>
                        {([
                          { key: 'all', label: '全員' },
                          { key: 'new', label: '新規のみ' },
                          { key: 'dm_sent', label: 'DM送信済のみ' },
                          { key: 'dm_converted', label: 'DM→課金のみ' },
                        ] as const).map(f => (
                          <button key={f.key} onClick={() => setAcqFilter(f.key)}
                            className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                            style={{
                              background: acqFilter === f.key ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.03)',
                              color: acqFilter === f.key ? 'var(--accent-green)' : 'var(--text-secondary)',
                              border: `1px solid ${acqFilter === f.key ? 'rgba(34,197,94,0.3)' : 'var(--border-glass)'}`,
                            }}>
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Summary cards */}
                    {acqLoading ? (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                        {[0,1,2,3].map(i => (
                          <div key={i} className="glass-panel p-4 rounded-xl animate-pulse">
                            <div className="h-6 rounded" style={{ background: 'rgba(255,255,255,0.05)' }} />
                            <div className="h-3 rounded mt-2 w-2/3" style={{ background: 'rgba(255,255,255,0.03)' }} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                          <div className="glass-panel p-4 rounded-xl text-center" style={{ borderImage: 'linear-gradient(135deg, rgba(56,189,248,0.3), rgba(56,189,248,0.05)) 1' }}>
                            <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>{acqSummary.total}</p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>対象ユーザー</p>
                          </div>
                          <div className="glass-panel p-4 rounded-xl text-center" style={{ borderImage: 'linear-gradient(135deg, rgba(34,197,94,0.3), rgba(34,197,94,0.05)) 1' }}>
                            <p className="text-2xl font-bold" style={{ color: 'var(--accent-green)' }}>{acqSummary.newUsers}</p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>完全新規</p>
                          </div>
                          <div className="glass-panel p-4 rounded-xl text-center" style={{ borderImage: 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(168,85,247,0.05)) 1' }}>
                            <p className="text-2xl font-bold" style={{ color: '#a855f7' }}>{acqSummary.dmSent}</p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>DM送信済</p>
                          </div>
                          <div className="glass-panel p-4 rounded-xl text-center" style={{ borderImage: 'linear-gradient(135deg, rgba(245,158,11,0.3), rgba(245,158,11,0.05)) 1' }}>
                            <p className="text-2xl font-bold" style={{ color: 'var(--accent-amber)' }}>{acqSummary.dmConverted}</p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                              DM→課金 {acqSummary.dmSent > 0 && <span className="font-bold">CVR {acqSummary.cvr}%</span>}
                            </p>
                          </div>
                        </div>

                        {/* Ticket chat candidates */}
                        {acqSummary.ticketCandidates.length > 0 && (
                          <div className="glass-panel rounded-xl p-3 mb-4" style={{ borderLeft: '3px solid var(--accent-amber)' }}>
                            <p className="text-[11px] font-bold mb-1" style={{ color: 'var(--accent-amber)' }}>
                              🎫 チケットチャット初回の可能性が高いユーザー: {acqSummary.ticketCandidates.length}名
                            </p>
                            <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                              {acqSummary.ticketCandidates.map(u =>
                                `${u.user_name} (${u.total_coins.toLocaleString()}tk/${u.tx_count}回)`
                              ).join(', ')}
                            </p>
                          </div>
                        )}

                        {/* User table */}
                        <div className="overflow-auto">
                          <table className="w-full text-[11px]">
                            <thead>
                              <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}>
                                <th className="text-left px-3 py-2 font-semibold cursor-pointer hover:text-white transition-colors"
                                  onClick={() => toggleAcqSort('user_name')}>
                                  ユーザー名 {acqSortKey === 'user_name' && (acqSortAsc ? '↑' : '↓')}
                                </th>
                                <th className="text-right px-3 py-2 font-semibold cursor-pointer hover:text-white transition-colors"
                                  onClick={() => toggleAcqSort('total_coins')}>
                                  累計tk {acqSortKey === 'total_coins' && (acqSortAsc ? '↑' : '↓')}
                                </th>
                                <th className="text-right px-3 py-2 font-semibold cursor-pointer hover:text-white transition-colors"
                                  onClick={() => toggleAcqSort('tx_count')}>
                                  回数 {acqSortKey === 'tx_count' && (acqSortAsc ? '↑' : '↓')}
                                </th>
                                <th className="text-right px-3 py-2 font-semibold cursor-pointer hover:text-white transition-colors"
                                  onClick={() => toggleAcqSort('last_payment_date')}>
                                  最終課金 {acqSortKey === 'last_payment_date' && (acqSortAsc ? '↑' : '↓')}
                                </th>
                                <th className="text-center px-3 py-2 font-semibold">セグメント</th>
                                <th className="text-left px-3 py-2 font-semibold">DM施策</th>
                                <th className="text-center px-3 py-2 font-semibold">ステータス</th>
                              </tr>
                            </thead>
                            <tbody>
                              {acqFiltered.length === 0 ? (
                                <tr>
                                  <td colSpan={7} className="text-center py-6" style={{ color: 'var(--text-muted)' }}>
                                    条件に合致するユーザーなし
                                  </td>
                                </tr>
                              ) : acqFiltered.map(u => {
                                const isTicketCandidate = u.total_coins >= 150 && u.total_coins <= 300 && u.tx_count <= 3;
                                const rowBg = u.converted_after_dm
                                  ? 'rgba(245,158,11,0.06)'
                                  : u.is_new_user
                                  ? 'rgba(34,197,94,0.06)'
                                  : 'transparent';
                                return (
                                  <tr key={u.user_name}
                                    className="hover:bg-white/[0.03] transition-colors"
                                    style={{ borderBottom: '1px solid var(--border-glass)', background: rowBg }}>
                                    <td className="px-3 py-2 font-semibold">
                                      <span style={{ color: getUserColorFromCoins(u.total_coins) }}>
                                        {u.is_new_user && <span title="新規ユーザー" className="mr-1">🆕</span>}
                                        {isTicketCandidate && <span title="チケットチャット初回候補" className="mr-1">🎫</span>}
                                        {u.user_name}
                                      </span>
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums font-bold" style={{ color: 'var(--accent-amber)' }}>
                                      {u.total_coins.toLocaleString()}
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums">{u.tx_count.toLocaleString()}回</td>
                                    <td className="text-right px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
                                      {u.last_payment_date ? new Date(u.last_payment_date).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '--'}
                                    </td>
                                    <td className="text-center px-3 py-2">
                                      <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                                        background: u.segment.includes('Whale') ? 'rgba(239,68,68,0.15)' :
                                          u.segment.includes('VIP') ? 'rgba(245,158,11,0.15)' :
                                          u.segment.includes('常連') ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)',
                                        color: u.segment.includes('Whale') ? '#ef4444' :
                                          u.segment.includes('VIP') ? '#f59e0b' :
                                          u.segment.includes('常連') ? '#22c55e' : 'var(--text-muted)',
                                      }}>
                                        {u.segment}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                                      {u.dm_campaign || '-'}
                                    </td>
                                    <td className="text-center px-3 py-2 text-[10px]">
                                      {u.converted_after_dm ? (
                                        <span style={{ color: 'var(--accent-amber)' }}>✅ DM→課金</span>
                                      ) : u.dm_sent ? (
                                        <span style={{ color: '#a855f7' }}>💌 DM送信済</span>
                                      ) : (
                                        <span style={{ color: 'var(--text-muted)' }}>自然流入</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {acqFiltered.length > 0 && (
                          <p className="text-[10px] text-right mt-1" style={{ color: 'var(--text-muted)' }}>
                            {acqFiltered.length}件表示（全{acqUsers.length}件中）
                          </p>
                        )}
                      </>
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
                      <p className="text-[9px]" style={{ color: 'var(--accent-primary)' }}>このキャスト (SPY)</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--accent-amber)' }}>
                        {tokensToJPY(salesThisWeek, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週コイン API</p>
                      <p className="text-[9px]" style={{ color: 'var(--accent-purple, #a855f7)' }}>アカウント全体</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--text-secondary)' }}>
                        {tokensToJPY(salesLastWeek, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>先週コイン API</p>
                      <p className="text-[9px]" style={{ color: 'var(--accent-purple, #a855f7)' }}>アカウント全体</p>
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
                      <p className="text-[9px]" style={{ color: 'var(--accent-purple, #a855f7)' }}>アカウント全体</p>
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
                                <span className="truncate font-medium" style={{ color: getUserColorFromCoins(u.total_coins) }}>{u.user_name}</span>
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
            <div className="space-y-4">
              {/* Pop alerts (slide-in) */}
              {popAlerts.length > 0 && (
                <div className="fixed top-4 right-4 z-50 space-y-2 w-80">
                  {popAlerts.slice(0, 3).map(alert => (
                    <div key={alert.id} className="glass-card p-3 anim-fade-up"
                      style={{ border: '1px solid var(--border-glow)', boxShadow: 'var(--glow-blue)' }}>
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold">{alert.title}</p>
                          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{alert.body}</p>
                          {alert.detail && <p className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{alert.detail}</p>}
                        </div>
                        <button onClick={() => dismissAlert(alert.id)}
                          className="text-slate-500 hover:text-white text-xs ml-2 flex-shrink-0">×</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="glass-card p-4" style={{ height: 'calc(100vh - 260px)' }}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold flex items-center gap-2">
                    👁 リアルタイムログ
                    {isConnected && <span className="text-emerald-400 text-[10px]">● LIVE</span>}
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-2 py-1 rounded-lg"
                      style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
                      {realtimeMessages.length} 件
                    </span>
                    <button onClick={() => setShowAlertSettings(!showAlertSettings)}
                      className={`text-[10px] px-2 py-1 rounded-lg transition-all ${showAlertSettings ? 'btn-primary' : 'btn-ghost'}`}>
                      🔔 アラート
                    </button>
                  </div>
                </div>
                <div className="overflow-auto space-y-0.5 pr-1" style={{ height: 'calc(100% - 40px)' }}>
                  {realtimeMessages.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>リアルタイムメッセージを待機中...</p>
                    </div>
                  ) : realtimeMessages.map(msg => {
                    const coins = msg.user_name ? paidUserCoins.get(msg.user_name) : undefined;
                    const enriched = coins && !msg.user_color
                      ? { ...msg, user_color: getUserColorFromCoins(coins) }
                      : msg;
                    return <ChatMessage key={msg.id} message={enriched} />;
                  })}
                </div>
              </div>

              {/* Alert settings panel */}
              {showAlertSettings && (
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold mb-3">🔔 アラート設定</h3>
                  <div className="space-y-2">
                    {Object.entries(ALERT_RULE_LABELS).map(([ruleType, meta]) => {
                      const rule = alertRules.find(r => r.rule_type === ruleType);
                      const enabled = rule?.enabled ?? false;
                      const hasThreshold = ruleType === 'high_tip' || ruleType === 'viewer_milestone';
                      return (
                        <div key={ruleType} className="flex items-center justify-between glass-panel px-3 py-2 rounded-xl">
                          <div className="flex items-center gap-2">
                            <button onClick={() => handleToggleAlertRule(ruleType)}
                              className="w-8 h-4 rounded-full relative transition-all duration-300"
                              style={{ background: enabled ? 'var(--accent-primary)' : 'rgba(100,116,139,0.3)' }}>
                              <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all duration-300"
                                style={{ left: enabled ? '18px' : '2px' }} />
                            </button>
                            <span className="text-[11px]">{meta.icon} {meta.label}</span>
                          </div>
                          {hasThreshold && rule && (
                            <div className="flex items-center gap-1">
                              <input type="number" value={rule.threshold_value}
                                onChange={e => handleUpdateThreshold(rule.id, Number(e.target.value))}
                                className="input-glass text-[10px] w-16 py-0.5 px-2 text-center" />
                              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                {ruleType === 'high_tip' ? 'tk以上' : '人以上'}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Alert history */}
              {popAlerts.length > 0 && (
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold mb-3">🔔 アラート履歴</h3>
                  <div className="space-y-1.5 max-h-40 overflow-auto">
                    {popAlerts.map(alert => (
                      <div key={alert.id} className="glass-panel px-3 py-2 flex items-center justify-between text-[11px]">
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold">{alert.title}</span>
                          <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>{alert.body}</span>
                        </div>
                        <span className="text-[9px] flex-shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>
                          {timeAgo(new Date(alert.timestamp).toISOString())}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
