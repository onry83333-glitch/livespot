'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { ChatMessage } from '@/components/chat-message';
import { formatTokens, tokensToJPY, timeAgo, formatJST } from '@/lib/utils';
import type { RegisteredCast, SpyMessage, UserSegment } from '@/types';
import { getUserColorFromCoins } from '@/lib/stripchat-levels';


/* ============================================================
   Types
   ============================================================ */
type TabKey = 'overview' | 'sessions' | 'dm' | 'analytics' | 'sales' | 'realtime' | 'screenshots';

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
  broadcast_title?: string | null;
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

interface DmCvrItem {
  campaign: string;
  dm_sent: number;
  paid_after: number;
  cvr_pct: number;
  total_tokens: number;
  avg_tokens_per_payer: number;
  first_sent: string;
  last_sent: string;
}

interface ScreenshotItem {
  id: string;
  cast_name: string;
  session_id: string | null;
  filename: string;
  storage_path: string | null;
  thumbnail_url: string | null;
  captured_at: string;
  signedUrl?: string | null;
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
  { key: 'screenshots', icon: '📸', label: 'スクリーンショット' },
];

/* ============================================================
   Helper: 週境界（月曜 03:00 JST = 送金サイクル区切り）
   月曜 0:00〜2:59 JST の売上は前週に計上される
   ============================================================ */
