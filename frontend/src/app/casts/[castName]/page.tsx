'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { useCoinStats } from '@/hooks/use-coin-stats';
import { ChatMessage } from '@/components/chat-message';
import { formatTokens, tokensToJPY, timeAgo, formatJST, COIN_RATE, getWeekStartJST } from '@/lib/utils';
import type { RegisteredCast, SpyMessage, UserSegment } from '@/types';
import { mapChatLog } from '@/lib/table-mappers';
import DataSyncPanel from '@/components/data-sync-panel';
import { Accordion } from '@/components/accordion';
import CastReportsTab from '@/components/cast-reports-tab';
import { PersonaTab } from '@/components/persona-tab';
import DmUserList from '@/components/dm/dm-user-list';
import DmSendPanel from '@/components/dm/dm-send-panel';
import DmSegment from '@/components/dm/dm-segment';
import DmCampaign from '@/components/dm/dm-campaign';
import DmAnalytics from '@/components/dm/dm-analytics';
import type { DmScheduleItem, DmCvrItem, ScenarioItem, EnrollmentDetail, DmEffItem } from '@/types/dm';
import type { CoinTxItem, PaidUserItem, CampaignEffect, AcquisitionUser, MonthlyPL, RevenueShareRow, HourlyPerfItem } from '@/types/analytics';
import RevenueTrend from '@/components/analytics/revenue-trend';
import FanAnalysis from '@/components/analytics/fan-analysis';
import ActivityCalendar from '@/components/calendar/activity-calendar';


/* ============================================================
   Types
   ============================================================ */
// M-6: screenshots タブはデータ0件のため非表示。SPY基盤安定後に再表示
type TabKey = 'overview' | 'sessions' | 'dm' | 'analytics' | 'calendar' | 'reports' | 'settings' | 'competitors' | 'persona';

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
  total_coins: number;        // coin_transactions ベース（v2 RPC total_revenue）
  chat_tokens: number;        // spy_messages ベース（参考値）
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


// M-6: データ0件のため無効化。SPY基盤安定後に復元
// interface ScreenshotItem {
//   id: string;
//   cast_name: string;
//   session_id: string | null;
//   image_url: string;
//   thumbnail_type: string | null;
//   captured_at: string;
// }



interface AlertRule {
  id: string;
  rule_type: string;
  threshold_value: number;
  enabled: boolean;
}

interface BroadcastSessionItem {
  session_id: string;
  title: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number;
  total_tokens: number;
  coin_revenue: number;
}

interface BroadcastBreakdown {
  session_id: string;
  session_title: string;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  revenue_by_type: Record<string, number>;
  total_tokens: number;
  unique_users: number;
  new_users: number;
  returning_users: number;
  top_users: { user_name: string; tokens: number; types: string[]; is_new: boolean }[];
  prev_session_tokens: number;
  prev_session_date: string | null;
  change_pct: number | null;
}

interface BroadcastNewUser {
  user_name: string;
  total_tokens_on_date: number;
  transaction_count: number;
  types: string[];
  has_prior_history: boolean;
}

interface PopAlert {
  id: string;
  type: string;
  title: string;
  body: string;
  detail: string;
  timestamp: number;
}

interface PersonaData {
  id?: string;
  account_id: string;
  cast_name: string;
  display_name: string | null;
  personality: string | null;
  speaking_style: string | null;
  emoji_style: string | null;
  taboo_topics: string | null;
  greeting_patterns: string[];
  dm_tone: string;
  byaf_style: string | null;
  system_prompt_base: string | null;
  system_prompt_cast: string | null;
  system_prompt_context: string | null;
}

const ALERT_RULE_LABELS: Record<string, { icon: string; label: string; defaultThreshold: number }> = {
  high_tip: { icon: '💎', label: '高額チップ', defaultThreshold: 100 },
  vip_enter: { icon: '👑', label: 'VIP入室', defaultThreshold: 0 },
  whale_enter: { icon: '🐋', label: 'Whale入室', defaultThreshold: 0 },
  new_user_tip: { icon: '🆕', label: '新規ユーザーチップ', defaultThreshold: 0 },
  viewer_milestone: { icon: '👀', label: '視聴者数マイルストーン', defaultThreshold: 50 },
};

const BASE_TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: 'overview',   icon: '📊', label: '概要' },
  { key: 'sessions',   icon: '📺', label: 'セッション' },
  { key: 'dm',         icon: '💬', label: 'DM' },
  { key: 'analytics',  icon: '📈', label: 'アナリティクス' },
  { key: 'calendar',   icon: '📅', label: '運用カレンダー' },
  { key: 'reports',    icon: '📋', label: '配信レポート' },
  { key: 'competitors', icon: '⚔', label: '競合分析' },
  // { key: 'persona',    icon: '🧠', label: 'AIペルソナ' }, // 非表示（コンポーネントは残す）
  { key: 'settings',   icon: '⚙', label: '設定' },
];

interface CompetitorEntry {
  competitor_cast_name: string;
  category: string | null;
}

interface CompetitorDiffReport {
  revenue_gap?: string;
  timing_gap?: string;
  style_gap?: string;
  audience_gap?: string;
  actionable_insights?: string[];
  competitive_advantage?: string;
  competitive_weakness?: string;
  raw?: string;
}

/* getWeekStartJST is imported from @/lib/utils */

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
  const coinRate = COIN_RATE;

  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  // Core state
  const [castInfo, setCastInfo] = useState<RegisteredCast | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [stats, setStats] = useState<CastStatsData | null>(null);
  const [fans, setFans] = useState<FanItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Competitors
  const [competitors, setCompetitors] = useState<CompetitorEntry[]>([]);
  const [competitorReport, setCompetitorReport] = useState<CompetitorDiffReport | null>(null);
  const [competitorAnalyzing, setCompetitorAnalyzing] = useState(false);
  const [competitorTarget, setCompetitorTarget] = useState<string | null>(null);
  const [competitorError, setCompetitorError] = useState<string | null>(null);

  // Dynamic TABS — hide competitors tab if no benchmark data
  const TABS = useMemo(() =>
    BASE_TABS.filter(t => t.key !== 'competitors' || competitors.length > 0),
    [competitors.length],
  );

  // Overview: weekly revenue
  const [thisWeekCoins, setThisWeekCoins] = useState(0);
  const [lastWeekCoins, setLastWeekCoins] = useState(0);
  const [totalCoinTx, setTotalCoinTx] = useState<number | null>(null);

  // Monthly revenue
  const [thisMonthCoins, setThisMonthCoins] = useState(0);
  const [lastMonthCoins, setLastMonthCoins] = useState(0);

  // Sessions
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionLogs, setSessionLogs] = useState<SpyMessage[]>([]);
  const [sessionLogsLoading, setSessionLogsLoading] = useState(false);

  // DM state (sub-tab components manage their own internal state)
  const [dmLogs, setDmLogs] = useState<DMLogItem[]>([]);
  const [dmSchedules, setDmSchedules] = useState<DmScheduleItem[]>([]);
  const [dmQueueCounts, setDmQueueCounts] = useState({ queued: 0, sending: 0, success: 0, error: 0, total: 0 });
  const [dmViewMode, setDmViewMode] = useState<'latest' | 'all'>('latest');
  const [dmLatestCampaign, setDmLatestCampaign] = useState<string | null>(null);
  const [dmSection, setDmSection] = useState<'users' | 'send' | 'segments' | 'campaigns' | 'scenarios' | 'effectiveness'>('send');

  // Analytics sub-tab toggle
  const [analyticsSection, setAnalyticsSection] = useState<'revenue' | 'fans'>('revenue');

  // DM Effectiveness state
  const [dmEffectiveness, setDmEffectiveness] = useState<DmEffItem[]>([]);
  const [dmEffLoading, setDmEffLoading] = useState(false);

  // Hourly Performance state
  const [hourlyPerf, setHourlyPerf] = useState<HourlyPerfItem[]>([]);
  const [hourlyPerfLoading, setHourlyPerfLoading] = useState(false);

  // Scenario state
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [scenarioEnrollCounts, setScenarioEnrollCounts] = useState<Map<string, number>>(new Map());
  const [scenarioEnrollDetails, setScenarioEnrollDetails] = useState<Map<string, EnrollmentDetail[]>>(new Map());
  const [scenariosLoading, setScenariosLoading] = useState(false);

  // Sales state
  const [coinTxs, setCoinTxs] = useState<CoinTxItem[]>([]);
  const [paidUsers, setPaidUsers] = useState<PaidUserItem[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesThisWeek, setSalesThisWeek] = useState(0);
  const [salesLastWeek, setSalesLastWeek] = useState(0);
  const [syncStatus, setSyncStatus] = useState<{ last: string | null; count: number }>({ last: null, count: 0 });
  const [dmCvr, setDmCvr] = useState<DmCvrItem[]>([]);

  // Analytics: retention
  const [retentionUsers, setRetentionUsers] = useState<RetentionUser[]>([]);
  const [campaignEffects, setCampaignEffects] = useState<CampaignEffect[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  // Analytics: segments
  const [segments, setSegments] = useState<UserSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);

  // Segment refresh
  const [refreshingSegments, setRefreshingSegments] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);

  // M18: Segment data load timestamp
  const [segmentsLoadedAt, setSegmentsLoadedAt] = useState<Date | null>(null);

  // Segment threshold customization
  const [segThresholdVip, setSegThresholdVip] = useState(5000);
  const [segThresholdRegular, setSegThresholdRegular] = useState(1000);
  const [segThresholdMid, setSegThresholdMid] = useState(300);
  const [segThresholdLight, setSegThresholdLight] = useState(50);

  // Coin sync alert
  const [daysSinceSync, setDaysSinceSync] = useState<number | null>(null);


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

  // Screenshots — M-6: データ0件のため無効化。SPY基盤安定後に復元
  // const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([]);
  // const [screenshotsLoading, setScreenshotsLoading] = useState(false);

  // Broadcast analysis
  const [broadcastSessions, setBroadcastSessions] = useState<BroadcastSessionItem[]>([]);
  const [broadcastSelectedDate, setBroadcastSelectedDate] = useState<string>('');
  const [broadcastBreakdown, setBroadcastBreakdown] = useState<BroadcastBreakdown | null>(null);
  const [broadcastNewUsers, setBroadcastNewUsers] = useState<BroadcastNewUser[]>([]);
  const [broadcastLoading, setBroadcastLoading] = useState(false);
  const [broadcastDetailLoading, setBroadcastDetailLoading] = useState(false);

  // Persona
  const [persona, setPersona] = useState<PersonaData | null>(null);
  const [personaLoading, setPersonaLoading] = useState(false);
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaForm, setPersonaForm] = useState<Partial<PersonaData>>({});
  const [personaTestResult, setPersonaTestResult] = useState<string | null>(null);
  const [personaTestLoading, setPersonaTestLoading] = useState(false);

  // Overlap (競合分析)
  const [overlapMatrix, setOverlapMatrix] = useState<{ own_cast: string; spy_cast: string; overlap_users: number; overlap_tokens: number; own_total_users: number }[]>([]);
  const [spyTopUsers, setSpyTopUsers] = useState<{ user_name: string; spy_casts: string[]; spy_total_tokens: number; own_total_coins: number; own_segment: string | null; cast_count: number }[]>([]);
  const [overlapLoading, setOverlapLoading] = useState(false);
  const [overlapRefreshing, setOverlapRefreshing] = useState(false);
  const [lastProfileUpdate, setLastProfileUpdate] = useState<string | null>(null);

  // Health tab
  interface CastHealth {
    cast_name: string; schedule_consistency: number; revenue_trend: number;
    dm_dependency: number; broadcast_quality: number; independence_risk: number;
    mental_health_flag: boolean; overall_health: number;
  }
  const [castHealth, setCastHealth] = useState<CastHealth | null>(null);
  const [castHealthLoading, setCastHealthLoading] = useState(false);
  interface SessionQuality {
    session_id: string; cast_name: string; session_date: string;
    duration_minutes: number; peak_viewers: number; total_coins: number;
    chat_count: number; tip_per_viewer: number; chat_per_minute: number;
    quality_score: number;
  }
  const [sessionQualities, setSessionQualities] = useState<SessionQuality[]>([]);

  // Settings tab
  const [settingsModelId, setSettingsModelId] = useState<string>('');
  const [settingsPlatform, setSettingsPlatform] = useState<string>('stripchat');
  const [settingsAvatarUrl, setSettingsAvatarUrl] = useState<string>('');
  const [settingsDisplayName, setSettingsDisplayName] = useState<string>('');
  const [settingsNotes, setSettingsNotes] = useState<string>('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsAutoFetching, setSettingsAutoFetching] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Cost settings (P/L)
  const [costHourlyRate, setCostHourlyRate] = useState<string>('0');
  const [costMonthlyFixed, setCostMonthlyFixed] = useState<string>('0');
  const [costPlatformFee, setCostPlatformFee] = useState<string>('40.00');
  const [costTokenJpy, setCostTokenJpy] = useState<string>('5.5');
  const [costBonusRate, setCostBonusRate] = useState<string>('0');
  const [costSaving, setCostSaving] = useState(false);
  const [costMsg, setCostMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [costLoaded, setCostLoaded] = useState(false);

  // Session P/L
  interface SessionPL {
    session_id: string; cast_name: string; session_date: string;
    started_at: string; ended_at: string | null; duration_minutes: number;
    total_tokens: number; peak_viewers: number;
    gross_revenue_jpy: number; platform_fee_jpy: number; net_revenue_jpy: number;
    cast_cost_jpy: number; gross_profit_jpy: number; profit_margin: number;
    hourly_rate: number; token_to_jpy: number;
  }
  const [sessionPL, setSessionPL] = useState<SessionPL[]>([]);
  const [sessionPLLoading, setSessionPLLoading] = useState(false);
  const [sessionPLError, setSessionPLError] = useState(false);

  // Monthly P/L
  const [monthlyPL, setMonthlyPL] = useState<MonthlyPL[]>([]);
  const [monthlyPLLoading, setMonthlyPLLoading] = useState(false);
  const [monthlyPLError, setMonthlyPLError] = useState(false);

  // Revenue Share
  const [revenueShare, setRevenueShare] = useState<RevenueShareRow[]>([]);
  const [revenueShareLoading, setRevenueShareLoading] = useState(false);

  // Realtime: paid_users color cache
  const [paidUserCoins, setPaidUserCoins] = useState<Map<string, number>>(new Map());

  // Realtime
  const { messages: realtimeMessages, isConnected } = useRealtimeSpy({
    castName,
    enabled: !!user && activeTab === 'sessions',
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

  // Competitor diff analysis
  const runCompetitorDiff = useCallback(async (competitorName: string) => {
    setCompetitorAnalyzing(true);
    setCompetitorError(null);
    setCompetitorReport(null);
    setCompetitorTarget(competitorName);
    try {
      const res = await fetch('/api/analysis/run-competitor-diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cast_name: castName, competitor_cast_name: competitorName, account_id: accountId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCompetitorError(data.error || '分析に失敗しました');
      } else {
        setCompetitorReport(data.diff_report || null);
      }
    } catch {
      setCompetitorError('通信エラーが発生しました');
    } finally {
      setCompetitorAnalyzing(false);
    }
  }, [castName, accountId]);

  // ============================================================
  // Load account + cast info
  // ============================================================
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  // Load competitor benchmarks
  useEffect(() => {
    fetch(`/api/data/competitors?cast_name=${encodeURIComponent(castName)}`)
      .then(r => r.json())
      .then(d => { console.log('[competitors]', d); if (d.competitors) setCompetitors(d.competitors); })
      .catch(e => console.error('[competitors] fetch error:', e));
  }, [castName]);

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

  const { totalTokens: hookTotalTokens, thisWeekTokens: hookThisWeek, lastWeekTokens: hookLastWeek, daysSinceSync: hookDaysSync } = useCoinStats({ accountId, castName, registeredAt });

  useEffect(() => {
    setTotalCoinTx(hookTotalTokens);
    setThisWeekCoins(hookThisWeek);
    setLastWeekCoins(hookLastWeek);
    setDaysSinceSync(hookDaysSync);
  }, [hookTotalTokens, hookThisWeek, hookLastWeek, hookDaysSync]);

  // Monthly revenue (RPC サーバー側SUM集計 — max_rows制限回避 + TZずれ修正)
  useEffect(() => {
    if (!accountId || !castName) return;
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth(); // 0-based
    // UTC文字列を直接構築（TZずれ防止）
    const pad = (n: number) => String(n).padStart(2, '0');
    const thisMonthStart = `${y}-${pad(m + 1)}-01`;
    const thisMonthEnd = m === 11 ? `${y + 1}-01-01` : `${y}-${pad(m + 2)}-01`;
    const lastY = m === 0 ? y - 1 : y;
    const lastM = m === 0 ? 12 : m; // 1-based for display
    const lastMonthStart = `${lastY}-${pad(lastM)}-01`;
    const lastMonthEnd = thisMonthStart; // 先月末 = 今月頭

    // 今月
    sb.rpc('get_monthly_revenue', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_start_date: thisMonthStart,
      p_end_date: thisMonthEnd,
    }).then(({ data }) => {
      const row = Array.isArray(data) ? data[0] : data;
      setThisMonthCoins(row?.total_tokens ?? 0);
    });
    // 先月
    sb.rpc('get_monthly_revenue', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_start_date: lastMonthStart,
      p_end_date: lastMonthEnd,
    }).then(({ data }) => {
      const row = Array.isArray(data) ? data[0] : data;
      setLastMonthCoins(row?.total_tokens ?? 0);
    });
  }, [accountId, castName, sb]);

  // Settings: castInfo → form state sync
  useEffect(() => {
    if (!castInfo) return;
    setSettingsModelId(castInfo.model_id?.toString() || castInfo.stripchat_model_id || '');
    setSettingsPlatform(castInfo.platform || 'stripchat');
    setSettingsAvatarUrl(castInfo.avatar_url || '');
    setSettingsDisplayName(castInfo.display_name || '');
    setSettingsNotes(castInfo.notes || '');
  }, [castInfo]);

  // Cost settings: load from cast_cost_settings
  useEffect(() => {
    if (!accountId || (activeTab !== 'settings' && activeTab !== 'analytics') || costLoaded) return;
    sb.from('cast_cost_settings')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setCostHourlyRate(String(data.hourly_rate || 0));
          setCostMonthlyFixed(String(data.monthly_fixed_cost || 0));
          setCostPlatformFee(String(data.platform_fee_rate || 40));
          setCostTokenJpy(String(data.token_to_jpy || 5.5));
          setCostBonusRate(String(data.bonus_rate || 0));
        }
        setCostLoaded(true);
      });
  }, [accountId, castName, activeTab, costLoaded, sb]);

  // Session P/L: load when analytics tab active
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setSessionPLLoading(true);
    setSessionPLError(false);
    sb.rpc('get_session_pl', { p_account_id: accountId, p_cast_name: castName, p_days: 90 })
      .then(({ data, error }) => {
        if (error) {
          console.warn('[SessionPL] RPC error:', error.message);
          setSessionPLError(true);
        } else if (data) {
          // total_coins → total_tokens マッピング（旧RPC互換）
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setSessionPL((data as SessionPL[]).map((r: any) => ({
            ...r,
            total_tokens: r.total_tokens ?? r.total_coins ?? 0,
          })));
        }
        setSessionPLLoading(false);
      });
  }, [accountId, castName, activeTab, sb]);

  // Monthly P/L: load when analytics tab active
  // 082未適用の場合は2引数版にフォールバック + クライアントサイドフィルタ
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setMonthlyPLLoading(true);
    setMonthlyPLError(false);
    sb.rpc('get_monthly_pl', { p_account_id: accountId, p_cast_name: castName, p_months: 6 })
      .then(({ data, error }) => {
        if (error?.code === 'PGRST202') {
          // 082未適用: 2引数版にフォールバック
          return sb.rpc('get_monthly_pl', { p_account_id: accountId, p_months: 6 });
        }
        return { data, error };
      })
      .then(({ data, error }) => {
        if (error) {
          console.warn('[MonthlyPL] RPC error:', error.message);
          setMonthlyPLError(true);
        } else if (data) {
          // cast_nameでフィルタ（2引数版は全キャスト返す）
          const filtered = (data as MonthlyPL[]).filter(
            r => r.cast_name === castName
          );
          // total_coins → total_tokens マッピング（旧RPC互換）
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setMonthlyPL(filtered.map((r: any) => ({
            ...r,
            total_tokens: r.total_tokens ?? r.total_coins ?? 0,
          })));
        }
        setMonthlyPLLoading(false);
      });
  }, [accountId, castName, activeTab, sb]);

  // Revenue Share: load when analytics tab active (past 90 days)
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setRevenueShareLoading(true);
    const now = new Date();
    const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = now.toISOString().slice(0, 10);
    // Enforce data cutoff
    const safeStart = startStr < '2025-02-15' ? '2025-02-15' : startStr;
    sb.rpc('calculate_revenue_share', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_start_date: safeStart,
      p_end_date: endStr,
    }).then(({ data, error }) => {
      if (!error && data) setRevenueShare(data as RevenueShareRow[]);
      setRevenueShareLoading(false);
    });
  }, [accountId, castName, activeTab, sb]);

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
  // Realtime: paid_users color cache
  // ============================================================
  useEffect(() => {
    if (activeTab !== 'sessions' || !accountId) return;
    sb.from('user_profiles')
      .select('username, total_tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('total_tokens', { ascending: false })
      .limit(500)
      .then(({ data }) => {
        const map = new Map<string, number>();
        (data || []).forEach((u: { username: string; total_tokens: number }) => {
          map.set(u.username, u.total_tokens);
        });
        setPaidUserCoins(map);
      });
  }, [activeTab, accountId, castName, sb]);

  // ============================================================
  // Sessions: v2 RPC（coin_transactionsベース売上）
  // ============================================================
  useEffect(() => {
    if (!accountId || (activeTab !== 'overview' && activeTab !== 'sessions')) return;
    sb.rpc('get_session_list_v2', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_limit: 100,
      p_offset: 0,
    }).then(({ data, error }) => {
      if (error || !data) {
        setSessions([]);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped: SessionItem[] = (data as any[]).map(r => {
        const d = new Date(r.session_start);
        const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
        const sessionDate = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
        return {
          session_date: sessionDate,
          session_start: r.session_start,
          session_end: r.session_end,
          message_count: r.msg_count ?? 0,
          tip_count: r.tip_count ?? 0,
          total_coins: r.total_revenue ?? 0,   // coin_transactions ベース
          chat_tokens: r.chat_tokens ?? 0,      // spy_messages ベース
          unique_users: r.unique_users ?? 0,
          broadcast_title: r.session_title ?? null,
        };
      });
      setSessions(mapped);
    });
  }, [accountId, castName, activeTab, sb]);

  // Session expand: load logs
  const handleExpandSession = useCallback(async (sessionKey: string, start: string, end: string) => {
    if (expandedSession === sessionKey) { setExpandedSession(null); return; }
    setExpandedSession(sessionKey);
    setSessionLogsLoading(true);
    const { data } = await sb.from('chat_logs')
      .select('*')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .gte('timestamp', start)
      .lte('timestamp', end)
      .order('timestamp', { ascending: true })
      .limit(1000);
    setSessionLogs((data || []).map(mapChatLog) as SpyMessage[]);
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
      .then(({ data }) => {
        const logs = (data || []) as DMLogItem[];
        setDmLogs(logs);
        // 最新キャンペーンを特定
        const latest = logs.length > 0 ? logs[0].campaign : null;
        setDmLatestCampaign(latest);
        // Queue counts computation（dmViewModeに応じてフィルタ）
        const target = dmViewMode === 'latest' && latest
          ? logs.filter(l => l.campaign === latest)
          : logs;
        const counts = { queued: 0, sending: 0, success: 0, error: 0, total: target.length };
        target.forEach(l => {
          if (l.status === 'queued') counts.queued++;
          else if (l.status === 'sending') counts.sending++;
          else if (l.status === 'success') counts.success++;
          else if (l.status === 'error') counts.error++;
        });
        setDmQueueCounts(counts);
      });

  }, [accountId, castName, activeTab, sb]);

  // dmViewMode切替時にカウント再計算
  useEffect(() => {
    if (dmLogs.length === 0) return;
    const target = dmViewMode === 'latest' && dmLatestCampaign
      ? dmLogs.filter(l => l.campaign === dmLatestCampaign)
      : dmLogs;
    const counts = { queued: 0, sending: 0, success: 0, error: 0, total: target.length };
    target.forEach(l => {
      if (l.status === 'queued') counts.queued++;
      else if (l.status === 'sending') counts.sending++;
      else if (l.status === 'success') counts.success++;
      else if (l.status === 'error') counts.error++;
    });
    setDmQueueCounts(counts);
  }, [dmViewMode, dmLatestCampaign, dmLogs]);

  useEffect(() => {
    if (!accountId || activeTab !== 'dm') return;
    // スケジュール一覧取得
    sb.from('dm_schedules')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('scheduled_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setDmSchedules((data || []) as DmScheduleItem[]));

    // シナリオ一覧取得
    setScenariosLoading(true);
    sb.from('dm_scenarios')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .then(async ({ data: scData }) => {
        const items = (scData || []) as ScenarioItem[];
        setScenarios(items);
        // エンロール数+詳細を取得
        if (items.length > 0) {
          const { data: enrollData } = await sb
            .from('dm_scenario_enrollments')
            .select('scenario_id, user_name, current_step, status, enrolled_at')
            .eq('account_id', accountId)
            .eq('cast_name', castName)
            .eq('status', 'active')
            .order('enrolled_at', { ascending: false })
            .limit(50000);
          const countMap = new Map<string, number>();
          const detailMap = new Map<string, EnrollmentDetail[]>();
          for (const e of (enrollData || []) as EnrollmentDetail[]) {
            countMap.set(e.scenario_id, (countMap.get(e.scenario_id) || 0) + 1);
            if (!detailMap.has(e.scenario_id)) detailMap.set(e.scenario_id, []);
            detailMap.get(e.scenario_id)!.push(e);
          }
          setScenarioEnrollCounts(countMap);
          setScenarioEnrollDetails(detailMap);
        }
        setScenariosLoading(false);
      });
  }, [accountId, castName, activeTab, sb]);

  // DM Effectiveness by segment
  useEffect(() => {
    if (!accountId || activeTab !== 'dm' || dmSection !== 'effectiveness') return;
    setDmEffLoading(true);
    sb.rpc('get_dm_effectiveness_by_segment', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_days: 30,
    }).then(({ data, error }) => {
      if (!error && data) setDmEffectiveness(data as DmEffItem[]);
      setDmEffLoading(false);
    });
  }, [accountId, castName, activeTab, dmSection, sb]);

  // Hourly Performance
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setHourlyPerfLoading(true);
    sb.rpc('get_cast_hourly_performance', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_days: 30,
    }).then(({ data, error }) => {
      if (!error && data) setHourlyPerf(data as HourlyPerfItem[]);
      setHourlyPerfLoading(false);
    });
  }, [accountId, castName, activeTab, sb]);


  // DM send

  // DM quick actions

  // DM text input: parse URLs/usernames and add to targets

  // DM Schedule: 予約作成

  // DM Schedule: キャンセル

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

    sb.rpc('get_user_segments', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_threshold_vip: segThresholdVip,
        p_threshold_regular: segThresholdRegular,
        p_threshold_mid: segThresholdMid,
        p_threshold_light: segThresholdLight,
      })
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
    // 最後のチップ（このキャストのchat_logs）
    sb.from('chat_logs')
      .select('username, tokens, timestamp, message')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('message_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .order('timestamp', { ascending: false })
      .limit(5)
      .then(({ data }) => setLastTips((data || []).map(r => ({ user_name: r.username, tokens: r.tokens, message_time: r.timestamp, message: r.message })) as typeof lastTips));

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

  // ============================================================
  // Sales: coin_transactions (cast_name絞り込み) + paid_users
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setSalesLoading(true);
    const thisMonday = getWeekStartJST(0);
    const lastMonday = getWeekStartJST(1);

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
  // Sales: DM Campaign CVR（クロスキャスト課金を反映）
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    const since = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    // 1) このキャストのキャンペーン一覧（dm_send_log.cast_name でフィルタ）
    const strictP = sb.rpc('get_dm_campaign_cvr', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_since: since,
    });
    // 2) 全キャスト横断のCVR（coin_transactions.cast_nameフィルタなし → クロスキャスト課金を拾う）
    const broadP = sb.rpc('get_dm_campaign_cvr', {
      p_account_id: accountId,
      p_since: since,
    });
    Promise.all([strictP, broadP]).then(([strictRes, broadRes]) => {
      const strict = (strictRes.data || []) as DmCvrItem[];
      const broad = (broadRes.data || []) as DmCvrItem[];
      const broadMap = new Map(broad.map(r => [r.campaign, r]));
      // strictのキャンペーン一覧を使い、CVR数値はbroadから取る（クロスキャスト課金反映）
      const merged: DmCvrItem[] = strict.map(s => {
        const b = broadMap.get(s.campaign);
        if (!b) return s;
        return {
          ...s,
          paid_after: b.paid_after,
          cvr_pct: b.cvr_pct,
          total_tokens: b.total_tokens,
          avg_tokens_per_payer: b.avg_tokens_per_payer,
          visited_after: b.visited_after ?? s.visited_after,
          visit_cvr_pct: b.visit_cvr_pct ?? s.visit_cvr_pct,
        };
      });
      setDmCvr(merged);
    });
  }, [accountId, castName, activeTab, sb]);

  // ============================================================
  // Broadcast analysis: セッション一覧取得（v2 RPC — coin_transactionsベース売上）
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'sessions') return;
    setBroadcastLoading(true);
    sb.rpc('get_session_list_v2', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_limit: 50,
      p_offset: 0,
    }).then(({ data, error }) => {
      if (error || !data) {
        setBroadcastSessions([]);
        setBroadcastLoading(false);
        return;
      }
      // 2/15以降のみ表示
      const cutoff = new Date('2026-02-15T00:00:00+09:00');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped: BroadcastSessionItem[] = (data as any[]).map(r => ({
        session_id: r.broadcast_group_id ?? r.session_ids?.[0] ?? '',
        title: r.session_title ?? '',
        started_at: r.started_at,
        ended_at: r.ended_at,
        duration_minutes: r.duration_minutes ?? 0,
        total_tokens: r.chat_tokens ?? 0,      // spy_messages ベース（参考値）
        coin_revenue: r.total_revenue ?? 0,     // coin_transactions ベース
      }));
      const filtered = mapped.filter(s => new Date(s.started_at) >= cutoff);
      setBroadcastSessions(filtered);
      // 最新セッションを自動選択
      if (filtered.length > 0 && !broadcastSelectedDate) {
        const latest = filtered[0];
        const dateStr = new Date(latest.started_at).toISOString().split('T')[0];
        setBroadcastSelectedDate(dateStr);
      }
      setBroadcastLoading(false);
    });
  }, [accountId, castName, activeTab, sb]);

  // Broadcast analysis: 選択セッションの詳細取得
  useEffect(() => {
    if (!accountId || !broadcastSelectedDate || activeTab !== 'sessions') return;
    setBroadcastDetailLoading(true);
    setBroadcastBreakdown(null);
    setBroadcastNewUsers([]);

    Promise.all([
      sb.rpc('get_session_revenue_breakdown', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_session_date: broadcastSelectedDate,
      }),
      sb.rpc('get_new_users_by_session', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_session_date: broadcastSelectedDate,
      }),
    ]).then(([breakdownRes, newUsersRes]) => {
      if (breakdownRes.data && breakdownRes.data.length > 0) {
        const row = breakdownRes.data[0] as BroadcastBreakdown;
        // top_users がJSONB文字列の場合をパース
        if (typeof row.top_users === 'string') {
          try { row.top_users = JSON.parse(row.top_users); } catch { row.top_users = []; }
        }
        if (typeof row.revenue_by_type === 'string') {
          try { row.revenue_by_type = JSON.parse(row.revenue_by_type); } catch { row.revenue_by_type = {}; }
        }
        setBroadcastBreakdown(row);
      }
      if (newUsersRes.data) {
        setBroadcastNewUsers(newUsersRes.data as BroadcastNewUser[]);
      }
      setBroadcastDetailLoading(false);
    });
  }, [accountId, castName, broadcastSelectedDate, activeTab, sb]);

  // ============================================================
  // Screenshots — M-6: データ0件のため無効化。SPY基盤安定後に復元
  // ============================================================
  // useEffect(() => {
  //   if (!accountId || activeTab !== 'screenshots') return;
  //   setScreenshotsLoading(true);
  //   (async () => {
  //     const { data, error } = await sb.from('cast_screenshots')
  //       .select('id, cast_name, session_id, image_url, thumbnail_type, captured_at')
  //       .eq('account_id', accountId)
  //       .eq('cast_name', castName)
  //       .order('captured_at', { ascending: false })
  //       .limit(100);
  //     if (error || !data) {
  //       setScreenshotsLoading(false);
  //       return;
  //     }
  //     setScreenshots(data as ScreenshotItem[]);
  //     setScreenshotsLoading(false);
  //   })();
  // }, [accountId, castName, activeTab, sb]);

  // ============================================================
  // Persona
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'dm') return;
    setPersonaLoading(true);
    (async () => {
      try {
        const { data: session } = await sb.auth.getSession();
        const token = session?.session?.access_token;
        if (!token) { setPersonaLoading(false); return; }

        const res = await fetch(`/api/persona?cast_name=${encodeURIComponent(castName)}&account_id=${accountId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (json.persona) {
          setPersona(json.persona);
          setPersonaForm(json.persona);
        } else {
          // デフォルト値を設定
          const defaults: Partial<PersonaData> = {
            account_id: accountId,
            cast_name: castName,
            display_name: '',
            personality: '',
            speaking_style: '',
            emoji_style: '',
            taboo_topics: '',
            dm_tone: 'friendly',
            byaf_style: '',
            system_prompt_base: '',
            system_prompt_cast: '',
          };
          setPersona(null);
          setPersonaForm(defaults);
        }
      } catch { /* ignore */ }
      setPersonaLoading(false);
    })();
  }, [accountId, castName, activeTab, sb]);

  // ─── Overlap (競合分析) データロード ───
  // NOTE: get_user_overlap_matrix, get_spy_top_users, spy_user_profiles は未実装RPC/テーブル
  // PGRST202エラーを安全にスキップし、実装時に有効化する
  useEffect(() => {
    if (!accountId || activeTab !== 'analytics') return;
    setOverlapLoading(true);
    (async () => {
      try {
        const matrixRes = await sb.rpc('get_user_overlap_matrix', { p_account_id: accountId });
        if (matrixRes.error?.code !== 'PGRST202' && matrixRes.data) setOverlapMatrix(matrixRes.data);
        const topRes = await sb.rpc('get_spy_top_users', { p_account_id: accountId, p_limit: 50 });
        if (topRes.error?.code !== 'PGRST202' && topRes.data) setSpyTopUsers(topRes.data);
      } catch (e) {
        console.warn('[Overlap] RPC not available:', e);
      }
      setOverlapLoading(false);
    })();
  }, [accountId, activeTab, sb]);

  // ─── Overlap: プロフィール集計更新 ───
  const handleRefreshProfiles = useCallback(async () => {
    if (!accountId || overlapRefreshing) return;
    setOverlapRefreshing(true);
    try {
      const { data, error } = await sb.rpc('refresh_spy_user_profiles', { p_account_id: accountId });
      if (error) {
        if (error.code === 'PGRST202') {
          alert('この機能は準備中です');
        } else {
          alert(`集計エラー: ${error.message || '不明'}`);
        }
        setOverlapRefreshing(false);
        return;
      }
      alert(`プロフィール集計完了: ${data}件更新`);
      const matrixRes = await sb.rpc('get_user_overlap_matrix', { p_account_id: accountId });
      if (matrixRes.data) setOverlapMatrix(matrixRes.data);
      const topRes = await sb.rpc('get_spy_top_users', { p_account_id: accountId, p_limit: 50 });
      if (topRes.data) setSpyTopUsers(topRes.data);
      setLastProfileUpdate(new Date().toISOString());
    } catch (e: any) {
      alert(`集計エラー: ${e.message || '不明'}`);
    }
    setOverlapRefreshing(false);
  }, [accountId, overlapRefreshing, sb]);

  // ─── Health (健全性) データロード ───
  useEffect(() => {
    if (!accountId || activeTab !== 'settings') return;
    setCastHealthLoading(true);
    (async () => {
      try {
        const [healthRes, qualityRes] = await Promise.all([
          sb.rpc('calc_cast_health_score', { p_account_id: accountId, p_cast_name: castName }),
          sb.rpc('calc_session_quality_score', { p_account_id: accountId, p_cast_name: castName, p_days: 30 }),
        ]);
        if (healthRes.data?.[0]) setCastHealth(healthRes.data[0]);
        if (qualityRes.data) setSessionQualities(qualityRes.data.slice(0, 20));
      } catch { /* ignore */ }
      setCastHealthLoading(false);
    })();
  }, [accountId, activeTab, castName, sb]);

  const handlePersonaSave = useCallback(async () => {
    if (!accountId) return;
    setPersonaSaving(true);
    try {
      const { data: session } = await sb.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) { setPersonaSaving(false); return; }

      const res = await fetch('/api/persona', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ account_id: accountId, cast_name: castName, ...personaForm }),
      });
      const json = await res.json();
      if (json.persona) {
        setPersona(json.persona);
        setPersonaForm(json.persona);
      }
    } catch { /* ignore */ }
    setPersonaSaving(false);
  }, [accountId, castName, personaForm, sb]);

  const handlePersonaTestDm = useCallback(async (templateType: string) => {
    if (!accountId) return;
    setPersonaTestLoading(true);
    setPersonaTestResult(null);
    try {
      const { data: session } = await sb.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) { setPersonaTestLoading(false); return; }

      const res = await fetch('/api/persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          mode: 'generate',
          cast_name: castName,
          account_id: accountId,
          target_username: 'TestUser123',
          template_type: templateType,
        }),
      });
      const json = await res.json();
      setPersonaTestResult(json.message || json.error || '生成失敗');
    } catch { setPersonaTestResult('エラーが発生しました'); }
    setPersonaTestLoading(false);
  }, [accountId, castName, sb]);

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
        // セグメントデータをリロード（カスタム閾値反映）
        sb.rpc('get_user_segments', {
          p_account_id: accountId,
          p_cast_name: castName,
          p_threshold_vip: segThresholdVip,
          p_threshold_regular: segThresholdRegular,
          p_threshold_mid: segThresholdMid,
          p_threshold_light: segThresholdLight,
        })
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
  }, [accountId, castName, sb, segThresholdVip, segThresholdRegular, segThresholdMid, segThresholdLight]);

  // Navigate to DM tab with segment targets (H6: segment context in campaign)
  const sendSegmentDm = useCallback((_segmentId: string, _segmentName: string) => {
    // DM prefill moved to DmSendPanel component — navigate to DM tab only
    setTab('dm');
  }, [setTab]);

  // Navigate to DM tab (H6: retention context in campaign)
  const sendRetentionDm = useCallback((_usernames: string[], _campaign: string) => {
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
  const monthlyChange = lastMonthCoins > 0 ? ((thisMonthCoins - lastMonthCoins) / lastMonthCoins * 100) : 0;
  const MONTHLY_COIN_RATE = 7.7;

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
              <span style={{ color: 'var(--text-muted)' }}>
                <span className="text-[10px]">({tokensToJPY(totalCoinTx ?? stats.total_coins, coinRate)})</span>
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

{/* Coin sync alert — replaced by DataSyncPanel in overview tab */}

      {loading && activeTab !== 'sessions' ? (
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
            <div className="space-y-4">
                {/* Monthly revenue */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>
                      {formatTokens(thisMonthCoins)}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今月の売上（{`${new Date().getMonth() + 1}/1〜${new Date().getMonth() + 1}/${new Date().getDate()}`}）</p>
                    <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                      ({'\u00A5'}{Math.round(thisMonthCoins * MONTHLY_COIN_RATE).toLocaleString()})
                    </p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--text-secondary)' }}>
                      {formatTokens(lastMonthCoins)}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>先月の売上（{`${new Date().getMonth() || 12}/1〜${new Date().getMonth() || 12}/${new Date(new Date().getFullYear(), new Date().getMonth(), 0).getDate()}`}）</p>
                    <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                      ({'\u00A5'}{Math.round(lastMonthCoins * MONTHLY_COIN_RATE).toLocaleString()})
                    </p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{
                      color: monthlyChange >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)'
                    }}>
                      {monthlyChange >= 0 ? '↑' : '↓'} {Math.abs(monthlyChange).toFixed(0)}%
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>前月比</p>
                  </div>
                </div>

                {/* Weekly revenue */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>
                      {formatTokens(thisWeekCoins)}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週の売上（{(() => { const m = getWeekStartJST(0); return `${m.getMonth()+1}/${m.getDate()}〜${new Date().getMonth()+1}/${new Date().getDate()}`; })()}）</p>
                    <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(thisWeekCoins, coinRate)})</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--text-secondary)' }}>
                      {formatTokens(lastWeekCoins)}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>先週の売上（{(() => { const m = getWeekStartJST(1); const e = getWeekStartJST(0); e.setDate(e.getDate()-1); return `${m.getMonth()+1}/${m.getDate()}〜${e.getMonth()+1}/${e.getDate()}`; })()}）</p>
                    <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(lastWeekCoins, coinRate)})</p>
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
                    <p className="text-xl font-bold">{(stats?.total_messages ?? 0).toLocaleString()}</p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>総メッセージ</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--accent-purple, #a855f7)' }}>
                      {stats?.unique_users || 0}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>ユニークユーザー</p>
                  </div>
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
                            {s.session_date} {formatJST(s.session_start).split(' ')[1]?.slice(0, 5)}〜{s.session_end ? formatJST(s.session_end).split(' ')[1]?.slice(0, 5) : '配信中'}
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

          {/* ============ BROADCAST ANALYSIS ============ */}
          {activeTab === 'sessions' && (
            <div className="space-y-4">
              {broadcastLoading ? (
                <div className="space-y-3">
                  <div className="h-12 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  <div className="h-40 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                </div>
              ) : broadcastSessions.length === 0 ? (
                <div className="glass-card p-8 text-center">
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    2/15以降の配信セッションがありません
                  </p>
                </div>
              ) : (
                <>
                  {/* セッションセレクター */}
                  <div className="glass-card p-4">
                    <div className="flex items-center gap-3">
                      <label className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>配信日を選択:</label>
                      <select
                        value={broadcastSelectedDate}
                        onChange={e => setBroadcastSelectedDate(e.target.value)}
                        className="input-glass text-sm px-3 py-1.5 rounded-lg"
                        style={{ maxWidth: '280px' }}
                      >
                        {broadcastSessions.map(s => {
                          const d = new Date(s.started_at);
                          const dateStr = d.toISOString().split('T')[0];
                          const label = `${d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' })} — ${formatTokens(s.coin_revenue)}tk (${s.duration_minutes}分)`;
                          return <option key={s.session_id} value={dateStr}>{label}</option>;
                        })}
                      </select>
                    </div>
                  </div>

                  {broadcastDetailLoading ? (
                    <div className="space-y-3">
                      <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                      <div className="h-48 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    </div>
                  ) : broadcastBreakdown ? (
                    <>
                      {/* サマリーカード */}
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <div className="glass-card p-4">
                          <p className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>売上</p>
                          <p className="text-2xl font-bold text-amber-400 mt-1">{formatTokens(broadcastBreakdown.total_tokens)}</p>
                          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            ({tokensToJPY(broadcastBreakdown.total_tokens, coinRate)})
                          </p>
                          {broadcastBreakdown.change_pct !== null && (
                            <p className={`text-[10px] mt-1 font-bold ${broadcastBreakdown.change_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {broadcastBreakdown.change_pct >= 0 ? '+' : ''}{broadcastBreakdown.change_pct}% 前回比
                            </p>
                          )}
                        </div>
                        <div className="glass-card p-4">
                          <p className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>ユニークユーザー</p>
                          <p className="text-2xl font-bold text-sky-400 mt-1">{broadcastBreakdown.unique_users}<span className="text-xs ml-1">名</span></p>
                        </div>
                        <div className="glass-card p-4">
                          <p className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>新規</p>
                          <p className="text-2xl font-bold text-emerald-400 mt-1">{broadcastBreakdown.new_users}<span className="text-xs ml-1">名</span></p>
                        </div>
                        <div className="glass-card p-4">
                          <p className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>リピーター</p>
                          <p className="text-2xl font-bold text-purple-400 mt-1">{broadcastBreakdown.returning_users}<span className="text-xs ml-1">名</span></p>
                        </div>
                      </div>

                      <Accordion id={`cast-${castName}-revenue-type`} title="売上タイプ別内訳" icon="📊" defaultOpen={false}>
                      {/* 売上タイプ別内訳 */}
                      {Object.keys(broadcastBreakdown.revenue_by_type).length > 0 && (
                        <div className="glass-card p-4">
                          <h3 className="text-sm font-bold mb-3">売上タイプ別内訳</h3>
                          <div className="space-y-2">
                            {Object.entries(broadcastBreakdown.revenue_by_type)
                              .sort(([, a], [, b]) => b - a)
                              .map(([type, tokens]) => {
                                const pct = broadcastBreakdown.total_tokens > 0
                                  ? Math.round((tokens / broadcastBreakdown.total_tokens) * 100)
                                  : 0;
                                return (
                                  <div key={type}>
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-xs font-medium">{type}</span>
                                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                        {formatTokens(tokens)} ({pct}%) — {tokensToJPY(tokens, coinRate)}
                                      </span>
                                    </div>
                                    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.6)' }}>
                                      <div
                                        className="h-full rounded-full transition-all duration-500"
                                        style={{
                                          width: `${pct}%`,
                                          background: type === 'tip' ? 'var(--accent-amber)' :
                                            type === 'private' ? 'var(--accent-pink)' :
                                            type === 'spy' ? 'var(--accent-purple)' :
                                            type === 'ticket' ? 'var(--accent-green)' : 'var(--accent-primary)',
                                        }}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      )}

                      </Accordion>

                      {/* 新規 vs リピーター 比較 */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        <div className="glass-card p-4">
                          <h3 className="text-sm font-bold mb-2 flex items-center gap-2">
                            <span className="text-emerald-400">🆕</span> 新規ユーザー
                          </h3>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="glass-panel p-3 rounded-lg">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>人数</p>
                              <p className="text-lg font-bold text-emerald-400">{broadcastBreakdown.new_users}名</p>
                            </div>
                            <div className="glass-panel p-3 rounded-lg">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>売上シェア</p>
                              <p className="text-lg font-bold text-emerald-400">
                                {broadcastBreakdown.unique_users > 0
                                  ? Math.round((broadcastBreakdown.new_users / broadcastBreakdown.unique_users) * 100)
                                  : 0}%
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="glass-card p-4">
                          <h3 className="text-sm font-bold mb-2 flex items-center gap-2">
                            <span className="text-purple-400">🔁</span> リピーター
                          </h3>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="glass-panel p-3 rounded-lg">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>人数</p>
                              <p className="text-lg font-bold text-purple-400">{broadcastBreakdown.returning_users}名</p>
                            </div>
                            <div className="glass-panel p-3 rounded-lg">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>売上シェア</p>
                              <p className="text-lg font-bold text-purple-400">
                                {broadcastBreakdown.unique_users > 0
                                  ? Math.round((broadcastBreakdown.returning_users / broadcastBreakdown.unique_users) * 100)
                                  : 0}%
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      <Accordion id={`cast-${castName}-top-supporters`} title="トップ5 応援ユーザー" icon="🏆" defaultOpen={false}>
                      {/* トップ5応援ユーザー */}
                      {broadcastBreakdown.top_users && broadcastBreakdown.top_users.length > 0 && (
                        <div className="glass-card p-4">
                          <h3 className="text-sm font-bold mb-3">トップ5 応援ユーザー</h3>
                          <div className="space-y-2">
                            {broadcastBreakdown.top_users.map((u, i) => (
                              <div key={u.user_name} className="flex items-center justify-between glass-panel p-3 rounded-lg">
                                <div className="flex items-center gap-3">
                                  <span className="text-lg font-bold w-6 text-center" style={{ color: i === 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                                    {i + 1}
                                  </span>
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium">{u.user_name}</span>
                                      {u.is_new && (
                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">NEW</span>
                                      )}
                                    </div>
                                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                      {u.types?.join(', ')}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  <div className="text-right">
                                    <p className="text-sm font-bold text-amber-400">{formatTokens(u.tokens)}</p>
                                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(u.tokens, coinRate)})</p>
                                  </div>
                                  <button
                                    onClick={() => setTab('dm')}
                                    className="btn-ghost text-[10px] px-2 py-1"
                                  >
                                    💬 DM
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      </Accordion>

                      <Accordion id={`cast-${castName}-new-user-list`} title="新規ユーザー（初回応援）" icon="🆕" defaultOpen={false}>
                      {/* 新規ユーザーリスト */}
                      {broadcastNewUsers.filter(u => !u.has_prior_history).length > 0 && (
                        <div className="glass-card p-4">
                          <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                            🆕 新規ユーザー（初回応援）
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                              {broadcastNewUsers.filter(u => !u.has_prior_history).length}名
                            </span>
                          </h3>
                          <div className="space-y-2">
                            {broadcastNewUsers
                              .filter(u => !u.has_prior_history)
                              .map(u => (
                                <div key={u.user_name} className="flex items-center justify-between glass-panel p-3 rounded-lg">
                                  <div>
                                    <span className="text-sm font-medium">{u.user_name}</span>
                                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                      {u.transaction_count}件 / {u.types?.join(', ')}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    <p className="text-sm font-bold text-amber-400">{formatTokens(u.total_tokens_on_date)}</p>
                                    <button
                                      onClick={() => setTab('dm')}
                                      className="btn-ghost text-[10px] px-2 py-1"
                                    >
                                      💬 DM
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}

                      </Accordion>

                      <Accordion id={`cast-${castName}-broadcast-info`} title="配信情報" icon="📺" defaultOpen={false}>
                      {/* 配信情報 */}
                      <div className="glass-card p-4">
                        <h3 className="text-sm font-bold mb-2">配信情報</h3>
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                          <div className="glass-panel p-3 rounded-lg">
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>開始</p>
                            <p className="text-xs font-medium">{formatJST(broadcastBreakdown.started_at)}</p>
                          </div>
                          <div className="glass-panel p-3 rounded-lg">
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>終了</p>
                            <p className="text-xs font-medium">{broadcastBreakdown.ended_at ? formatJST(broadcastBreakdown.ended_at) : '配信中'}</p>
                          </div>
                          <div className="glass-panel p-3 rounded-lg">
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>配信時間</p>
                            <p className="text-xs font-medium">{broadcastBreakdown.duration_minutes}分</p>
                          </div>
                          {broadcastBreakdown.prev_session_date && (
                            <div className="glass-panel p-3 rounded-lg">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>前回配信</p>
                              <p className="text-xs font-medium">
                                {new Date(broadcastBreakdown.prev_session_date).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                                <span className="text-[10px] ml-1" style={{ color: 'var(--text-muted)' }}>
                                  ({formatTokens(broadcastBreakdown.prev_session_tokens)})
                                </span>
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                      </Accordion>
                    </>
                  ) : (
                    <div className="glass-card p-8 text-center">
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                        この日のセッションデータがありません
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ============ DM ============ */}
          {activeTab === 'dm' && (
            <div className="space-y-4">

              {/* Section A: DM送信キュー状況 */}
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold">📨 DM送信状況</h3>
                  <div className="flex items-center gap-2">
                    <div className="flex text-[9px] rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-glass)' }}>
                      <button onClick={() => setDmViewMode('latest')}
                        className="px-2 py-0.5"
                        style={{ background: dmViewMode === 'latest' ? 'rgba(56,189,248,0.15)' : 'transparent', color: dmViewMode === 'latest' ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                        最新バッチ
                      </button>
                      <button onClick={() => setDmViewMode('all')}
                        className="px-2 py-0.5"
                        style={{ background: dmViewMode === 'all' ? 'rgba(56,189,248,0.15)' : 'transparent', color: dmViewMode === 'all' ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                        全件
                      </button>
                    </div>
                    <button onClick={() => {
                      sb.from('dm_send_log')
                        .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
                        .eq('account_id', accountId!)
                        .eq('cast_name', castName)
                        .order('created_at', { ascending: false })
                        .limit(200)
                        .then(({ data }) => {
                          const logs = (data || []) as DMLogItem[];
                          setDmLogs(logs);
                          const latest = logs.length > 0 ? logs[0].campaign : null;
                          setDmLatestCampaign(latest);
                        });
                    }} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }} title="更新">
                      🔄
                    </button>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {dmQueueCounts.total.toLocaleString()}件
                      {dmViewMode === 'latest' && dmLatestCampaign && (
                        <span className="ml-1" style={{ color: 'var(--accent-primary)' }}>({dmLatestCampaign.length > 20 ? dmLatestCampaign.slice(0, 20) + '...' : dmLatestCampaign})</span>
                      )}
                    </span>
                  </div>
                </div>
                {(dmQueueCounts.queued > 0 || dmQueueCounts.sending > 0) && (
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg" style={{ background: 'rgba(245,158,11,0.08)' }}>
                    <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent-amber)' }} />
                    <span className="text-xs" style={{ color: 'var(--accent-amber)' }}>
                      Chrome拡張が {dmQueueCounts.queued + dmQueueCounts.sending}件 の送信待ち
                    </span>
                  </div>
                )}
                {dmQueueCounts.total > 0 ? (
                  <div className="space-y-2">
                    {/* Status bar */}
                    <div className="h-3 rounded-full overflow-hidden flex" style={{ background: 'rgba(0,0,0,0.2)' }}>
                      {dmQueueCounts.success > 0 && (
                        <div style={{ width: `${(dmQueueCounts.success / dmQueueCounts.total) * 100}%`, background: 'var(--accent-green)' }} />
                      )}
                      {dmQueueCounts.sending > 0 && (
                        <div style={{ width: `${(dmQueueCounts.sending / dmQueueCounts.total) * 100}%`, background: 'var(--accent-amber)' }} />
                      )}
                      {dmQueueCounts.queued > 0 && (
                        <div style={{ width: `${(dmQueueCounts.queued / dmQueueCounts.total) * 100}%`, background: 'var(--accent-primary)' }} />
                      )}
                      {dmQueueCounts.error > 0 && (
                        <div style={{ width: `${(dmQueueCounts.error / dmQueueCounts.total) * 100}%`, background: 'var(--accent-pink)' }} />
                      )}
                    </div>
                    <div className="flex gap-4 text-[10px]">
                      <span style={{ color: 'var(--accent-green)' }}>成功: {dmQueueCounts.success}</span>
                      <span style={{ color: 'var(--accent-amber)' }}>送信中: {dmQueueCounts.sending}</span>
                      <span style={{ color: 'var(--accent-primary)' }}>待機: {dmQueueCounts.queued}</span>
                      <span style={{ color: 'var(--accent-pink)' }}>エラー: {dmQueueCounts.error}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>DM送信履歴なし</p>
                )}
              </div>

              {/* Section tabs: ユーザー / 送信 / キャンペーン */}
              <div className="flex gap-1.5">
                {([
                  // { key: 'users' as const, icon: '👥', label: 'ユーザー別' }, // 非表示
                  { key: 'send' as const, icon: '✉️', label: 'DM送信' },
                  { key: 'segments' as const, icon: '🎯', label: 'セグメント別' },
                  { key: 'campaigns' as const, icon: '📊', label: 'キャンペーン' },
                  // { key: 'scenarios' as const, icon: '📋', label: 'シナリオ' }, // 非表示
                  // { key: 'effectiveness' as const, icon: '📈', label: '効果測定' }, // キャンペーンに統合済み
                ] as const).map(t => (
                  <button key={t.key} onClick={() => setDmSection(t.key)}
                    className={`text-[11px] px-4 py-2 rounded-lg font-medium transition-all ${
                      dmSection === t.key ? 'text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
                    }`}
                    style={dmSection === t.key ? {
                      background: 'linear-gradient(135deg, rgba(56,189,248,0.15), rgba(56,189,248,0.05))',
                      border: '1px solid rgba(56,189,248,0.2)',
                    } : {}}>
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>

              {/* Section B: ユーザー別DM履歴 */}
              {dmSection === 'users' && accountId && (
                <DmUserList dmLogs={dmLogs} fans={fans} accountId={accountId} castName={castName} sb={sb} />
              )}

              {/* Section C: DM送信 */}
              {dmSection === 'send' && accountId && (
                <DmSendPanel
                  accountId={accountId}
                  castName={castName}
                  sb={sb}
                  fans={fans}
                  dmLogs={dmLogs}
                  setDmLogs={(logs: DMLogItem[]) => setDmLogs(logs)}
                  dmSchedules={dmSchedules}
                  setDmSchedules={setDmSchedules}
                />
              )}

              {/* Section: セグメント別DM送信 */}
              {dmSection === 'segments' && accountId && (
                <DmSegment
                  accountId={accountId}
                  castName={castName}
                  sb={sb}
                  setDmLogs={(logs: DMLogItem[]) => setDmLogs(logs)}
                />
              )}

              {/* Section D: キャンペーン履歴 */}
              {dmSection === 'campaigns' && accountId && (
                <DmCampaign
                  dmLogs={dmLogs}
                  scenarios={scenarios}
                  setScenarios={setScenarios}
                  scenariosLoading={scenariosLoading}
                  scenarioEnrollCounts={scenarioEnrollCounts}
                  scenarioEnrollDetails={scenarioEnrollDetails}
                  accountId={accountId}
                  castName={castName}
                  sb={sb}
                  section="campaigns"
                />
              )}

              {/* Section D: シナリオ */}
              {dmSection === 'scenarios' && accountId && (
                <DmCampaign
                  dmLogs={dmLogs}
                  scenarios={scenarios}
                  setScenarios={setScenarios}
                  scenariosLoading={scenariosLoading}
                  scenarioEnrollCounts={scenarioEnrollCounts}
                  scenarioEnrollDetails={scenarioEnrollDetails}
                  accountId={accountId}
                  castName={castName}
                  sb={sb}
                  section="scenarios"
                />
              )}

              {/* Section E: 効果測定 */}
              {dmSection === 'effectiveness' && (
                <DmAnalytics dmEffectiveness={dmEffectiveness} dmEffLoading={dmEffLoading} />
              )}
            </div>
          )}

          {/* ============ ANALYTICS ============ */}
          {activeTab === 'analytics' && (
            <div className="space-y-4">
              {/* Sub-tab navigation */}
              <div className="flex gap-1.5">
                {([
                  { key: 'revenue' as const, icon: '📈', label: '売上トレンド' },
                  { key: 'fans' as const, icon: '👥', label: 'ファン分析' },
                ] as const).map(t => (
                  <button key={t.key} onClick={() => setAnalyticsSection(t.key)}
                    className={`text-[11px] px-4 py-2 rounded-lg font-medium transition-all ${
                      analyticsSection === t.key ? 'text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
                    }`}
                    style={analyticsSection === t.key ? {
                      background: 'linear-gradient(135deg, rgba(56,189,248,0.15), rgba(56,189,248,0.05))',
                      border: '1px solid rgba(56,189,248,0.2)',
                    } : {}}>
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>

              {analyticsSection === 'revenue' && accountId && (
                <RevenueTrend accountId={accountId} castName={castName} sb={sb} coinRate={coinRate} />
              )}

              {analyticsSection === 'fans' && accountId && (
                <FanAnalysis accountId={accountId} castName={castName} sb={sb} />
              )}
            </div>
          )}




          {/* ============ SCREENSHOTS — M-6: データ0件のため非表示。SPY基盤安定後に復元 ============ */}

          {/* ============ PERSONA — UI非表示（機能は維持） ============ */}
          {false && activeTab === 'dm' && (
            <div className="space-y-4">
              {personaLoading ? (
                <div className="space-y-3">
                  {[0,1,2].map(i => (
                    <div key={i} className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  ))}
                </div>
              ) : (
                <>
                  {/* キャラクター定義 */}
                  <div className="glass-card p-5">
                    <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
                      🎭 キャラクター定義
                      {persona && (
                        <span className="text-[10px] px-2 py-0.5 rounded-lg font-normal"
                          style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--accent-green)' }}>
                          設定済み
                        </span>
                      )}
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* 表示名 */}
                      <div>
                        <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>
                          表示名
                        </label>
                        <input
                          className="input-glass w-full text-xs"
                          placeholder="例: りさ"
                          value={personaForm.display_name || ''}
                          onChange={e => setPersonaForm(prev => ({ ...prev, display_name: e.target.value }))}
                        />
                      </div>

                      {/* DMトーン */}
                      <div>
                        <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>
                          DMトーン
                        </label>
                        <select
                          className="input-glass w-full text-xs"
                          value={personaForm.dm_tone || 'friendly'}
                          onChange={e => setPersonaForm(prev => ({ ...prev, dm_tone: e.target.value }))}
                        >
                          <option value="friendly">friendly（親しみやすい）</option>
                          <option value="flirty">flirty（甘え系）</option>
                          <option value="cool">cool（クール）</option>
                          <option value="cute">cute（かわいい系）</option>
                        </select>
                      </div>

                      {/* 性格 */}
                      <div className="md:col-span-2">
                        <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>
                          性格・キャラ概要
                        </label>
                        <textarea
                          className="input-glass w-full text-xs"
                          rows={2}
                          placeholder="例: 明るくて甘えん坊。ファンとの距離が近い。初見にも優しい。"
                          value={personaForm.personality || ''}
                          onChange={e => setPersonaForm(prev => ({ ...prev, personality: e.target.value }))}
                        />
                      </div>

                      {/* 口調 */}
                      <div>
                        <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>
                          口調
                        </label>
                        <input
                          className="input-glass w-full text-xs"
                          placeholder="例: 〜だよ！〜かな？"
                          value={personaForm.speaking_style || ''}
                          onChange={e => setPersonaForm(prev => ({ ...prev, speaking_style: e.target.value }))}
                        />
                      </div>

                      {/* 絵文字スタイル */}
                      <div>
                        <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>
                          絵文字の傾向
                        </label>
                        <input
                          className="input-glass w-full text-xs"
                          placeholder="例: ❤️🥰😘多め"
                          value={personaForm.emoji_style || ''}
                          onChange={e => setPersonaForm(prev => ({ ...prev, emoji_style: e.target.value }))}
                        />
                      </div>

                      {/* BYAF */}
                      <div className="md:col-span-2">
                        <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>
                          BYAF（DM末尾の自由選択文）
                        </label>
                        <input
                          className="input-glass w-full text-xs"
                          placeholder="例: 来てくれたら嬉しいな💕でも無理しないでね！"
                          value={personaForm.byaf_style || ''}
                          onChange={e => setPersonaForm(prev => ({ ...prev, byaf_style: e.target.value }))}
                        />
                      </div>

                      {/* 禁止話題 */}
                      <div className="md:col-span-2">
                        <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>
                          禁止話題
                        </label>
                        <textarea
                          className="input-glass w-full text-xs"
                          rows={2}
                          placeholder="触れてはいけない話題（改行区切り）"
                          value={personaForm.taboo_topics || ''}
                          onChange={e => setPersonaForm(prev => ({ ...prev, taboo_topics: e.target.value }))}
                        />
                      </div>
                    </div>

                    {/* 保存ボタン */}
                    <div className="mt-4 flex justify-end">
                      <button
                        onClick={handlePersonaSave}
                        disabled={personaSaving}
                        className="btn-primary text-xs px-6 py-2 disabled:opacity-50"
                      >
                        {personaSaving ? '保存中...' : '💾 保存'}
                      </button>
                    </div>
                  </div>

                  {/* System Prompt 3層 */}
                  <div className="glass-card p-5">
                    <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
                      🧠 System Prompt 3層
                    </h3>

                    {/* L1: プラットフォーム共通ルール */}
                    <div className="mb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                          style={{ background: 'rgba(56,189,248,0.15)', color: 'var(--accent-primary)' }}>
                          L1
                        </span>
                        <label className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                          プラットフォーム共通ルール（読み取り専用）
                        </label>
                      </div>
                      <div className="glass-panel rounded-lg p-3 max-h-32 overflow-y-auto">
                        <pre className="text-[10px] whitespace-pre-wrap font-mono" style={{ color: 'var(--text-muted)' }}>
                          {personaForm.system_prompt_base || '（デフォルトの安藤式7原則が適用されます）'}
                        </pre>
                      </div>
                    </div>

                    {/* L2: キャスト固有 */}
                    <div className="mb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                          style={{ background: 'rgba(168,85,247,0.15)', color: 'var(--accent-purple)' }}>
                          L2
                        </span>
                        <label className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                          キャスト固有ルール（編集可）
                        </label>
                      </div>
                      <textarea
                        className="input-glass w-full text-xs font-mono"
                        rows={4}
                        placeholder="このキャスト固有の指示（例: 「関西弁を使う」「英語ユーザーには英語で返す」）"
                        value={personaForm.system_prompt_cast || ''}
                        onChange={e => setPersonaForm(prev => ({ ...prev, system_prompt_cast: e.target.value }))}
                      />
                    </div>

                    {/* L3: 動的コンテキスト */}
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                          style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--accent-green)' }}>
                          L3
                        </span>
                        <label className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                          動的コンテキスト（自動生成）
                        </label>
                      </div>
                      <div className="glass-panel rounded-lg p-3 max-h-32 overflow-y-auto">
                        <pre className="text-[10px] whitespace-pre-wrap font-mono" style={{ color: 'var(--text-muted)' }}>
                          {personaForm.system_prompt_context || '（配信データから自動生成されます）'}
                        </pre>
                      </div>
                    </div>

                    {/* 保存ボタン */}
                    <div className="mt-4 flex justify-end">
                      <button
                        onClick={handlePersonaSave}
                        disabled={personaSaving}
                        className="btn-primary text-xs px-6 py-2 disabled:opacity-50"
                      >
                        {personaSaving ? '保存中...' : '💾 保存'}
                      </button>
                    </div>
                  </div>

                  {/* DM文面テスト生成 */}
                  <div className="glass-card p-5">
                    <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
                      💬 テストDM生成
                    </h3>
                    <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
                      ペルソナ設定を使ってDM文面を生成します。テスト宛先: TestUser123
                    </p>

                    <div className="flex flex-wrap gap-2 mb-4">
                      {[
                        { key: 'thank', label: 'お礼DM', icon: '💕' },
                        { key: 'follow', label: 'フォローDM', icon: '👋' },
                        { key: 'pre_broadcast', label: '配信前DM', icon: '📡' },
                        { key: 'vip', label: 'VIP DM', icon: '💎' },
                        { key: 'churn', label: '離脱復帰DM', icon: '😢' },
                      ].map(t => (
                        <button
                          key={t.key}
                          onClick={() => handlePersonaTestDm(t.key)}
                          disabled={personaTestLoading}
                          className="text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all hover:brightness-110 disabled:opacity-40"
                          style={{
                            background: 'rgba(168,85,247,0.1)',
                            color: 'var(--accent-purple)',
                            border: '1px solid rgba(168,85,247,0.2)',
                          }}
                        >
                          {t.icon} {t.label}
                        </button>
                      ))}
                    </div>

                    {personaTestLoading && (
                      <div className="text-center py-4">
                        <div className="inline-block w-5 h-5 border-2 rounded-full animate-spin"
                          style={{ borderColor: 'var(--accent-purple)', borderTopColor: 'transparent' }} />
                        <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>生成中...</p>
                      </div>
                    )}

                    {personaTestResult && !personaTestLoading && (
                      <div className="glass-panel rounded-lg p-4">
                        <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>生成結果</p>
                        <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                          {personaTestResult}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}



          {/* ============ HEALTH (健全性) ============ */}
          {activeTab === 'settings' && (
            <div className="space-y-4">
              {castHealthLoading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="w-8 h-8 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : !castHealth ? (
                <div className="glass-card p-10 text-center">
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    健全性データなし — 直近30日間の配信データが必要です
                  </p>
                </div>
              ) : (
                <>
                  {/* Mental Health Warning */}
                  {castHealth.mental_health_flag && (
                    <div className="glass-card p-4" style={{
                      background: 'rgba(239,68,68,0.08)',
                      borderLeft: '3px solid rgb(239,68,68)',
                    }}>
                      <p className="text-sm font-bold" style={{ color: 'var(--accent-pink)' }}>
                        メンタル注意フラグ
                      </p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                        配信頻度または配信時間が前半15日間と比べて大幅に減少しています。ケアを検討してください。
                      </p>
                    </div>
                  )}

                  {/* Overall Health Score */}
                  <div className="glass-card p-5 text-center">
                    <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>総合健全性スコア</p>
                    <div className="inline-flex items-center justify-center w-24 h-24 rounded-full border-4" style={{
                      borderColor: castHealth.overall_health >= 70 ? 'var(--accent-green)' :
                                   castHealth.overall_health >= 40 ? 'var(--accent-amber)' : 'var(--accent-pink)',
                    }}>
                      <span className="text-3xl font-bold" style={{
                        color: castHealth.overall_health >= 70 ? 'var(--accent-green)' :
                               castHealth.overall_health >= 40 ? 'var(--accent-amber)' : 'var(--accent-pink)',
                      }}>{castHealth.overall_health}</span>
                    </div>
                    <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
                      {castHealth.overall_health >= 70 ? '良好' : castHealth.overall_health >= 40 ? '要観察' : '要注意'}
                    </p>
                  </div>

                  {/* Radar Chart (CSS) */}
                  <div className="glass-card p-5">
                    <h3 className="text-sm font-bold mb-4">5軸レーダー</h3>
                    {(() => {
                      const axes = [
                        { key: 'schedule_consistency', label: 'スケジュール安定度', value: castHealth.schedule_consistency },
                        { key: 'revenue_trend', label: '売上トレンド', value: castHealth.revenue_trend },
                        { key: 'broadcast_quality', label: '配信品質', value: castHealth.broadcast_quality },
                        { key: 'dm_dependency_inv', label: '自力集客力', value: 100 - castHealth.dm_dependency },
                        { key: 'independence_inv', label: '組織依存度', value: 100 - castHealth.independence_risk },
                      ];
                      return (
                        <div className="space-y-3">
                          {axes.map(a => (
                            <div key={a.key}>
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{a.label}</span>
                                <span className="text-[11px] font-bold" style={{
                                  color: a.value >= 70 ? 'var(--accent-green)' : a.value >= 40 ? 'var(--accent-amber)' : 'var(--accent-pink)',
                                }}>{a.value}</span>
                              </div>
                              <div className="w-full h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                <div className="h-2 rounded-full transition-all duration-500" style={{
                                  width: `${a.value}%`,
                                  background: a.value >= 70 ? 'var(--accent-green)' : a.value >= 40 ? 'var(--accent-amber)' : 'var(--accent-pink)',
                                }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Individual Gauges */}
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                    {[
                      { label: 'スケジュール安定度', value: castHealth.schedule_consistency, desc: '配信頻度と時刻の一貫性' },
                      { label: '売上トレンド', value: castHealth.revenue_trend, desc: '50=横ばい、50超=成長' },
                      { label: '配信品質', value: castHealth.broadcast_quality, desc: '視聴者数・チップ・チャット活性度' },
                      { label: 'DM依存度', value: castHealth.dm_dependency, desc: '高い=DMがないと売上減少', invert: true },
                      { label: '独立リスク', value: castHealth.independence_risk, desc: '高い=自力で成長中', invert: true },
                    ].map(g => (
                      <div key={g.label} className="glass-card p-4 text-center">
                        <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>{g.label}</p>
                        <p className="text-2xl font-bold" style={{
                          color: (g as any).invert
                            ? (g.value <= 30 ? 'var(--accent-green)' : g.value <= 60 ? 'var(--accent-amber)' : 'var(--accent-pink)')
                            : (g.value >= 70 ? 'var(--accent-green)' : g.value >= 40 ? 'var(--accent-amber)' : 'var(--accent-pink)'),
                        }}>{g.value}</p>
                        <div className="w-full h-1.5 rounded-full mt-2" style={{ background: 'rgba(255,255,255,0.05)' }}>
                          <div className="h-1.5 rounded-full transition-all" style={{
                            width: `${g.value}%`,
                            background: (g as any).invert
                              ? (g.value <= 30 ? 'var(--accent-green)' : g.value <= 60 ? 'var(--accent-amber)' : 'var(--accent-pink)')
                              : (g.value >= 70 ? 'var(--accent-green)' : g.value >= 40 ? 'var(--accent-amber)' : 'var(--accent-pink)'),
                          }} />
                        </div>
                        <p className="text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>{g.desc}</p>
                      </div>
                    ))}
                  </div>

                  {/* Session Quality Table */}
                  {sessionQualities.length > 0 && (
                    <div className="glass-card p-5">
                      <h3 className="text-sm font-bold mb-3">配信品質スコア（直近20セッション）</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr style={{ color: 'var(--text-muted)' }}>
                              <th className="text-left py-2 px-2">日付</th>
                              <th className="text-right py-2 px-2">時間</th>
                              <th className="text-right py-2 px-2">視聴者</th>
                              <th className="text-right py-2 px-2">コイン</th>
                              <th className="text-right py-2 px-2">チャット</th>
                              <th className="text-right py-2 px-2">tk/人</th>
                              <th className="text-right py-2 px-2">chat/分</th>
                              <th className="text-right py-2 px-2">スコア</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sessionQualities.map(sq => (
                              <tr key={sq.session_id} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                                <td className="py-2 px-2">{new Date(sq.session_date).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}</td>
                                <td className="text-right py-2 px-2">{sq.duration_minutes}分</td>
                                <td className="text-right py-2 px-2">{sq.peak_viewers}</td>
                                <td className="text-right py-2 px-2" style={{ color: 'var(--accent-amber)' }}>{sq.total_coins.toLocaleString()}</td>
                                <td className="text-right py-2 px-2">{sq.chat_count}</td>
                                <td className="text-right py-2 px-2">{sq.tip_per_viewer}</td>
                                <td className="text-right py-2 px-2">{sq.chat_per_minute}</td>
                                <td className="text-right py-2 px-2 font-bold" style={{
                                  color: sq.quality_score >= 70 ? 'var(--accent-green)' :
                                         sq.quality_score >= 40 ? 'var(--accent-amber)' : 'var(--accent-pink)',
                                }}>{sq.quality_score}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ============ CALENDAR (運用カレンダー) ============ */}
          {activeTab === 'calendar' && accountId && (
            <ActivityCalendar accountId={accountId} castName={castName} sb={sb} />
          )}

          {/* ============ REPORTS (配信レポート) ============ */}
          {activeTab === 'reports' && accountId && castInfo && (
            <CastReportsTab accountId={accountId} castId={castInfo.id} castName={castName} />
          )}

          {/* ============ SETTINGS (設定) ============ */}
          {activeTab === 'settings' && (
            <div className="space-y-4">
              {/* セクション1: 基本情報 */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
                  📋 基本情報
                </h3>
                <div className="space-y-3">
                  {/* キャスト名（読み取り専用） */}
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                      キャスト名
                    </label>
                    <div className="input-glass px-3 py-2 text-sm rounded-xl" style={{ opacity: 0.6 }}>
                      {castName}
                    </div>
                  </div>

                  {/* 表示名 */}
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                      表示名
                    </label>
                    <input
                      type="text"
                      className="input-glass w-full px-3 py-2 text-sm rounded-xl"
                      value={settingsDisplayName}
                      onChange={e => setSettingsDisplayName(e.target.value)}
                      placeholder="例: りさ"
                    />
                  </div>

                  {/* プラットフォーム */}
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                      プラットフォーム
                    </label>
                    <div className="flex gap-2">
                      {['stripchat', 'fanza', 'chatpia'].map(p => (
                        <button
                          key={p}
                          onClick={() => setSettingsPlatform(p)}
                          className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                          style={{
                            background: settingsPlatform === p ? 'rgba(56,189,248,0.15)' : 'transparent',
                            color: settingsPlatform === p ? 'var(--accent-primary)' : 'var(--text-muted)',
                            border: settingsPlatform === p ? '1px solid rgba(56,189,248,0.25)' : '1px solid var(--border-glass)',
                          }}
                        >
                          {p === 'stripchat' ? 'Stripchat' : p === 'fanza' ? 'FANZA' : 'チャットピア'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Model ID */}
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                      Model ID
                      <span className="ml-2 font-normal normal-case" style={{ color: 'var(--text-muted)' }}>
                        (Collector WebSocket接続に必要)
                      </span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        className="input-glass flex-1 px-3 py-2 text-sm rounded-xl font-mono"
                        value={settingsModelId}
                        onChange={e => setSettingsModelId(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="例: 178845750"
                      />
                      {settingsPlatform === 'stripchat' && (
                        <button
                          onClick={async () => {
                            setSettingsAutoFetching(true);
                            setSettingsMsg(null);
                            try {
                              const res = await fetch(`https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(castName)}/cam`);
                              if (!res.ok) throw new Error(`HTTP ${res.status}`);
                              const json = await res.json();
                              const mid = json?.user?.user?.id || json?.user?.id;
                              if (!mid) throw new Error('レスポンスにmodel IDが見つかりません');
                              setSettingsModelId(String(mid));
                              // アバターURLも自動設定
                              const avatar = json?.user?.user?.snapshotUrl || json?.user?.snapshotUrl;
                              if (avatar) setSettingsAvatarUrl(avatar);
                              setSettingsMsg({ type: 'ok', text: `Model ID取得成功: ${mid}` });
                            } catch (err: unknown) {
                              const msg = err instanceof Error ? err.message : '不明なエラー';
                              setSettingsMsg({ type: 'err', text: `取得失敗: ${msg}` });
                            } finally {
                              setSettingsAutoFetching(false);
                            }
                          }}
                          disabled={settingsAutoFetching}
                          className="btn-primary text-xs px-3 py-2 whitespace-nowrap"
                          style={{ opacity: settingsAutoFetching ? 0.5 : 1 }}
                        >
                          {settingsAutoFetching ? '取得中...' : '自動取得'}
                        </button>
                      )}
                    </div>
                    {settingsMsg && (
                      <p className="text-[11px] mt-1.5" style={{ color: settingsMsg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                        {settingsMsg.text}
                      </p>
                    )}
                  </div>

                  {/* アバタープレビュー */}
                  {(settingsAvatarUrl || settingsModelId) && (
                    <div>
                      <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                        アバター
                      </label>
                      <div className="flex items-center gap-3">
                        <div className="w-16 h-16 rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-glass)' }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={settingsAvatarUrl || `https://img.doppiocdn.org/thumbs/${settingsModelId}_webp`}
                            alt={castName}
                            className="w-full h-full object-cover"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        </div>
                        <input
                          type="text"
                          className="input-glass flex-1 px-3 py-2 text-xs rounded-xl"
                          value={settingsAvatarUrl}
                          onChange={e => setSettingsAvatarUrl(e.target.value)}
                          placeholder="アバターURL（自動取得または手動入力）"
                        />
                      </div>
                    </div>
                  )}

                  {/* メモ */}
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                      メモ
                    </label>
                    <textarea
                      className="input-glass w-full px-3 py-2 text-sm rounded-xl resize-none"
                      rows={3}
                      value={settingsNotes}
                      onChange={e => setSettingsNotes(e.target.value)}
                      placeholder="管理用メモ..."
                    />
                  </div>

                  {/* 保存ボタン */}
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={async () => {
                        if (!castInfo) return;
                        setSettingsSaving(true);
                        setSettingsMsg(null);
                        const { error } = await sb
                          .from('registered_casts')
                          .update({
                            model_id: settingsModelId ? parseInt(settingsModelId, 10) : null,
                            platform: settingsPlatform,
                            avatar_url: settingsAvatarUrl || null,
                            display_name: settingsDisplayName || null,
                            notes: settingsNotes || null,
                            stripchat_model_id: settingsModelId || null,
                            updated_at: new Date().toISOString(),
                          })
                          .eq('id', castInfo.id);
                        setSettingsSaving(false);
                        if (error) {
                          setSettingsMsg({ type: 'err', text: `保存失敗: ${error.message}` });
                        } else {
                          setSettingsMsg({ type: 'ok', text: '保存しました' });
                          // castInfo も更新
                          setCastInfo(prev => prev ? {
                            ...prev,
                            model_id: settingsModelId ? parseInt(settingsModelId, 10) : null,
                            platform: settingsPlatform,
                            avatar_url: settingsAvatarUrl || null,
                            display_name: settingsDisplayName || null,
                            notes: settingsNotes || null,
                            stripchat_model_id: settingsModelId || null,
                          } : null);
                        }
                      }}
                      disabled={settingsSaving}
                      className="btn-primary text-xs px-6 py-2"
                      style={{ opacity: settingsSaving ? 0.5 : 1 }}
                    >
                      {settingsSaving ? '保存中...' : '設定を保存'}
                    </button>
                  </div>
                </div>
              </div>

              {/* セクション2: コスト設定（P/L） */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
                  💰 コスト設定（P/L算出用）
                </h3>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                        キャスト時給（円）
                      </label>
                      <input type="number" className="input-glass w-full px-3 py-2 text-sm rounded-xl"
                        value={costHourlyRate} onChange={e => setCostHourlyRate(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                        月額固定費（円）
                      </label>
                      <input type="number" className="input-glass w-full px-3 py-2 text-sm rounded-xl"
                        value={costMonthlyFixed} onChange={e => setCostMonthlyFixed(e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                        手数料率（%）
                      </label>
                      <input type="number" step="0.1" className="input-glass w-full px-3 py-2 text-sm rounded-xl"
                        value={costPlatformFee} onChange={e => setCostPlatformFee(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                        1tk = 円
                      </label>
                      <input type="number" step="0.1" className="input-glass w-full px-3 py-2 text-sm rounded-xl"
                        value={costTokenJpy} onChange={e => setCostTokenJpy(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
                        ボーナス率（%）
                      </label>
                      <input type="number" step="0.1" className="input-glass w-full px-3 py-2 text-sm rounded-xl"
                        value={costBonusRate} onChange={e => setCostBonusRate(e.target.value)} />
                    </div>
                  </div>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Stripchat標準: 手数料40%、1tk=約5.5円。設定するとセッション別・月次のP/L（損益）が売上タブに表示されます。
                  </p>
                  <div className="flex items-center gap-2 justify-end pt-1">
                    {costMsg && (
                      <span className="text-[11px]" style={{ color: costMsg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                        {costMsg.text}
                      </span>
                    )}
                    <button
                      onClick={async () => {
                        if (!accountId) return;
                        setCostSaving(true);
                        setCostMsg(null);
                        const { error } = await sb.from('cast_cost_settings').upsert({
                          account_id: accountId,
                          cast_name: castName,
                          hourly_rate: parseInt(costHourlyRate) || 0,
                          monthly_fixed_cost: parseInt(costMonthlyFixed) || 0,
                          platform_fee_rate: parseFloat(costPlatformFee) || 40,
                          token_to_jpy: parseFloat(costTokenJpy) || 5.5,
                          bonus_rate: parseFloat(costBonusRate) || 0,
                          effective_from: new Date().toISOString().slice(0, 10),
                        }, { onConflict: 'account_id,cast_name,effective_from' });
                        setCostSaving(false);
                        setCostMsg(error ? { type: 'err', text: `保存失敗: ${error.message}` } : { type: 'ok', text: 'コスト設定を保存しました' });
                      }}
                      disabled={costSaving}
                      className="btn-primary text-xs px-5 py-2"
                      style={{ opacity: costSaving ? 0.5 : 1 }}
                    >
                      {costSaving ? '保存中...' : 'コスト設定を保存'}
                    </button>
                  </div>
                </div>
              </div>

              {/* セクション3: Collector設定 */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
                  📡 Collector設定
                </h3>
                <div className="space-y-3">
                  {/* 監視対象ON/OFF */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">監視対象</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        WebSocket Collectorの自動収集対象にする
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!castInfo) return;
                        const newVal = !castInfo.is_active;
                        const { error } = await sb
                          .from('registered_casts')
                          .update({ is_active: newVal, updated_at: new Date().toISOString() })
                          .eq('id', castInfo.id);
                        if (!error) {
                          setCastInfo(prev => prev ? { ...prev, is_active: newVal } : null);
                        }
                      }}
                      className="relative w-11 h-6 rounded-full transition-colors"
                      style={{
                        background: castInfo?.is_active ? 'var(--accent-green)' : 'rgba(100,116,139,0.3)',
                      }}
                    >
                      <div
                        className="absolute top-0.5 w-5 h-5 rounded-full transition-transform"
                        style={{
                          background: 'white',
                          transform: castInfo?.is_active ? 'translateX(22px)' : 'translateX(2px)',
                        }}
                      />
                    </button>
                  </div>

                  {/* ステータス表示 */}
                  <div className="glass-panel p-3 rounded-xl">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>Model ID</p>
                        <p className="font-mono">{castInfo?.model_id || castInfo?.stripchat_model_id || '未設定'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>ステータス</p>
                        <p>
                          {castInfo?.is_active ? (
                            <span style={{ color: 'var(--accent-green)' }}>有効</span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>無効</span>
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>プラットフォーム</p>
                        <p>{castInfo?.platform || 'stripchat'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>最終更新</p>
                        <p>{castInfo?.updated_at ? formatJST(castInfo.updated_at) : '—'}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* セクション3: 危険ゾーン */}
              <div className="glass-card p-5" style={{ border: '1px solid rgba(244,63,94,0.2)' }}>
                <h3 className="text-sm font-bold mb-4 flex items-center gap-2" style={{ color: 'var(--accent-pink)' }}>
                  ⚠ 危険ゾーン
                </h3>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">キャスト削除</p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      このキャストを登録解除します。配信ログやDM履歴は残ります。
                    </p>
                  </div>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="btn-danger text-xs px-4 py-2"
                  >
                    削除
                  </button>
                </div>

                {/* 削除確認モーダル */}
                {showDeleteConfirm && (
                  <div className="mt-4 glass-panel p-4 rounded-xl" style={{ border: '1px solid rgba(244,63,94,0.3)' }}>
                    <p className="text-sm font-bold mb-2" style={{ color: 'var(--accent-pink)' }}>
                      本当に「{castName}」を削除しますか？
                    </p>
                    <p className="text-[11px] mb-3" style={{ color: 'var(--text-secondary)' }}>
                      is_active = false に設定されます。配信データは削除されません。
                    </p>
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setShowDeleteConfirm(false)}
                        className="btn-ghost text-xs px-4 py-1.5"
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={async () => {
                          if (!castInfo) return;
                          await sb
                            .from('registered_casts')
                            .update({ is_active: false, updated_at: new Date().toISOString() })
                            .eq('id', castInfo.id);
                          router.push('/casts');
                        }}
                        className="btn-danger text-xs px-4 py-1.5"
                      >
                        削除する
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============ COMPETITORS (競合分析) ============ */}
          {activeTab === 'competitors' && competitors.length > 0 && (
            <div className="space-y-4 anim-fade-up">
              {/* 競合一覧 */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
                  ⚔ 競合キャスト一覧
                </h3>
                <div className="space-y-2">
                  {competitors.map(c => (
                    <div key={c.competitor_cast_name} className="glass-panel px-4 py-3 rounded-xl flex items-center justify-between">
                      <div>
                        <span className="text-sm font-semibold">{c.competitor_cast_name}</span>
                        {c.category && (
                          <span className="ml-2 text-[10px] px-2 py-0.5 rounded"
                            style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                            {c.category}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => runCompetitorDiff(c.competitor_cast_name)}
                        disabled={competitorAnalyzing}
                        className="text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all"
                        style={{
                          background: competitorTarget === c.competitor_cast_name && competitorAnalyzing
                            ? 'rgba(56,189,248,0.1)'
                            : 'linear-gradient(135deg, var(--accent-primary), #0284c7)',
                          color: 'white',
                          opacity: competitorAnalyzing ? 0.6 : 1,
                        }}>
                        {competitorTarget === c.competitor_cast_name && competitorAnalyzing ? '分析中...' : '分析する'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* ローディング */}
              {competitorAnalyzing && (
                <div className="glass-card p-6 text-center">
                  <div className="inline-block w-8 h-8 rounded-full border-2 border-t-transparent animate-spin mb-3"
                    style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    分析中...（30秒ほどかかります）
                  </p>
                  <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    {castName} vs {competitorTarget} の差分をAIが分析しています
                  </p>
                </div>
              )}

              {/* エラー */}
              {competitorError && !competitorAnalyzing && (
                <div className="glass-card p-4 rounded-xl" style={{ border: '1px solid rgba(244,63,94,0.3)' }}>
                  <p className="text-sm" style={{ color: 'var(--accent-pink)' }}>
                    ⚠ {competitorError}
                  </p>
                </div>
              )}

              {/* レポート表示 */}
              {competitorReport && !competitorAnalyzing && (
                <div className="space-y-3">
                  <h3 className="text-sm font-bold flex items-center gap-2">
                    📄 {castName} vs {competitorTarget} 差分レポート
                  </h3>

                  {/* actionable_insights — 目立つ緑系カード */}
                  {competitorReport.actionable_insights && competitorReport.actionable_insights.length > 0 && (
                    <div className="glass-card p-5 rounded-xl" style={{ border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.05)' }}>
                      <h4 className="text-xs font-bold mb-3 flex items-center gap-1.5" style={{ color: 'var(--accent-green)' }}>
                        💡 具体的な打ち手
                      </h4>
                      <div className="space-y-2">
                        {competitorReport.actionable_insights.map((insight, i) => (
                          <div key={i} className="flex gap-2 items-start">
                            <span className="text-sm font-bold mt-0.5" style={{ color: 'var(--accent-green)' }}>{i + 1}.</span>
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-primary)' }}>{insight}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {/* revenue_gap */}
                    {competitorReport.revenue_gap && (
                      <div className="glass-card p-4">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-amber)' }}>
                          💰 売上差分
                        </h4>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {competitorReport.revenue_gap}
                        </p>
                      </div>
                    )}

                    {/* timing_gap */}
                    {competitorReport.timing_gap && (
                      <div className="glass-card p-4">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-primary)' }}>
                          🕐 配信時間帯の違い
                        </h4>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {competitorReport.timing_gap}
                        </p>
                      </div>
                    )}

                    {/* style_gap */}
                    {competitorReport.style_gap && (
                      <div className="glass-card p-4">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-purple, #a78bfa)' }}>
                          🎭 配信スタイルの違い
                        </h4>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {competitorReport.style_gap}
                        </p>
                      </div>
                    )}

                    {/* audience_gap */}
                    {competitorReport.audience_gap && (
                      <div className="glass-card p-4">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-pink)' }}>
                          👥 客層の違い
                        </h4>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {competitorReport.audience_gap}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {/* competitive_advantage */}
                    {competitorReport.competitive_advantage && (
                      <div className="glass-card p-4" style={{ borderLeft: '3px solid var(--accent-green)' }}>
                        <h4 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-green)' }}>
                          ✅ 自社の強み
                        </h4>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {competitorReport.competitive_advantage}
                        </p>
                      </div>
                    )}

                    {/* competitive_weakness */}
                    {competitorReport.competitive_weakness && (
                      <div className="glass-card p-4" style={{ borderLeft: '3px solid var(--accent-pink)' }}>
                        <h4 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--accent-pink)' }}>
                          ⚠ 自社の弱み
                        </h4>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {competitorReport.competitive_weakness}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* raw fallback */}
                  {competitorReport.raw && !competitorReport.revenue_gap && (
                    <div className="glass-card p-4">
                      <h4 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                        レポート（Raw）
                      </h4>
                      <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                        {competitorReport.raw}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ============ PERSONA (AIペルソナ) ============ */}
          {activeTab === 'persona' && accountId && (
            <PersonaTab castName={castName} accountId={accountId} />
          )}


        </>
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