function getWeekStart(offset = 0): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDay();
  const hour = jst.getUTCHours();
  let diff = day === 0 ? 6 : day - 1;
  // 月曜3時未満は前週扱い
  if (day === 1 && hour < 3) diff = 7;
  const monday = new Date(jst);
  monday.setUTCDate(jst.getUTCDate() - diff - offset * 7);
  monday.setUTCHours(3, 0, 0, 0);
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
  const [totalCoinTx, setTotalCoinTx] = useState<number | null>(null);

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
  const [dmCvr, setDmCvr] = useState<DmCvrItem[]>([]);
  const [dmCvrExpanded, setDmCvrExpanded] = useState<string | null>(null);

  // Analytics: retention
  const [retentionUsers, setRetentionUsers] = useState<RetentionUser[]>([]);
  const [campaignEffects, setCampaignEffects] = useState<CampaignEffect[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  // Analytics: segments
  const [segments, setSegments] = useState<UserSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [expandedSegments, setExpandedSegments] = useState<Set<string>>(new Set());
  const toggleSegment = (id: string) => {
    setExpandedSegments(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Segment refresh
  const [refreshingSegments, setRefreshingSegments] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);

  // H5: Segment legend
  const [showSegmentLegend, setShowSegmentLegend] = useState(true);

  // M3: Segment user list expand
  const [segmentUserExpanded, setSegmentUserExpanded] = useState<Set<string>>(new Set());

  // M18: Segment data load timestamp
  const [segmentsLoadedAt, setSegmentsLoadedAt] = useState<Date | null>(null);

  // M26: Segment sort
  const [segmentSortMode, setSegmentSortMode] = useState<'id' | 'users' | 'coins'>('id');

  // Coin sync alert
  const [daysSinceSync, setDaysSinceSync] = useState<number | null>(null);

  // New paying users detection
  const [newPayingUsers, setNewPayingUsers] = useState<{ user_name: string; total_coins: number; tx_count: number; is_completely_new: boolean }[]>([]);
  const [newPayingExpanded, setNewPayingExpanded] = useState(false);

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
  const [acqMinCoins, setAcqMinCoins] = useState(0);
  const [acqMaxCoins, setAcqMaxCoins] = useState(999999);
  const [acqPreset, setAcqPreset] = useState<string>('all');
  const [acqFilter, setAcqFilter] = useState<'all' | 'new' | 'dm_sent' | 'dm_converted'>('all');
  const [acqSortKey, setAcqSortKey] = useState<'total_coins' | 'tx_count' | 'last_payment_date' | 'user_name'>('total_coins');
  const [acqSortAsc, setAcqSortAsc] = useState(false);
  const acqDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ticket chat candidates accordion
  const [showTicketUsers, setShowTicketUsers] = useState(false);

  // Acquisition table: show more
  const [acqShowAll, setAcqShowAll] = useState(false);

  // Target search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{
    user_name: string; total_coins: number; last_payment_date: string | null;
    last_actual_payment: string | null; first_seen: string | null;
    tx_count: number; segment: string; found: boolean;
    dm_history: { campaign: string; sent_date: string; status: string }[];
    recent_transactions: { date: string; amount: number; type: string }[];
  }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState<string | null>(null);
  const [searchMissesOpen, setSearchMissesOpen] = useState(false);

  // Screenshots
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([]);
  const [screenshotsLoading, setScreenshotsLoading] = useState(false);

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
      sb.from('coin_transactions')
        .select('tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .limit(50000),
    ]).then(([statsRes, fansRes, coinTotalRes]) => {
      const s = statsRes.data as CastStatsData[] | null;
      if (s && s.length > 0) setStats(s[0]);
      setFans((fansRes.data || []) as FanItem[]);
      setTotalCoinTx((coinTotalRes.data || []).reduce((sum: number, r: { tokens: number }) => sum + (r.tokens || 0), 0));
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
      .eq('cast_name', castName)
      .order('date', { ascending: false })
      .limit(1)
      .single()
      .then(({ data }) => {
        if (data?.date) {
          const diff = Math.floor((Date.now() - new Date(data.date).getTime()) / (1000 * 60 * 60 * 24));
          setDaysSinceSync(diff);
        }
      });
  }, [accountId, castName, sb]);

  // ============================================================
  // Realtime: paid_users color cache
  // ============================================================
  useEffect(() => {
    if (activeTab !== 'realtime' || !accountId) return;
    sb.from('paid_users')
      .select('user_name, total_coins')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
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
  // Overview: weekly revenue (coin_transactionsベース)
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'overview') return;
    const thisMonday = getWeekStart(0);
    const lastMonday = getWeekStart(1);

    const thisStart = registeredAt && registeredAt > thisMonday.toISOString() ? registeredAt : thisMonday.toISOString();
    const lastStart = registeredAt && registeredAt > lastMonday.toISOString() ? registeredAt : lastMonday.toISOString();

    Promise.all([
      sb.from('coin_transactions')
        .select('tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .gte('date', thisStart)
        .limit(10000),
      sb.from('coin_transactions')
        .select('tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .gte('date', lastStart)
        .lt('date', thisMonday.toISOString())
        .limit(10000),
    ]).then(([thisTxRes, lastTxRes]) => {
      setThisWeekCoins((thisTxRes.data || []).reduce((s: number, r: { tokens: number }) => s + (r.tokens || 0), 0));
      setLastWeekCoins((lastTxRes.data || []).reduce((s: number, r: { tokens: number }) => s + (r.tokens || 0), 0));
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
    const since = registeredAt ? new Date(registeredAt).toISOString().split('T')[0] : '2026-01-01';
    Promise.all([
      sb.rpc('get_cast_sessions', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_since: since,
      }),
      sb.from('sessions')
        .select('started_at, broadcast_title')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .gte('started_at', since)
        .filter('broadcast_title', 'not.is', null)
        .order('started_at', { ascending: false }),
    ]).then(([rpcResult, titleResult]) => {
      const rpcSessions = (rpcResult.data || []) as SessionItem[];
      const titleRecords = (titleResult.data || []) as { started_at: string; broadcast_title: string }[];
      // broadcast_title をマッチング: 最も近い開始時刻のセッションレコード(30分以内)
      for (const sess of rpcSessions) {
        const sessMs = new Date(sess.session_start).getTime();
        let best: string | null = null;
        let bestDiff = Infinity;
        for (const tr of titleRecords) {
          const diff = Math.abs(new Date(tr.started_at).getTime() - sessMs);
          if (diff < 30 * 60 * 1000 && diff < bestDiff) {
            bestDiff = diff;
            best = tr.broadcast_title;
          }
        }
        sess.broadcast_title = best;
      }
      setSessions(rpcSessions);
    });
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
  const dmBatchIdRef = useRef(dmBatchId);
  dmBatchIdRef.current = dmBatchId;
  const dmCastChannelRef = useRef<ReturnType<typeof sb.channel> | null>(null);

  useEffect(() => {
    if (!user || !accountId) return;

    // 前のチャネルをクリーンアップ
    if (dmCastChannelRef.current) {
      sb.removeChannel(dmCastChannelRef.current);
      dmCastChannelRef.current = null;
    }

    const channel = sb
      .channel(`dm-cast-status-${castName}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_send_log', filter: `account_id=eq.${accountId}` }, async () => {
        const bid = dmBatchIdRef.current;
        if (!bid) return;
        const { data: items } = await sb.from('dm_send_log')
          .select('*').eq('campaign', bid).eq('cast_name', castName).order('created_at', { ascending: false });
        const logs = items || [];
        const counts = { total: logs.length, queued: 0, sending: 0, success: 0, error: 0 };
        logs.forEach((l: { status: string }) => { if (l.status in counts) (counts as Record<string, number>)[l.status]++; });
        setDmStatusCounts(counts);
      })
    subscribeWithRetry(channel);

    dmCastChannelRef.current = channel;

    return () => {
      if (dmCastChannelRef.current) {
        sb.removeChannel(dmCastChannelRef.current);
        dmCastChannelRef.current = null;
      }
    };
  }, [user, accountId, castName]); // dmBatchIdはRefで参照、depsから除外

  // DM send
  const handleDmSend = useCallback(async () => {
    console.log('[DM-Cast] handleDmSend called, targets:', dmTargets.size, 'cast:', castName);
    if (dmTargets.size === 0 || !dmMessage.trim() || !accountId) return;
    setDmSending(true); setDmError(null); setDmResult(null);
    try {
      const usernames = Array.from(dmTargets);
      const modePrefix = dmSendMode === 'pipeline' ? `pipe${dmTabs}` : 'seq';
      const tag = dmCampaign.trim() ? `${dmCampaign.trim()}_` : '';
      const now = new Date();
      const timestamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;

      let originalBid: string | null = null;
      let count = usernames.length;
      let usedRpc = false;

      // Step 1: RPC試行
      console.log('[DM-Cast] Step1: calling create_dm_batch RPC...');
      try {
        const { data, error: rpcErr } = await sb.rpc('create_dm_batch', {
          p_account_id: accountId,
          p_targets: usernames,
          p_message: dmMessage,
          p_template_name: null,
        });
        console.log('[DM-Cast] Step1 RPC result:', JSON.stringify({ data, error: rpcErr }));

        if (!rpcErr && data && !data.error) {
          originalBid = data.batch_id;
          count = data.count || usernames.length;
          usedRpc = true;
        } else if (data?.error && !data?.batch_id) {
          setDmError(`⚠ ${data.error} (使用済み: ${data.used}/${data.limit})`);
          setDmSending(false);
          return;
        } else {
          console.warn('[DM-Cast] Step1 RPC failed, fallback to INSERT:', rpcErr?.message);
        }
      } catch (rpcException) {
        console.warn('[DM-Cast] Step1 RPC exception, fallback to INSERT:', rpcException);
      }

      // Step 2: RPC失敗時のフォールバック — 直接INSERT
      if (!usedRpc) {
        console.log('[DM-Cast] Step2: direct INSERT for', usernames.length, 'users');
        originalBid = `bulk_${timestamp}`;
        const rows = usernames.map(un => ({
          account_id: accountId,
          user_name: un,
          message: dmMessage,
          status: 'queued',
          campaign: originalBid,
          cast_name: castName,
          queued_at: now.toISOString(),
        }));
        const { error: insertErr } = await sb.from('dm_send_log').insert(rows);
        if (insertErr) {
          console.error('[DM-Cast] Step2 INSERT failed:', insertErr.message);
          setDmError(`キュー登録失敗: ${insertErr.message}`);
          setDmSending(false);
          return;
        }
        console.log('[DM-Cast] Step2 INSERT success:', rows.length, 'rows');
      }

      // Step 3: キャンペーン名更新
      const bid = `${modePrefix}_${tag}${originalBid}`;
      console.log('[DM-Cast] Step3: campaign=', bid);
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

      console.log('[DM-Cast] handleDmSend complete: bid=', bid, 'count=', count, 'rpc=', usedRpc);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('[DM-Cast] handleDmSend error:', errMsg, e);
      setDmError(errMsg);
    }
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
        if (error) { console.warn('[analytics] retention RPC error:', error.message); return; }
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          setRetentionUsers((Array.isArray(parsed) ? parsed : []) as RetentionUser[]);
        } catch (e) {
          console.error('[analytics] retention JSONB parse error:', e);
          setRetentionUsers([]);
        }
      });

    sb.rpc('get_dm_campaign_effectiveness', { p_account_id: accountId, p_cast_name: castName, p_window_days: 7 })
      .then(({ data, error }) => {
        if (error) { console.warn('[analytics] campaign RPC error:', error.message); return; }
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          setCampaignEffects((Array.isArray(parsed) ? parsed : []) as CampaignEffect[]);
        } catch (e) {
          console.error('[analytics] campaign JSONB parse error:', e);
          setCampaignEffects([]);
        }
      });

    sb.rpc('get_user_segments', { p_account_id: accountId, p_cast_name: castName })
      .then(({ data, error }) => {
        if (error) {
          console.error('[analytics] segments RPC error:', error.message);
        } else {
          try {
            // RETURNS JSONB → data は JSONB値そのもの（配列）またはJSON文字列
            const raw = typeof data === 'string' ? JSON.parse(data) : data;
            const parsed = Array.isArray(raw) ? raw : [];
            console.log('[analytics] segments loaded:', parsed.length, 'segments');
            setSegments(parsed as UserSegment[]);
          } catch (e) {
            console.error('[analytics] segments JSONB parse error:', e);
            setSegments([]);
          }
        }
        setSegmentsLoading(false);
        setSegmentsLoadedAt(new Date());
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
      .in('msg_type', ['tip', 'gift'])
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
      p_max_coins: acqMaxCoins,
    }).then(({ data, error }) => {
      if (error) {
        console.warn('[acquisition] RPC error:', error.message);
        setAcqUsers([]);
      } else {
        setAcqUsers((data || []) as AcquisitionUser[]);
      }
      setAcqLoading(false);
    });
  }, [accountId, castName, activeTab, acqDays, acqMinCoins, acqMaxCoins, sb]);

  // Target search handler — bulk RPC（完全一致 + 該当なし含む）
  const extractUsername = (input: string): string => {
    const urlMatch = input.match(/stripchat\.com\/user\/([^\s\/\?]+)/i);
    if (urlMatch) return urlMatch[1];
    return input;
  };

  const handleSearchUser = useCallback(async () => {
    if (!accountId || !searchQuery.trim()) return;
    const names = Array.from(new Set(
      searchQuery.split('\n').map(s => extractUsername(s.trim())).filter(Boolean)
    ));
    if (names.length === 0) return;
    setSearchLoading(true);
    setSearchResults([]);
    setSearchMissesOpen(false);
    try {
      const { data, error } = await sb.rpc('search_users_bulk', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_user_names: names,
      });
      if (error) {
        console.warn('[search] RPC error:', error.message);
        setSearchResults([]);
      } else {
        const results = (data || []).map((r: Record<string, unknown>) => ({
          ...r,
          dm_history: Array.isArray(r.dm_history) ? r.dm_history : [],
          recent_transactions: Array.isArray(r.recent_transactions) ? r.recent_transactions : [],
        }));
        setSearchResults(results as typeof searchResults);
      }
    } catch (e) {
      console.error('[search] error:', e);
      setSearchResults([]);
    }
    setSearchLoading(false);
  }, [accountId, castName, searchQuery, sb]);

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
  // Sales: coin_transactions (cast_name絞り込み) + paid_users
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

    // coin_transactions: cast_name絞り込み + registeredAt以降のみ取得
    let recentTxQuery = sb.from('coin_transactions')
      .select('id, user_name, tokens, type, date, source_detail')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('date', { ascending: false })
      .limit(100);
    if (regFilter) recentTxQuery = recentTxQuery.gte('date', regFilter);

    let thisWeekTxQuery = sb.from('coin_transactions')
      .select('tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('type', ['tip', 'gift'])
      .gte('date', thisWeekStart)
      .limit(10000);

    let lastWeekTxQuery = sb.from('coin_transactions')
      .select('tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('type', ['tip', 'gift'])
      .gte('date', lastWeekStart)
      .lt('date', thisMonday.toISOString())
      .limit(10000);

    let syncQuery = sb.from('coin_transactions')
      .select('date')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('date', { ascending: false })
      .limit(1);
    if (regFilter) syncQuery = syncQuery.gte('date', regFilter);

    // paid_users: coin_transactionsからcast_name別に集計（RPC）— 全期間
    const paidUsersQuery = sb.rpc('get_cast_paid_users', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_limit: 100,
      p_since: null,
    });

    Promise.all([
      recentTxQuery,
      paidUsersQuery,
      thisWeekTxQuery,
      lastWeekTxQuery,
      syncQuery,
    ]).then(([txRes, paidRes, thisWeekRes, lastWeekRes, lastTxRes]) => {
      setCoinTxs((txRes.data || []) as CoinTxItem[]);
      setPaidUsers((paidRes.data || []) as PaidUserItem[]);
      setSalesThisWeek((thisWeekRes.data || []).reduce((s: number, r: { tokens: number }) => s + (r.tokens || 0), 0));
      setSalesLastWeek((lastWeekRes.data || []).reduce((s: number, r: { tokens: number }) => s + (r.tokens || 0), 0));
      const lastTx = lastTxRes.data?.[0];
      setSyncStatus({ last: lastTx?.date || null, count: txRes.data?.length || 0 });
      setSalesLoading(false);
    }).catch(() => setSalesLoading(false));
  }, [accountId, castName, activeTab, registeredAt, sb]);

  // ============================================================
  // Sales: DM Campaign CVR
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'sales') return;
    sb.rpc('get_dm_campaign_cvr', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_since: new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0],
    }).then(({ data }) => {
      setDmCvr((data || []) as DmCvrItem[]);
    });
  }, [accountId, castName, activeTab, sb]);

  // ============================================================
  // Screenshots
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'screenshots') return;
    setScreenshotsLoading(true);
    (async () => {
      const { data, error } = await sb.from('screenshots')
        .select('id, cast_name, session_id, filename, storage_path, thumbnail_url, captured_at')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .order('captured_at', { ascending: false })
        .limit(100);

      if (error || !data) {
        setScreenshotsLoading(false);
        return;
      }

      // storage_path から signed URL を一括生成（privateバケット対応）
      const withUrls = await Promise.all(
        (data as ScreenshotItem[]).map(async (ss) => {
          if (!ss.storage_path) return ss;
          // storage_path = "screenshots/castName/filename" — バケット名を除いたパスが必要
          const pathInBucket = ss.storage_path.startsWith('screenshots/')
            ? ss.storage_path.slice('screenshots/'.length)
            : ss.storage_path;
          const { data: signedData } = await sb.storage
            .from('screenshots')
            .createSignedUrl(pathInBucket, 3600); // 1時間有効
          return { ...ss, signedUrl: signedData?.signedUrl || null };
        })
      );

      setScreenshots(withUrls);
      setScreenshotsLoading(false);
    })();
  }, [accountId, castName, activeTab, sb]);

  // Retention stats
  const retentionCounts = useMemo(() => {
    const counts = { active: 0, at_risk: 0, churned: 0, new: 0 };
    retentionUsers.forEach(u => { if (u.status in counts) (counts as Record<string, number>)[u.status]++; });
    return counts;
  }, [retentionUsers]);

  // Refresh segments from coin_transactions
  const handleRefreshSegments = useCallback(async () => {
    if (!accountId) return;
    setRefreshingSegments(true);
    setRefreshResult(null);
    try {
      const { data, error } = await sb.rpc('refresh_segments', {
        p_account_id: accountId,
        p_cast_name: castName,
      });
      if (error) {
        setRefreshResult(`エラー: ${error.message}`);
      } else {
        const count = typeof data === 'number' ? data : 0;
        setRefreshResult(`${count.toLocaleString()}件更新しました`);
        // セグメントデータをリロード
        sb.rpc('get_user_segments', { p_account_id: accountId, p_cast_name: castName })
          .then(({ data: segData }) => {
            const parsed = Array.isArray(segData) ? segData : [];
            setSegments(parsed as UserSegment[]);
          });
      }
    } catch {
      setRefreshResult('エラーが発生しました');
    } finally {
      setRefreshingSegments(false);
    }
  }, [accountId, castName, sb]);

  // Navigate to DM tab with segment targets (H6: segment context in campaign)
  const sendSegmentDm = useCallback((segmentId: string, segmentName: string) => {
    const seg = segments.find(s => s.segment_id === segmentId);
    if (!seg) return;
    const usernames = seg.users.map(u => u.user_name);
    setDmTargets(new Set(usernames));
    setDmCampaign(`retention_${segmentId}_${segmentName}`);
    setDmMessage('{username}さん、お久しぶりです！また配信の方に来てくれたら嬉しいです！');
    setTab('dm');
  }, [segments, setTab]);

  // Navigate to DM tab with pre-filled targets (H6: retention context in campaign)
  const sendRetentionDm = useCallback((usernames: string[], campaign: string) => {
    setDmTargets(new Set(usernames));
    setDmCampaign(campaign.startsWith('retention_') ? campaign : `retention_${campaign}`);
    setDmMessage('{username}さん、お久しぶりです！また配信遊びに来てくれたら嬉しいです！');
    setTab('dm');
  }, [setTab]);

  // Reassign transactions by session
  const [reassigning, setReassigning] = useState(false);
  const [reassignResult, setReassignResult] = useState<{ updated: number; session: number; fallback: number } | null>(null);

  const handleReassignTransactions = useCallback(async () => {
    if (!accountId || reassigning) return;
    setReassigning(true);
    setReassignResult(null);
    try {
      const { data, error } = await sb.rpc('reassign_coin_transactions_by_session', {
        p_account_id: accountId,
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      setReassignResult({
        updated: result?.updated_count || 0,
        session: result?.session_matched || 0,
        fallback: result?.fallback_matched || 0,
      });
    } catch (err: unknown) {
      console.error('Reassign failed:', err);
      setReassignResult({ updated: -1, session: 0, fallback: 0 });
    } finally {
      setReassigning(false);
    }
  }, [accountId, reassigning, sb]);

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
                TIP <span className="font-bold">{formatTokens(totalCoinTx ?? stats.total_coins)}</span>
              </span>
              <span style={{ color: 'var(--accent-green)' }}>
                <span className="font-bold">{tokensToJPY(totalCoinTx ?? stats.total_coins, coinRate)}</span>
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
            → Chrome拡張のコイン同期を実行してください
            <a href="https://ja.stripchat.com/earnings/tokens-history"
               target="_blank" rel="noopener" className="underline ml-1">
              Earningsページを開いて同期 →
            </a>
          </span>
        </div>
      )}

      {loading && activeTab !== 'realtime' ? (
        <div className="space-y-3">
          <div className="h-8 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
          <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
          <div className="grid grid-cols-3 gap-3">
            <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
            <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
            <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
          </div>
        </div>
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
                {newPayingUsers.length > 0 && (() => {
                  const MAX_COLLAPSED = 5;
                  const MAX_EXPANDED = 20;
                  const visibleUsers = newPayingExpanded
                    ? newPayingUsers.slice(0, MAX_EXPANDED)
                    : newPayingUsers.slice(0, MAX_COLLAPSED);
                  const hasMore = newPayingUsers.length > MAX_COLLAPSED;
                  return (
                    <div className="glass-card p-4">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-bold">新規課金ユーザー（24h）</h3>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {newPayingUsers.length}名 / {formatTokens(newPayingUsers.reduce((s, u) => s + u.total_coins, 0))}
                          {' '}
                          <span style={{ color: 'var(--accent-green)' }}>{tokensToJPY(newPayingUsers.reduce((s, u) => s + u.total_coins, 0), coinRate)}</span>
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {visibleUsers.map(u => (
                          <div key={u.user_name} className="flex items-center justify-between text-[11px] px-2 py-1 rounded"
                            style={{ background: 'rgba(255,255,255,0.02)' }}>
                            <div className="flex items-center gap-1.5 min-w-0">
                              {u.is_completely_new && (
                                <span className="text-[8px] px-1 py-0.5 rounded font-bold"
                                  style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--accent-green)' }}>NEW</span>
                              )}
                              <span className="font-semibold truncate">{u.user_name}</span>
                              {u.tx_count > 1 && (
                                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>×{u.tx_count}</span>
                              )}
                            </div>
                            <span className="font-bold flex-shrink-0 ml-2 text-[10px]">
                              <span style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.total_coins)}</span>
                              {' '}
                              <span style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.total_coins, coinRate)}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                      {hasMore && (
                        <button
                          onClick={() => setNewPayingExpanded(!newPayingExpanded)}
                          className="w-full mt-2 text-[10px] py-1 rounded hover:opacity-80 transition-opacity"
                          style={{ color: 'var(--accent-primary)', background: 'rgba(56,189,248,0.05)' }}
                        >
                          {newPayingExpanded
                            ? '閉じる'
                            : `もっと見る（残り${Math.min(newPayingUsers.length - MAX_COLLAPSED, MAX_EXPANDED - MAX_COLLAPSED)}名）`}
                          {!newPayingExpanded && newPayingUsers.length > MAX_EXPANDED && (
                            <span style={{ color: 'var(--text-muted)' }}> / 全{newPayingUsers.length}名</span>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })()}

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
                            <p className="text-xs font-semibold">
                              {s.session_date}
                              {s.broadcast_title && (
                                <span className="ml-2 text-[10px] font-normal" style={{ color: 'var(--accent-purple)' }}>
                                  {s.broadcast_title}
                                </span>
                              )}
                            </p>
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
                          <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>{formatTokens(f.total_tokens)}</span>
                          <p className="text-[9px]" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(f.total_tokens, coinRate)}</p>
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
              {/* セッション一覧ページへのリンク */}
              <div className="flex justify-end mb-1">
                <a
                  href={`/casts/${encodeURIComponent(castName)}/sessions`}
                  className="text-[11px] px-3 py-1.5 rounded-md hover:bg-white/5 transition-colors"
                  style={{ color: 'var(--accent-primary)', border: '1px solid var(--border-glass)' }}
                >
                  📺 全セッション一覧 →
                </a>
              </div>
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
                            {s.broadcast_title && (
                              <span className="ml-2 text-[11px] font-normal px-2 py-0.5 rounded-md"
                                style={{ background: 'rgba(168,85,247,0.1)', color: 'var(--accent-purple)' }}>
                                {s.broadcast_title}
                              </span>
                            )}
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
                              <span>コイン: <b style={{ color: 'var(--accent-amber)' }}>{formatTokens(s.total_coins)}</b> <b style={{ color: 'var(--accent-green)' }}>{tokensToJPY(s.total_coins, coinRate)}</b></span>
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
                <div className="space-y-3">
                  <div className="h-8 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  <div className="grid grid-cols-3 gap-3">
                    <div className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    <div className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    <div className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  </div>
                </div>
              ) : (
                <>
                  {/* ============ SEGMENT ANALYSIS ============ */}
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h3 className="text-sm font-bold flex items-center gap-2">
                          📊 ユーザーセグメント分析
                          {/* M18: last update timestamp */}
                          {segmentsLoadedAt && (
                            <span className="text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>
                              最終読込: {segmentsLoadedAt.toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'})}
                            </span>
                          )}
                        </h3>
                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          コイン累計額 × 最終課金日の2軸で分類（coin_transactions基準）
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {refreshResult && (
                          <span className="text-[10px] px-2 py-1 rounded-full" style={{
                            background: refreshResult.startsWith('エラー') ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
                            color: refreshResult.startsWith('エラー') ? '#ef4444' : '#22c55e',
                          }}>
                            {refreshResult}
                          </span>
                        )}
                        <button
                          onClick={handleRefreshSegments}
                          disabled={refreshingSegments}
                          className="text-[10px] px-3 py-1.5 rounded-lg font-medium transition-all"
                          style={{
                            background: refreshingSegments ? 'rgba(56,189,248,0.1)' : 'rgba(56,189,248,0.15)',
                            color: 'var(--accent-primary)',
                            border: '1px solid rgba(56,189,248,0.2)',
                          }}
                        >
                          {refreshingSegments ? '更新中...' : '🔄 セグメント更新'}
                        </button>
                      </div>
                    </div>

                    {segmentsLoading ? (
                      <div className="space-y-2">
                        {[0,1,2].map(i => (
                          <div key={i} className="h-14 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                        ))}
                      </div>
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

                        {/* H5: Segment legend (collapsible) */}
                        <div className="glass-card p-3 mb-4">
                          <button
                            onClick={() => setShowSegmentLegend(!showSegmentLegend)}
                            className="flex items-center gap-2 text-[11px] font-semibold w-full text-left hover:opacity-80 transition-opacity"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            <span>{showSegmentLegend ? '▼' : '▶'}</span>
                            <span>凡例</span>
                          </button>
                          {showSegmentLegend && (
                            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1 text-[10px]">
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.06)' }}>
                                <span className="font-bold w-6">S1</span>
                                <span>Whale現役 — 高額課金＋最近も応援</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.04)' }}>
                                <span className="font-bold w-6">S2</span>
                                <span>Whale準現役 — 高額だがやや遠のく</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.02)' }}>
                                <span className="font-bold w-6">S3</span>
                                <span>Whale休眠 — 以前は高額、今は不在</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(245,158,11,0.06)' }}>
                                <span className="font-bold w-6">S4</span>
                                <span>VIP現役 — 中額＋アクティブ</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(245,158,11,0.04)' }}>
                                <span className="font-bold w-6">S5</span>
                                <span>VIP準現役 — 中額＋やや遠のく</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(245,158,11,0.02)' }}>
                                <span className="font-bold w-6">S6</span>
                                <span>VIP休眠 — 中額＋長期不在</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(56,189,248,0.06)' }}>
                                <span className="font-bold w-6">S7</span>
                                <span>ライト現役 — 少額＋アクティブ</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(56,189,248,0.04)' }}>
                                <span className="font-bold w-6">S8</span>
                                <span>ライト準現役 — 少額＋やや遠のく</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(56,189,248,0.02)' }}>
                                <span className="font-bold w-6">S9</span>
                                <span>ライト休眠 — 少額＋長期不在</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(100,116,139,0.06)' }}>
                                <span className="font-bold w-6">S10</span>
                                <span>離脱 — 長期間来ていない</span>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* M26: Segment sort options + M19: color legend */}
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>並び順:</span>
                            {([
                              { key: 'id' as const, label: 'ID順' },
                              { key: 'users' as const, label: 'ユーザー数順' },
                              { key: 'coins' as const, label: '合計コイン順' },
                            ]).map(opt => (
                              <button
                                key={opt.key}
                                onClick={() => setSegmentSortMode(opt.key)}
                                className="text-[10px] px-2 py-1 rounded-lg transition-all"
                                style={{
                                  background: segmentSortMode === opt.key ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.03)',
                                  color: segmentSortMode === opt.key ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                  border: `1px solid ${segmentSortMode === opt.key ? 'rgba(56,189,248,0.25)' : 'var(--border-glass)'}`,
                                }}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                          <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            色: <span style={{ color: '#aa00ff' }}>10,000tk+</span> / <span style={{ color: '#ff9100' }}>1,000tk+</span> / <span style={{ color: '#78909c' }}>1,000tk未満</span>
                          </span>
                        </div>

                        {/* セグメント一覧 */}
                        <div className="space-y-1.5">
                          {[...segments].sort((a, b) => {
                            if (segmentSortMode === 'users') return b.user_count - a.user_count;
                            if (segmentSortMode === 'coins') return b.total_coins - a.total_coins;
                            return parseInt(a.segment_id.replace('S','')) - parseInt(b.segment_id.replace('S',''));
                          }).map(seg => {
                            const isExpanded = expandedSegments.has(seg.segment_id);
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
                                  onClick={() => toggleSegment(seg.segment_id)}
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
                                {isExpanded && (() => {
                                  const isUserExpanded = segmentUserExpanded.has(seg.segment_id);
                                  const displayLimit = isUserExpanded ? 200 : 50;
                                  const visibleUsers = seg.users.slice(0, displayLimit);
                                  const remaining = seg.users.length - displayLimit;
                                  return (
                                  <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-glass)' }}>
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                                        ユーザー一覧（コイン順・上位{displayLimit}名表示）
                                      </span>
                                      <button
                                        onClick={() => sendSegmentDm(seg.segment_id, seg.segment_name)}
                                        className="btn-primary text-[10px] py-1 px-3"
                                      >
                                        📩 {seg.user_count}名にDM送信
                                      </button>
                                    </div>
                                    <div className={`overflow-auto space-y-0.5 ${isUserExpanded ? 'max-h-96' : 'max-h-60'}`}>
                                      {visibleUsers.map((u, i) => (
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
                                      {/* M3: Expand beyond 50 */}
                                      {!isUserExpanded && seg.users.length > 50 && (
                                        <button
                                          onClick={() => setSegmentUserExpanded(prev => {
                                            const next = new Set(prev);
                                            next.add(seg.segment_id);
                                            return next;
                                          })}
                                          className="w-full text-[10px] text-center py-1.5 rounded-lg hover:bg-white/[0.03] transition-colors"
                                          style={{ color: 'var(--accent-primary)' }}
                                        >
                                          もっと表示（残り {seg.users.length - 50}名）
                                        </button>
                                      )}
                                      {isUserExpanded && remaining > 0 && (
                                        <p className="text-[10px] text-center py-1" style={{ color: 'var(--text-muted)' }}>
                                          ... 他 {remaining}名
                                        </p>
                                      )}
                                      {isUserExpanded && seg.users.length > 50 && (
                                        <button
                                          onClick={() => setSegmentUserExpanded(prev => {
                                            const next = new Set(prev);
                                            next.delete(seg.segment_id);
                                            return next;
                                          })}
                                          className="w-full text-[10px] text-center py-1 rounded-lg hover:bg-white/[0.03] transition-colors"
                                          style={{ color: 'var(--text-muted)' }}
                                        >
                                          折りたたむ
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  );
                                })()}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Retention status badges — データがある場合のみ表示 */}
                  {retentionUsers.length > 0 && (
                    <>
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
                      {retentionUsers.filter(u => u.status === 'at_risk').length > 0 && (
                        <div className="glass-card p-4">
                          <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-bold">🟡 離脱危機ファン</h3>
                            <button onClick={() => sendRetentionDm(
                              retentionUsers.filter(u => u.status === 'at_risk').map(u => u.user_name),
                              '復帰DM'
                            )} className="btn-primary text-[10px] py-1 px-3">全員に復帰DM</button>
                          </div>
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
                        </div>
                      )}
                    </>
                  )}

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
                                <td className="text-right px-3 py-2 font-bold tabular-nums">
                                  <span style={{ color: 'var(--accent-amber)' }}>{formatTokens(c.tip_amount)}</span>
                                  <br />
                                  <span className="text-[9px] font-normal" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(c.tip_amount, coinRate)}</span>
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

                    {/* Target search */}
                    <div className="glass-panel rounded-xl p-3 mb-4">
                      <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>🔍 ターゲット検索</p>
                      <div className="flex gap-2 items-end">
                        <textarea
                          placeholder="ユーザー名またはURLを1行ずつ入力（改行区切り）"
                          value={searchQuery}
                          onChange={e => setSearchQuery(e.target.value)}
                          rows={3}
                          className="input-glass text-[11px] flex-1 py-1.5 px-3 resize-y min-h-[60px]"
                        />
                        <div className="flex flex-col gap-1">
                          <button onClick={handleSearchUser} disabled={searchLoading || !searchQuery.trim()}
                            className="btn-primary text-[10px] py-1.5 px-4 disabled:opacity-40">
                            {searchLoading
                              ? `${Array.from(new Set(searchQuery.split('\n').map(s => s.trim()).filter(Boolean))).length}名検索中...`
                              : '検索'}
                          </button>
                          {searchQuery.trim() && (
                            <span className="text-[9px] text-center tabular-nums" style={{ color: 'var(--text-muted)' }}>
                              {Array.from(new Set(searchQuery.split('\n').map(s => s.trim()).filter(Boolean))).length}名
                            </span>
                          )}
                        </div>
                      </div>
                      {searchResults.length > 0 && (() => {
                        const hits = searchResults.filter(r => r.found);
                        const misses = searchResults.filter(r => !r.found);
                        return (
                        <div className="mt-3 space-y-2">
                          <p className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                            {searchResults.length}名中{' '}
                            <span style={{ color: 'var(--accent-green)' }}>{hits.length}名ヒット</span>
                            {misses.length > 0 && (
                              <> / <span style={{ color: 'var(--accent-pink)' }}>{misses.length}名該当なし</span></>
                            )}
                          </p>
                          {/* Hit cards */}
                          {hits.map(r => (
                            <div key={r.user_name} className="glass-panel rounded-xl p-3" style={{ borderLeft: '3px solid var(--accent-primary)' }}>
                              <div className="flex items-start justify-between mb-2">
                                <div>
                                  <span className="text-xs font-bold" style={{ color: getUserColorFromCoins(r.total_coins) }}>
                                    👤 {r.user_name}
                                  </span>
                                  <span className="text-[9px] ml-2 px-1.5 py-0.5 rounded" style={{
                                    background: r.segment.includes('Whale') ? 'rgba(239,68,68,0.15)' :
                                      r.segment.includes('VIP') ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.05)',
                                    color: r.segment.includes('Whale') ? '#ef4444' :
                                      r.segment.includes('VIP') ? '#f59e0b' : 'var(--text-muted)',
                                  }}>{r.segment}</span>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] mb-2">
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>累計: </span>
                                  <span className="font-bold" style={{ color: 'var(--accent-amber)' }}>{r.total_coins.toLocaleString()} tk</span>
                                  <span style={{ color: 'var(--text-muted)' }}> ({r.tx_count}回)</span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>最終課金: </span>
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    {(r.last_actual_payment || r.last_payment_date)
                                      ? new Date(r.last_actual_payment || r.last_payment_date!).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                      : '--'}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>初回登録: </span>
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    {r.first_seen ? new Date(r.first_seen).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>DM履歴: </span>
                                  {r.dm_history.length > 0 ? (
                                    <span style={{ color: '#a855f7' }}>
                                      {r.dm_history[0].campaign} ({new Date(r.dm_history[0].sent_date).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })})
                                    </span>
                                  ) : (
                                    <span style={{ color: 'var(--text-muted)' }}>なし</span>
                                  )}
                                </div>
                              </div>
                              {/* Recent transactions - collapsible */}
                              {r.recent_transactions.length > 0 && (
                                <div>
                                  <button onClick={() => setSearchExpanded(searchExpanded === r.user_name ? null : r.user_name)}
                                    className="text-[10px] hover:underline" style={{ color: 'var(--accent-primary)' }}>
                                    {searchExpanded === r.user_name ? '▼' : '▶'} 直近トランザクション ({r.recent_transactions.length}件)
                                  </button>
                                  {searchExpanded === r.user_name && (
                                    <div className="mt-1 space-y-0.5 max-h-40 overflow-auto">
                                      {r.recent_transactions.map((tx, i) => (
                                        <div key={i} className="flex items-center justify-between text-[10px] px-2 py-0.5 rounded hover:bg-white/[0.03]">
                                          <span style={{ color: 'var(--text-muted)' }}>
                                            {new Date(tx.date).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                          </span>
                                          <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                            {tx.amount.toLocaleString()} tk
                                          </span>
                                          <span className="text-[9px]" style={{ color: 'var(--text-secondary)' }}>
                                            {tx.type === 'ticketShow' ? 'チケットチャット' :
                                             tx.type === 'publicPresent' ? '公開プレゼント' :
                                             tx.type === 'privatePresent' ? '非公開プレゼント' :
                                             tx.type === 'spy' ? 'スパイ' : tx.type}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                          {/* Misses - collapsible */}
                          {misses.length > 0 && (
                            <div className="glass-panel rounded-xl overflow-hidden" style={{ background: 'rgba(244,63,94,0.04)' }}>
                              <button onClick={() => setSearchMissesOpen(!searchMissesOpen)}
                                className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-white/[0.02] transition-colors">
                                <span className="text-[10px]">{searchMissesOpen ? '▼' : '▶'}</span>
                                <span className="text-[11px] font-semibold" style={{ color: 'var(--accent-pink)' }}>
                                  ❌ 該当なし（{misses.length}名）
                                </span>
                              </button>
                              {searchMissesOpen && (
                                <div className="px-3 pb-2 space-y-0.5">
                                  {misses.map(m => (
                                    <div key={m.user_name} className="text-[11px] px-2 py-1 rounded" style={{ color: 'var(--accent-pink)' }}>
                                      {m.user_name}
                                      <span className="ml-2" style={{ color: 'var(--text-muted)' }}>— このキャストの課金履歴なし</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        );
                      })()}
                    </div>

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
                      {/* Coin range: presets + custom inputs */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold w-12" style={{ color: 'var(--text-muted)' }}>閾値:</span>
                        {([
                          { key: 'ticket', label: '初回チケット', min: 150, max: 300 },
                          { key: 'mid', label: '中堅', min: 200, max: 550 },
                          { key: 'regular', label: '常連', min: 550, max: 1400 },
                          { key: 'vip', label: 'VIP', min: 1400, max: 3500 },
                          { key: 'whale', label: 'Whale', min: 3500, max: 999999 },
                          { key: 'all', label: '全範囲', min: 0, max: 999999 },
                        ] as const).map(p => (
                          <button key={p.key} onClick={() => { setAcqMinCoins(p.min); setAcqMaxCoins(p.max); setAcqPreset(p.key); }}
                            className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                            style={{
                              background: acqPreset === p.key ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.03)',
                              color: acqPreset === p.key ? 'var(--accent-amber)' : 'var(--text-secondary)',
                              border: `1px solid ${acqPreset === p.key ? 'rgba(245,158,11,0.3)' : 'var(--border-glass)'}`,
                            }}>
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1.5 pl-14">
                        <input type="number" placeholder="min" value={acqMinCoins || ''} min={0}
                          onChange={e => { setAcqMinCoins(parseInt(e.target.value) || 0); setAcqPreset('custom'); }}
                          className="input-glass text-[10px] w-16 py-1 px-2 text-center tabular-nums" />
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>tk ～</span>
                        <input type="number" placeholder="max" value={acqMaxCoins >= 999999 ? '' : acqMaxCoins} min={0}
                          onChange={e => { setAcqMaxCoins(parseInt(e.target.value) || 999999); setAcqPreset('custom'); }}
                          className="input-glass text-[10px] w-16 py-1 px-2 text-center tabular-nums" />
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>tk</span>
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

                        {/* Ticket chat candidates (accordion) */}
                        {acqSummary.ticketCandidates.length > 0 && (
                          <div className="glass-panel rounded-xl p-3 mb-4" style={{ borderLeft: '3px solid var(--accent-amber)' }}>
                            <button
                              onClick={() => setShowTicketUsers(!showTicketUsers)}
                              className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
                            >
                              <span className="text-sm">{showTicketUsers ? '▼' : '▶'}</span>
                              <span className="text-[11px] font-bold" style={{ color: 'var(--accent-amber)' }}>
                                🎫 チケットチャット初回の可能性: {acqSummary.ticketCandidates.length}名
                              </span>
                            </button>
                            {showTicketUsers && (
                              <div className="max-h-40 overflow-y-auto mt-2 space-y-0.5">
                                {acqSummary.ticketCandidates.map(u => (
                                  <div key={u.user_name} className="flex items-center justify-between text-[10px] px-2 py-1 rounded hover:bg-white/[0.03]">
                                    <span className="truncate font-medium" style={{ color: getUserColorFromCoins(u.total_coins) }}>
                                      {u.user_name}
                                    </span>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                      <span className="tabular-nums font-bold" style={{ color: 'var(--accent-amber)' }}>
                                        {u.total_coins.toLocaleString()} tk
                                      </span>
                                      <span style={{ color: 'var(--text-muted)' }}>{u.tx_count}回</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
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
                              ) : (acqShowAll ? acqFiltered : acqFiltered.slice(0, 30)).map(u => {
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
                                      {u.last_payment_date ? new Date(u.last_payment_date).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}
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
                                        <span style={{ color: 'var(--text-muted)' }}>💌 DM済・未課金</span>
                                      ) : (
                                        <span style={{ color: 'var(--accent-green)' }}>🆕 自然流入</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {acqFiltered.length > 0 && (
                          <div className="flex items-center justify-between mt-1">
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {acqShowAll ? acqFiltered.length : Math.min(acqFiltered.length, 30)}件表示（全{acqUsers.length}件中）
                            </p>
                            {!acqShowAll && acqFiltered.length > 30 && (
                              <button
                                onClick={() => setAcqShowAll(true)}
                                className="text-[10px] px-3 py-1 rounded-lg hover:bg-white/[0.03] transition-all"
                                style={{ color: 'var(--accent-primary)' }}
                              >
                                + 残り{acqFiltered.length - 30}名を表示
                              </button>
                            )}
                            {acqShowAll && acqFiltered.length > 30 && (
                              <button
                                onClick={() => setAcqShowAll(false)}
                                className="text-[10px] px-3 py-1 rounded-lg hover:bg-white/[0.03] transition-all"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                折りたたむ
                              </button>
                            )}
                          </div>
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
                <div className="space-y-3">
                  <div className="h-8 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  <div className="grid grid-cols-4 gap-3">
                    <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  </div>
                  <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                </div>
              ) : (
                <>
                  {/* Weekly summary cards (H7: SPY vs API labels) */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>
                        {tokensToJPY(thisWeekCoins, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週売上</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-primary)' }}>チャット内チップ（SPYログ）</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--accent-amber)' }}>
                        {tokensToJPY(salesThisWeek, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週売上</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全課金（コインAPI）</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--text-secondary)' }}>
                        {tokensToJPY(salesLastWeek, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>先週売上</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全課金（コインAPI）</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{
                        color: salesLastWeek > 0 ? ((salesThisWeek - salesLastWeek) >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)') : 'var(--text-muted)'
                      }}>
                        {salesLastWeek > 0
                          ? `${(salesThisWeek - salesLastWeek) >= 0 ? '↑' : '↓'} ${Math.abs(Math.round((salesThisWeek - salesLastWeek) / salesLastWeek * 100))}%`
                          : '--'}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>前週比</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全課金（コインAPI）</p>
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
                        <p className="text-xs mt-1 font-bold">
                          <span style={{ color: 'var(--accent-amber)' }}>{formatTokens(stats?.total_coins || 0)}</span>
                          {' '}
                          <span style={{ color: 'var(--accent-green)' }}>{tokensToJPY(stats?.total_coins || 0, coinRate)}</span>
                        </p>
                      </div>
                      <div className="glass-panel p-3 rounded-xl">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="w-2 h-2 rounded-full bg-purple-400" />
                          <span className="text-[11px] font-semibold">Coin API (coin_transactions)</span>
                        </div>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Stripchat Earnings APIからの課金履歴。cast_name絞り込み済み。
                        </p>
                        <p className="text-xs mt-1 font-bold" style={{ color: 'var(--accent-amber)' }}>
                          {coinTxs.length > 0 ? `${coinTxs.length}件取得済み` : '未同期'}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        onClick={handleReassignTransactions}
                        disabled={reassigning}
                        className="btn-ghost px-4 py-2 text-[11px] rounded-lg"
                        style={{ borderColor: 'rgba(168,139,250,0.3)', color: 'var(--accent-purple, #a855f7)' }}
                      >
                        {reassigning ? '再振り分け中...' : 'トランザクション再振り分け'}
                      </button>
                      {reassignResult && reassignResult.updated >= 0 && (
                        <span className="text-[11px]" style={{ color: 'var(--accent-green)' }}>
                          {reassignResult.updated}件更新 (配信中: {reassignResult.session}, オフライン: {reassignResult.fallback})
                        </span>
                      )}
                      {reassignResult && reassignResult.updated < 0 && (
                        <span className="text-[11px]" style={{ color: 'var(--accent-pink)' }}>エラーが発生しました</span>
                      )}
                    </div>
                    <p className="text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>
                      配信セッションの時間帯に基づいてcast_nameを再割り当てします
                    </p>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Left column: Paid users */}
                    <div className="space-y-4">
                      <div className="glass-card p-4">
                        <h3 className="text-sm font-bold mb-3">有料ユーザー (このキャスト)</h3>
                      {paidUsers.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>有料ユーザーデータなし</p>
                      ) : (
                        <div className="space-y-1.5 max-h-[480px] overflow-auto">
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
                    </div>

                    {/* Right column: DM CVR + Coin history */}
                    <div className="space-y-4">
                      {/* DM Campaign CVR */}
                      {dmCvr.length > 0 && (
                        <div className="glass-card p-4">
                          <h3 className="text-sm font-bold mb-3">DM Campaign CVR</h3>
                          <div className="space-y-2">
                            {/* Header */}
                            <div className="grid grid-cols-12 gap-2 text-[10px] font-semibold px-2" style={{ color: 'var(--text-muted)' }}>
                              <div className="col-span-4">Campaign</div>
                              <div className="col-span-1 text-right">Sent</div>
                              <div className="col-span-1 text-right">Paid</div>
                              <div className="col-span-2 text-right">CVR</div>
                              <div className="col-span-2 text-right">Tokens</div>
                              <div className="col-span-2 text-right">Avg/人</div>
                            </div>
                            {/* Rows */}
                            {dmCvr.map(row => {
                              const cvrColor = row.cvr_pct >= 50 ? 'var(--accent-green)'
                                : row.cvr_pct >= 20 ? 'var(--accent-amber)'
                                : 'var(--accent-pink)';
                              const barWidth = Math.min(row.cvr_pct, 100);
                              return (
                                <div key={row.campaign}>
                                  <div
                                    className="glass-panel px-2 py-2 rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={() => setDmCvrExpanded(dmCvrExpanded === row.campaign ? null : row.campaign)}
                                  >
                                    <div className="grid grid-cols-12 gap-2 items-center text-[11px]">
                                      <div className="col-span-4 truncate font-medium">{row.campaign}</div>
                                      <div className="col-span-1 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                                        {row.dm_sent.toLocaleString()}
                                      </div>
                                      <div className="col-span-1 text-right tabular-nums font-bold" style={{ color: cvrColor }}>
                                        {row.paid_after.toLocaleString()}
                                      </div>
                                      <div className="col-span-2 text-right tabular-nums font-bold" style={{ color: cvrColor }}>
                                        {Number(row.cvr_pct).toFixed(1)}%
                                      </div>
                                      <div className="col-span-2 text-right tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                        {row.total_tokens.toLocaleString()}
                                      </div>
                                      <div className="col-span-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                                        {(row.avg_tokens_per_payer || 0).toLocaleString()}
                                      </div>
                                    </div>
                                    {/* CVR Bar */}
                                    <div className="mt-1.5 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                      <div
                                        className="h-full rounded-full transition-all"
                                        style={{ width: `${barWidth}%`, background: cvrColor }}
                                      />
                                    </div>
                                  </div>
                                  {/* Expanded detail */}
                                  {dmCvrExpanded === row.campaign && (
                                    <div className="mt-1 px-3 py-2 rounded-lg text-[10px] space-y-1" style={{ background: 'rgba(15,23,42,0.4)' }}>
                                      <div className="flex justify-between">
                                        <span style={{ color: 'var(--text-muted)' }}>初回送信</span>
                                        <span>{row.first_sent ? formatJST(row.first_sent) : '-'}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span style={{ color: 'var(--text-muted)' }}>最終送信</span>
                                        <span>{row.last_sent ? formatJST(row.last_sent) : '-'}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span style={{ color: 'var(--text-muted)' }}>合計収益</span>
                                        <span style={{ color: 'var(--accent-green)' }}>{tokensToJPY(row.total_tokens, coinRate)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span style={{ color: 'var(--text-muted)' }}>課金者平均</span>
                                        <span style={{ color: 'var(--accent-amber)' }}>{tokensToJPY(row.avg_tokens_per_payer || 0, coinRate)}</span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {/* Summary */}
                          <div className="mt-3 pt-3 flex items-center justify-between text-[10px]" style={{ borderTop: '1px solid var(--border-glass)' }}>
                            <span style={{ color: 'var(--text-muted)' }}>
                              {dmCvr.length}キャンペーン / 送信合計 {dmCvr.reduce((s, r) => s + r.dm_sent, 0).toLocaleString()}通
                            </span>
                            <span style={{ color: 'var(--accent-green)' }}>
                              総収益 {tokensToJPY(dmCvr.reduce((s, r) => s + r.total_tokens, 0), coinRate)}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Recent coin transactions */}
                      <div className="glass-card p-4">
                        <h3 className="text-sm font-bold mb-3">直近のコイン履歴 (このキャスト)</h3>
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

          {/* ============ SCREENSHOTS ============ */}
          {activeTab === 'screenshots' && (
            <div className="space-y-4">
              <div className="glass-card p-4">
                <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                  スクリーンショット履歴
                  <span className="text-[10px] px-2 py-0.5 rounded-lg"
                    style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
                    {screenshots.length} 件
                  </span>
                </h3>
                {screenshotsLoading ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {[0,1,2,3].map(i => (
                      <div key={i} className="rounded-xl overflow-hidden">
                        <div className="w-full aspect-video animate-pulse" style={{ background: 'var(--bg-card)' }} />
                        <div className="h-4 mt-2 rounded animate-pulse w-2/3" style={{ background: 'var(--bg-card)' }} />
                      </div>
                    ))}
                  </div>
                ) : screenshots.length === 0 ? (
                  <div className="text-center py-8 text-xs" style={{ color: 'var(--text-muted)' }}>
                    スクリーンショットデータなし。SPY監視中に5分間隔で自動キャプチャされます。
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {screenshots.map((ss) => {
                      const imageUrl = ss.thumbnail_url || ss.signedUrl || null;
                      return (
                        <div key={ss.id} className="glass-panel rounded-xl overflow-hidden">
                          {imageUrl ? (
                            <a href={imageUrl} target="_blank" rel="noopener noreferrer">
                              <img
                                src={imageUrl}
                                alt={ss.filename}
                                className="w-full aspect-video object-cover hover:opacity-80 transition-opacity"
                                loading="lazy"
                              />
                            </a>
                          ) : (
                            <div className="w-full aspect-video flex items-center justify-center text-[10px]"
                              style={{ background: 'rgba(15,23,42,0.6)', color: 'var(--text-muted)' }}>
                              Storage未設定
                            </div>
                          )}
                          <div className="p-2">
                            <p className="text-[10px] truncate flex items-center" style={{ color: 'var(--text-secondary)' }}>
                              {ss.filename}
                              {ss.thumbnail_url && (
                                <span className="text-[8px] px-1 py-0.5 rounded ml-1"
                                  style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--accent-green)' }}>
                                  CDN
                                </span>
                              )}
                            </p>
                            <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {formatJST(ss.captured_at)}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
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
    <Suspense fallback={
      <div className="space-y-3">
        <div className="h-8 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
        <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
      </div>
    }>
      <CastDetailInner />
    </Suspense>
  );
}
