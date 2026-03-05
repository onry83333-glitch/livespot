'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { isDmTestMode, DM_TEST_WHITELIST, getDmGuardStatus } from '@/lib/dm-guard';
import { ChatMessage } from '@/components/chat-message';
import { formatTokens, tokensToJPY, timeAgo, formatJST, COIN_RATE } from '@/lib/utils';
import type { RegisteredCast, SpyMessage, UserSegment } from '@/types';
import { mapChatLog } from '@/lib/table-mappers';
import { getUserColorFromCoins } from '@/lib/stripchat-levels';
import DmSegmentSender from '@/components/dm-segment-sender';
import DataSyncPanel from '@/components/data-sync-panel';
import { Accordion } from '@/components/accordion';
import CastReportsTab from '@/components/cast-reports-tab';


/* ============================================================
   Types
   ============================================================ */
// M-6: screenshots タブはデータ0件のため非表示。SPY基盤安定後に再表示
type TabKey = 'overview' | 'sessions' | 'dm' | 'analytics' | 'reports' | 'settings';

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
  visited_after: number;
  cvr_pct: number;
  visit_cvr_pct: number;
  total_tokens: number;
  avg_tokens_per_payer: number;
  first_sent: string;
  last_sent: string;
}

interface DmEffItem {
  campaign: string;
  segment: string;
  sent_count: number;
  visited_count: number;
  paid_count: number;
  visit_cvr: number;
  payment_cvr: number;
  total_tokens: number;
  avg_tokens_per_payer: number;
}

interface HourlyPerfItem {
  hour_jst: number;
  session_count: number;
  avg_duration_min: number;
  avg_viewers: number;
  avg_tokens: number;
  total_tokens: number;
  avg_tokens_per_hour: number;
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

const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: 'overview',   icon: '📊', label: '概要' },
  { key: 'sessions',   icon: '📺', label: 'セッション' },
  { key: 'dm',         icon: '💬', label: 'DM' },
  { key: 'analytics',  icon: '📈', label: 'アナリティクス' },
  { key: 'reports',    icon: '📋', label: '配信レポート' },
  { key: 'settings',   icon: '⚙', label: '設定' },
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
  const coinRate = COIN_RATE;

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
  const [dmIsTest, setDmIsTest] = useState(process.env.NODE_ENV === 'development');
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

  // DM Image
  const [dmImageFile, setDmImageFile] = useState<File | null>(null);
  const [dmImagePreview, setDmImagePreview] = useState<string | null>(null);
  const dmImageInputRef = useRef<HTMLInputElement>(null);

  // DM Delivery mode & Send order
  const [dmDeliveryMode, setDmDeliveryMode] = useState<'fast_text' | 'image_pipeline'>('fast_text');
  const [dmSendOrder, setDmSendOrder] = useState<'text_only' | 'image_only' | 'text_then_image' | 'image_then_text'>('text_only');

  // DM安全ゲート: 送信先プレビュー確認
  const [dmShowPreview, setDmShowPreview] = useState(false);
  const [dmPreviewConfirmed, setDmPreviewConfirmed] = useState(false);

  // DM Safety: 3-step confirmation
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [sendUnlocked, setSendUnlocked] = useState(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DM Queue status
  const [dmQueueCounts, setDmQueueCounts] = useState({ queued: 0, sending: 0, success: 0, error: 0, total: 0 });

  // DM User-level history
  const [dmUserSearch, setDmUserSearch] = useState('');
  const [dmExpandedUser, setDmExpandedUser] = useState<string | null>(null);
  const [dmUserHistory, setDmUserHistory] = useState<DMLogItem[]>([]);
  const [dmUserHistoryLoading, setDmUserHistoryLoading] = useState(false);

  // DM Section toggle (A/B/C/D/E)
  const [dmSection, setDmSection] = useState<'users' | 'send' | 'segments' | 'campaigns' | 'scenarios' | 'effectiveness'>('users');

  // DM Effectiveness state
  const [dmEffectiveness, setDmEffectiveness] = useState<DmEffItem[]>([]);
  const [dmEffLoading, setDmEffLoading] = useState(false);

  // Hourly Performance state
  const [hourlyPerf, setHourlyPerf] = useState<HourlyPerfItem[]>([]);
  const [hourlyPerfLoading, setHourlyPerfLoading] = useState(false);

  // Scenario state
  interface ScenarioItem {
    id: string;
    scenario_name: string;
    trigger_type: string;
    trigger_config: Record<string, unknown>;
    segment_targets: string[];
    steps: { step: number; delay_hours: number; template: string; message: string; goal?: string }[];
    is_active: boolean;
    auto_approve_step0: boolean;
    daily_send_limit: number;
    min_interval_hours: number;
    created_at: string;
  }
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [scenarioEnrollCounts, setScenarioEnrollCounts] = useState<Map<string, number>>(new Map());
  interface EnrollmentDetail { scenario_id: string; user_name: string; current_step: number; status: string; enrolled_at: string; }
  const [scenarioEnrollDetails, setScenarioEnrollDetails] = useState<Map<string, EnrollmentDetail[]>>(new Map());
  const [scenariosLoading, setScenariosLoading] = useState(false);
  const [scenarioExpanded, setScenarioExpanded] = useState<string | null>(null);
  const [enrollExpanded, setEnrollExpanded] = useState<Set<string>>(new Set());
  const [scenarioCreating, setScenarioCreating] = useState(false);
  const [newScenario, setNewScenario] = useState({ name: '', triggerType: 'first_payment', config: '{}' });
  const [scenarioProcessing, setScenarioProcessing] = useState(false);
  const [scenarioProcessResult, setScenarioProcessResult] = useState<{
    processed: number; errors: number; skipped: number; aiGenerated: number; aiErrors: number;
  } | null>(null);

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

  // H5: Segment legend — now managed by Accordion component (localStorage)

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
  interface MonthlyPL {
    month: string; cast_name: string; total_sessions: number; total_hours: number;
    total_tokens: number; gross_revenue_jpy: number; platform_fee_jpy: number;
    net_revenue_jpy: number; total_cast_cost_jpy: number; monthly_fixed_cost_jpy: number;
    gross_profit_jpy: number; profit_margin: number;
  }
  const [monthlyPL, setMonthlyPL] = useState<MonthlyPL[]>([]);
  const [monthlyPLLoading, setMonthlyPLLoading] = useState(false);
  const [monthlyPLError, setMonthlyPLError] = useState(false);

  // Revenue Share
  interface RevenueShareRow {
    week_start: string; week_end: string; week_label: string;
    transaction_count: number; total_tokens: number;
    setting_token_to_usd: number; setting_platform_fee_pct: number; setting_revenue_share_pct: number;
    gross_usd: number; platform_fee_usd: number; net_usd: number; cast_payment_usd: number;
    formula_gross: string; formula_fee: string; formula_net: string; formula_payment: string;
  }
  const [revenueShare, setRevenueShare] = useState<RevenueShareRow[]>([]);
  const [revenueShareLoading, setRevenueShareLoading] = useState(false);
  const [revenueShareExpanded, setRevenueShareExpanded] = useState<string | null>(null);

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

    // 新規応援ユーザー検出（直近24時間）
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
        .order('started_at', { ascending: false })
        .limit(500),
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
        // Queue counts computation
        const counts = { queued: 0, sending: 0, success: 0, error: 0, total: logs.length };
        logs.forEach(l => {
          if (l.status === 'queued') counts.queued++;
          else if (l.status === 'sending') counts.sending++;
          else if (l.status === 'success') counts.success++;
          else if (l.status === 'error') counts.error++;
        });
        setDmQueueCounts(counts);
      });

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

  // DM Realtime status polling
  const dmBatchIdRef = useRef(dmBatchId);
  dmBatchIdRef.current = dmBatchId;
  const dmCastChannelRef = useRef<ReturnType<typeof sb.channel> | null>(null);

  useEffect(() => {
    if (!accountId) return;

    // 前のチャネルをクリーンアップ
    if (dmCastChannelRef.current) {
      sb.removeChannel(dmCastChannelRef.current);
      dmCastChannelRef.current = null;
    }

    const channel = sb
      .channel(`dm-cast-status-realtime-${castName}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_send_log', filter: accountId ? `cast_name=eq.${castName},account_id=eq.${accountId}` : `cast_name=eq.${castName}` }, async () => {
        const bid = dmBatchIdRef.current;
        if (!bid) return;
        const { data: items } = await sb.from('dm_send_log')
          .select('*').eq('campaign', bid).eq('cast_name', castName).order('created_at', { ascending: false }).limit(5000);
        const logs = items || [];
        const counts = { total: logs.length, queued: 0, sending: 0, success: 0, error: 0 };
        logs.forEach((l: { status: string }) => { if (l.status in counts) (counts as Record<string, number>)[l.status]++; });
        setDmStatusCounts(counts);
      });
    subscribeWithRetry(channel);

    dmCastChannelRef.current = channel;

    return () => {
      if (dmCastChannelRef.current) {
        sb.removeChannel(dmCastChannelRef.current);
        dmCastChannelRef.current = null;
      }
    };
  }, [accountId, castName]); // dmBatchIdはRefで参照、depsから除外

  // DM: load individual user history (accordion expand)
  const loadDmUserHistory = useCallback(async (userName: string) => {
    if (dmExpandedUser === userName) { setDmExpandedUser(null); return; }
    setDmExpandedUser(userName);
    setDmUserHistoryLoading(true);
    const { data } = await sb.from('dm_send_log')
      .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .eq('user_name', userName)
      .order('created_at', { ascending: false })
      .limit(20);
    setDmUserHistory((data || []) as DMLogItem[]);
    setDmUserHistoryLoading(false);
  }, [dmExpandedUser, accountId, castName, sb]);

  // DM send
  const handleDmSend = useCallback(async () => {
    console.log('[DM-Cast] handleDmSend called, targets:', dmTargets.size, 'cast:', castName, 'deliveryMode:', dmDeliveryMode, 'sendOrder:', dmSendOrder);
    const needsMessage = dmSendOrder !== 'image_only';
    const needsImage = dmDeliveryMode === 'image_pipeline' && (dmSendOrder === 'image_only' || dmSendOrder === 'text_then_image' || dmSendOrder === 'image_then_text');
    if (dmTargets.size === 0 || (needsMessage && !dmMessage.trim()) || (needsImage && !dmImageFile) || !accountId) return;

    // DM安全ゲート: campaign必須チェック（タグ未入力時はブロック）
    if (!dmCampaign.trim()) {
      setDmError('キャンペーンタグは必須です。送信目的を識別するタグを入力してください。');
      return;
    }

    // DM安全ゲート: テストモード時ホワイトリスト外チェック
    const guardStatus = getDmGuardStatus();
    if (guardStatus.isTestMode) {
      const blocked = Array.from(dmTargets).filter(u => !DM_TEST_WHITELIST.has(u));
      if (blocked.length > 0) {
        const sample = blocked.slice(0, 5).join(', ');
        const suffix = blocked.length > 5 ? ` 他${blocked.length - 5}名` : '';
        setDmError(`[テストモード] ホワイトリスト外のユーザー${blocked.length}名をブロック: ${sample}${suffix}\n許可: ${guardStatus.whitelist.join(', ')}\n本番送信するにはDM_TEST_MODE=falseを設定`);
        return;
      }
    }

    // DM安全ゲート: 送信先プレビュー確認（未確認ならプレビューを表示して中断）
    if (!dmPreviewConfirmed) {
      setDmShowPreview(true);
      return;
    }

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
          p_cast_name: castName,
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

      // Step 1.5: 画像があればSupabase Storageにアップロード
      let uploadedImageUrl: string | null = null;
      if (dmImageFile) {
        const ext = dmImageFile.name.split('.').pop() || 'jpg';
        const path = `dm/${accountId}/${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: uploadErr } = await sb.storage.from('dm-images').upload(path, dmImageFile, {
          contentType: dmImageFile.type,
          upsert: false,
        });
        if (uploadErr) {
          console.error('[DM-Cast] 画像アップロード失敗:', uploadErr.message);
          setDmError(`画像アップロード失敗: ${uploadErr.message}`);
          setDmSending(false);
          return;
        }
        const { data: urlData } = sb.storage.from('dm-images').getPublicUrl(path);
        uploadedImageUrl = urlData.publicUrl;
        console.log('[DM-Cast] 画像アップロード完了:', uploadedImageUrl);
      }

      // Step 2: RPC失敗時のフォールバック — 直接INSERT
      // 画像付きの場合もRPCは非対応なので直接INSERT
      if (!usedRpc || uploadedImageUrl) {
        if (usedRpc && uploadedImageUrl) {
          // RPC成功したが画像ありなので、RPC登録分にimage_url+send_orderを一括更新
          const effectiveSendOrder = dmDeliveryMode === 'fast_text' ? 'text_only' : dmSendOrder;
          await sb.from('dm_send_log')
            .update({ image_url: uploadedImageUrl, image_sent: true, send_order: effectiveSendOrder })
            .eq('campaign', originalBid);
          console.log('[DM-Cast] RPC登録分にimage_url付与:', originalBid);
        } else if (!usedRpc) {
        console.log('[DM-Cast] Step2: direct INSERT for', usernames.length, 'users');
        originalBid = `bulk_${timestamp}`;
        const effectiveSendOrder = dmDeliveryMode === 'fast_text' ? 'text_only' : dmSendOrder;
        const rows = usernames.map(un => ({
          account_id: accountId,
          user_name: un,
          message: effectiveSendOrder === 'image_only' ? '' : dmMessage,
          image_url: uploadedImageUrl,
          image_sent: !!uploadedImageUrl,
          send_order: effectiveSendOrder,
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
      }

      // Step 3: キャンペーン名更新（テストモード時は test_ プレフィックス自動付与）
      const testPrefix = dmIsTest ? 'test_' : '';
      const bid = `${testPrefix}${modePrefix}_${tag}${originalBid}`;
      console.log('[DM-Cast] Step3: campaign=', bid, dmIsTest ? '(test mode)' : '');
      await sb.from('dm_send_log').update({ campaign: bid, cast_name: castName }).eq('campaign', originalBid);

      setDmBatchId(bid);
      setDmResult({ count, batch_id: bid });
      setDmStatusCounts({ total: count, queued: count, sending: 0, success: 0, error: 0 });
      setDmTargets(new Set());
      setDmMessage('');
      setDmCampaign('');
      setDmImageFile(null);
      setDmPreviewConfirmed(false);
      setDmShowPreview(false);
      if (dmImagePreview) { URL.revokeObjectURL(dmImagePreview); setDmImagePreview(null); }

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
  }, [dmTargets, dmMessage, dmCampaign, dmIsTest, dmSendMode, dmTabs, accountId, castName, sb, dmImageFile, dmImagePreview, dmDeliveryMode, dmSendOrder, dmPreviewConfirmed]);

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
      const rawTag = dmCampaign.trim() || null;
      const campaignTag = dmIsTest ? `test_${rawTag || 'scheduled'}` : rawTag;

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
  }, [dmTargets, dmMessage, dmCampaign, dmIsTest, dmSendMode, dmTabs, dmScheduleDate, dmScheduleTime, accountId, castName, sb]);

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
    if (!accountId || activeTab !== 'analytics') return;
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
  // Broadcast analysis: セッション一覧取得
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'sessions') return;
    setBroadcastLoading(true);
    sb.rpc('get_session_list', {
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
      const filtered = (data as BroadcastSessionItem[]).filter(s => new Date(s.started_at) >= cutoff);
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

                <Accordion id={`cast-${castName}-new-paying`} title="新規応援ユーザー（24h）" icon="🆕" defaultOpen={false}>
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
                        <h3 className="text-sm font-bold">新規応援ユーザー（24h）</h3>
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

                </Accordion>

                <Accordion id={`cast-${castName}-recent-sessions`} title="直近の配信" icon="📺" badge={`${sessions.length}件`} defaultOpen={false}>
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
                </Accordion>
              </div>

              {/* Data sync panel */}
              {accountId && (
                <DataSyncPanel supabase={sb} accountId={accountId} castName={castName} />
              )}

              <Accordion id={`cast-${castName}-top-fans`} title="トップファン" icon="💰" badge={`${fans.length}名`} defaultOpen={false}>
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
              </Accordion>
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
                          const label = `${d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' })} — ${formatTokens(s.coin_revenue || s.total_tokens)}tk (${s.duration_minutes}分)`;
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
                          <p className="text-2xl font-bold text-amber-400 mt-1">{formatTokens(broadcastBreakdown.total_tokens)}<span className="text-xs ml-1">tk</span></p>
                          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            ¥{tokensToJPY(broadcastBreakdown.total_tokens, 7.7)}
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
                                        {formatTokens(tokens)}tk ({pct}%) — ¥{tokensToJPY(tokens, 7.7)}
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
                                    <p className="text-sm font-bold text-amber-400">{formatTokens(u.tokens)}tk</p>
                                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>¥{tokensToJPY(u.tokens, 7.7)}</p>
                                  </div>
                                  <button
                                    onClick={() => {
                                      setDmTargets(new Set([u.user_name]));
                                      setDmMessage(`${u.user_name}さん、今日はありがとう！またよろしくね😊`);
                                      setTab('dm');
                                    }}
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
                                    <p className="text-sm font-bold text-amber-400">{formatTokens(u.total_tokens_on_date)}tk</p>
                                    <button
                                      onClick={() => {
                                        setDmTargets(new Set([u.user_name]));
                                        setDmMessage(`${u.user_name}さん、初めてのチップありがとう！すごく嬉しかったです😊`);
                                        setTab('dm');
                                      }}
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
                                  ({formatTokens(broadcastBreakdown.prev_session_tokens)}tk)
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
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    全{dmQueueCounts.total.toLocaleString()}件
                  </span>
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
                  { key: 'users' as const, icon: '👥', label: 'ユーザー別' },
                  { key: 'send' as const, icon: '✉️', label: 'DM送信' },
                  { key: 'segments' as const, icon: '🎯', label: 'セグメント別' },
                  { key: 'campaigns' as const, icon: '📊', label: 'キャンペーン' },
                  { key: 'scenarios' as const, icon: '📋', label: 'シナリオ' },
                  { key: 'effectiveness' as const, icon: '📈', label: '効果測定' },
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
              {dmSection === 'users' && (
                <div className="glass-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold">👥 ユーザー別DM履歴</h3>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {(() => {
                        const userSet = new Set(dmLogs.map(l => l.user_name));
                        return `${userSet.size}名にDM送信済み`;
                      })()}
                    </span>
                  </div>

                  {/* Search */}
                  <div className="mb-3">
                    <input
                      type="text"
                      value={dmUserSearch}
                      onChange={e => setDmUserSearch(e.target.value)}
                      className="input-glass text-xs w-full"
                      placeholder="ユーザー名で検索..."
                    />
                  </div>

                  {dmLogs.length === 0 ? (
                    <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>DM送信履歴なし</p>
                  ) : (
                    <div className="space-y-1 max-h-[500px] overflow-auto">
                      {(() => {
                        // Group dmLogs by user_name
                        const userMap = new Map<string, { lastLog: DMLogItem; count: number; successCount: number }>();
                        for (const log of dmLogs) {
                          if (!userMap.has(log.user_name)) {
                            userMap.set(log.user_name, { lastLog: log, count: 1, successCount: log.status === 'success' ? 1 : 0 });
                          } else {
                            const entry = userMap.get(log.user_name)!;
                            entry.count++;
                            if (log.status === 'success') entry.successCount++;
                          }
                        }
                        const filtered = dmUserSearch.trim()
                          ? Array.from(userMap.entries()).filter(([name]) => name.toLowerCase().includes(dmUserSearch.toLowerCase()))
                          : Array.from(userMap.entries());

                        return filtered.map(([userName, info]) => {
                          const isExpanded = dmExpandedUser === userName;
                          const fan = fans.find(f => f.user_name === userName);
                          return (
                            <div key={userName}>
                              <button
                                onClick={() => loadDmUserHistory(userName)}
                                className={`w-full text-left px-3 py-2.5 rounded-lg text-[11px] transition-all ${
                                  isExpanded ? 'border' : 'hover:bg-white/[0.03]'
                                }`}
                                style={isExpanded ? { background: 'rgba(56,189,248,0.05)', borderColor: 'rgba(56,189,248,0.15)' } : {}}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-semibold truncate">{userName}</span>
                                    {fan && (
                                      <span className="text-[9px] px-1.5 py-0.5 rounded font-bold tabular-nums"
                                        style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--accent-amber)' }}>
                                        {fan.total_tokens.toLocaleString()}tk
                                      </span>
                                    )}
                                    <span className="text-[9px] px-1.5 py-0.5 rounded"
                                      style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                                      {info.count}件
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    <span className={`text-[10px] font-bold ${
                                      info.lastLog.status === 'success' ? 'text-emerald-400' :
                                      info.lastLog.status === 'error' ? 'text-rose-400' :
                                      info.lastLog.status === 'sending' ? 'text-amber-400' : 'text-slate-400'
                                    }`}>
                                      {info.lastLog.status}
                                    </span>
                                    <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                      {info.lastLog.sent_at
                                        ? new Date(info.lastLog.sent_at).toLocaleDateString('ja-JP')
                                        : timeAgo(info.lastLog.queued_at)}
                                    </span>
                                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                      {isExpanded ? '▲' : '▼'}
                                    </span>
                                  </div>
                                </div>
                              </button>

                              {/* Expanded: DM timeline */}
                              {isExpanded && (
                                <div className="ml-4 mt-1 mb-2 pl-3 border-l-2 space-y-1.5" style={{ borderColor: 'rgba(56,189,248,0.15)' }}>
                                  {dmUserHistoryLoading ? (
                                    <div className="py-3 text-center">
                                      <div className="inline-block w-4 h-4 border-2 rounded-full animate-spin"
                                        style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
                                    </div>
                                  ) : dmUserHistory.length === 0 ? (
                                    <p className="text-[10px] py-2" style={{ color: 'var(--text-muted)' }}>履歴なし</p>
                                  ) : (
                                    dmUserHistory.map(log => (
                                      <div key={log.id} className="px-3 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                                        <div className="flex items-center justify-between mb-1">
                                          <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                                              {log.sent_at
                                                ? new Date(log.sent_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                                : new Date(log.queued_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                            {log.campaign && (
                                              <span className="text-[9px] px-1.5 py-0.5 rounded"
                                                style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                                                {log.campaign}
                                              </span>
                                            )}
                                          </div>
                                          <span className={`text-[9px] font-bold ${
                                            log.status === 'success' ? 'text-emerald-400' :
                                            log.status === 'error' ? 'text-rose-400' :
                                            log.status === 'sending' ? 'text-amber-400' : 'text-slate-400'
                                          }`}>{log.status}</span>
                                        </div>
                                        {log.message && (
                                          <p className="text-[10px] whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
                                            {log.message}
                                          </p>
                                        )}
                                        {log.error && (
                                          <p className="text-[9px] mt-1" style={{ color: 'var(--accent-pink)' }}>{log.error}</p>
                                        )}
                                      </div>
                                    ))
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  )}
                </div>
              )}

              {/* Section C: DM送信 */}
              {dmSection === 'send' && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-2 space-y-4">
                    {/* Send form */}
                    <div className="glass-card p-5">
                      <h3 className="text-sm font-bold mb-4">✉️ DM送信</h3>

                      {/* 送信モード選択カード */}
                      <div className="grid grid-cols-2 gap-3 mb-4">
                        <button
                          onClick={() => {
                            setDmDeliveryMode('fast_text');
                            setDmSendMode('sequential');
                            setDmSendOrder('text_only');
                            setDmImageFile(null);
                            if (dmImagePreview) { URL.revokeObjectURL(dmImagePreview); setDmImagePreview(null); }
                          }}
                          className="p-3 rounded-xl text-left transition-all"
                          style={{
                            background: dmDeliveryMode === 'fast_text' ? 'rgba(56,189,248,0.1)' : 'rgba(15,23,42,0.4)',
                            border: `1px solid ${dmDeliveryMode === 'fast_text' ? 'rgba(56,189,248,0.3)' : 'var(--border-glass)'}`,
                          }}
                        >
                          <p className="text-xs font-bold mb-1" style={{ color: dmDeliveryMode === 'fast_text' ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                            ⚡ 高速テキスト送信
                          </p>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>API送信（~2秒/通）</p>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>テキストDMのみ</p>
                        </button>
                        <button
                          onClick={() => {
                            setDmDeliveryMode('image_pipeline');
                            setDmSendMode('pipeline');
                            if (dmSendOrder === 'text_only') setDmSendOrder('text_then_image');
                          }}
                          className="p-3 rounded-xl text-left transition-all"
                          style={{
                            background: dmDeliveryMode === 'image_pipeline' ? 'rgba(167,139,250,0.1)' : 'rgba(15,23,42,0.4)',
                            border: `1px solid ${dmDeliveryMode === 'image_pipeline' ? 'rgba(167,139,250,0.3)' : 'var(--border-glass)'}`,
                          }}
                        >
                          <p className="text-xs font-bold mb-1" style={{ color: dmDeliveryMode === 'image_pipeline' ? 'var(--accent-purple)' : 'var(--text-secondary)' }}>
                            🖼 画像付きパイプライン
                          </p>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>DOM操作（~18秒/通）</p>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>画像+テキスト対応</p>
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 mb-3">
                        <div>
                          <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>キャンペーンタグ</label>
                          <div className="flex gap-2 items-center">
                            <input type="text" value={dmCampaign} onChange={e => setDmCampaign(e.target.value)}
                              className="input-glass text-xs flex-1" placeholder="例: バレンタイン復帰DM" />
                            <button
                              onClick={() => setDmIsTest(p => !p)}
                              className={`shrink-0 text-[10px] px-2.5 py-1.5 rounded-lg font-medium transition-all ${dmIsTest ? 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40' : 'btn-ghost opacity-60'}`}
                              title="ONにするとcampaignにtest_プレフィックスが付き、テストデータ管理から一括削除可能"
                            >
                              {dmIsTest ? 'テスト ON' : 'テスト'}
                            </button>
                          </div>
                          {dmIsTest && (
                            <p className="text-[9px] mt-1" style={{ color: 'var(--accent-amber)' }}>
                              test_ プレフィックスが自動付与されます（管理画面から一括削除可能）
                            </p>
                          )}
                        </div>
                        {dmDeliveryMode === 'image_pipeline' && (
                          <div>
                            <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>パイプライン設定</label>
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
                        )}
                      </div>

                      {/* 送信順序セレクター（画像パイプライン時のみ） */}
                      {dmDeliveryMode === 'image_pipeline' && (
                        <div className="mb-3">
                          <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>送信順序</label>
                          <div className="flex gap-1.5 flex-wrap">
                            {([
                              { key: 'text_then_image' as const, label: 'テキスト→画像', desc: 'テキスト送信後に画像送信' },
                              { key: 'image_then_text' as const, label: '画像→テキスト', desc: '画像送信後にテキスト送信' },
                              { key: 'text_only' as const, label: 'テキストのみ', desc: '画像を使わずテキストのみ' },
                              { key: 'image_only' as const, label: '画像のみ', desc: 'テキストなしで画像のみ' },
                            ]).map(opt => (
                              <button
                                key={opt.key}
                                onClick={() => setDmSendOrder(opt.key)}
                                className="text-[10px] px-3 py-1.5 rounded-lg transition-all"
                                style={{
                                  background: dmSendOrder === opt.key ? 'rgba(167,139,250,0.12)' : 'transparent',
                                  color: dmSendOrder === opt.key ? 'var(--accent-purple)' : 'var(--text-muted)',
                                  border: dmSendOrder === opt.key ? '1px solid rgba(167,139,250,0.25)' : '1px solid transparent',
                                }}
                                title={opt.desc}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mb-3">
                        <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>
                          メッセージ {dmSendOrder !== 'image_only' && <span style={{ color: 'var(--accent-pink)' }}>*</span>}
                          {dmSendOrder === 'image_only' && <span className="text-[9px] ml-1" style={{ color: 'var(--text-muted)' }}>（任意）</span>}
                        </label>
                        <textarea value={dmMessage} onChange={e => setDmMessage(e.target.value)}
                          className="input-glass text-xs w-full h-24 resize-none"
                          placeholder={dmSendOrder === 'image_only' ? '画像のみ送信（テキストは任意）' : 'メッセージを入力... {username}でユーザー名置換'} />
                      </div>

                      {/* 画像添付（画像パイプライン時のみ） */}
                      {dmDeliveryMode === 'image_pipeline' && (
                      <div className="mb-3">
                        <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>
                          画像添付{dmSendOrder === 'image_only' || dmSendOrder === 'text_then_image' || dmSendOrder === 'image_then_text'
                            ? <span style={{ color: 'var(--accent-pink)' }}> *</span>
                            : '（任意）'}
                        </label>
                        <input
                          ref={dmImageInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              setDmImageFile(file);
                              if (dmImagePreview) URL.revokeObjectURL(dmImagePreview);
                              setDmImagePreview(URL.createObjectURL(file));
                            }
                            e.target.value = '';
                          }}
                        />
                        {dmImagePreview ? (
                          <div className="flex items-start gap-3">
                            <div className="relative">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={dmImagePreview} alt="DM画像プレビュー" className="w-20 h-20 rounded-lg object-cover border" style={{ borderColor: 'var(--border-glass)' }} />
                              <button
                                onClick={() => {
                                  setDmImageFile(null);
                                  if (dmImagePreview) URL.revokeObjectURL(dmImagePreview);
                                  setDmImagePreview(null);
                                }}
                                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px]"
                                style={{ background: 'var(--accent-pink)', color: 'white' }}
                              >
                                x
                              </button>
                            </div>
                            <div className="text-[10px] pt-1" style={{ color: 'var(--text-muted)' }}>
                              <p>{dmImageFile?.name}</p>
                              <p>{dmImageFile ? `${(dmImageFile.size / 1024).toFixed(0)}KB` : ''}</p>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => dmImageInputRef.current?.click()}
                            className="btn-ghost text-[10px] px-3 py-1.5 rounded-lg"
                          >
                            🖼 画像を選択
                          </button>
                        )}
                      </div>
                      )}

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

              {/* Section: セグメント別DM送信 */}
              {dmSection === 'segments' && accountId && (
                <DmSegmentSender
                  supabase={sb}
                  accountId={accountId}
                  castName={castName}
                  onSendComplete={() => {
                    // DM送信完了後にログ再取得
                    sb.from('dm_send_log')
                      .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
                      .eq('account_id', accountId).eq('cast_name', castName)
                      .order('created_at', { ascending: false }).limit(200)
                      .then(({ data }) => setDmLogs((data || []) as DMLogItem[]));
                  }}
                />
              )}

              {/* Section D: キャンペーン履歴 */}
              {dmSection === 'campaigns' && (
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold mb-3">📊 キャンペーン別集計</h3>
                  {dmLogs.length === 0 ? (
                    <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>DM送信履歴なし</p>
                  ) : (
                    <div className="space-y-2">
                      {(() => {
                        const campMap = new Map<string, { total: number; success: number; error: number; sending: number; queued: number; lastSent: string | null }>();
                        for (const log of dmLogs) {
                          const c = log.campaign || '(タグなし)';
                          if (!campMap.has(c)) {
                            campMap.set(c, { total: 0, success: 0, error: 0, sending: 0, queued: 0, lastSent: null });
                          }
                          const entry = campMap.get(c)!;
                          entry.total++;
                          if (log.status === 'success') { entry.success++; if (!entry.lastSent || (log.sent_at && log.sent_at > entry.lastSent)) entry.lastSent = log.sent_at; }
                          else if (log.status === 'error') entry.error++;
                          else if (log.status === 'sending') entry.sending++;
                          else if (log.status === 'queued') entry.queued++;
                        }
                        return Array.from(campMap.entries())
                          .sort((a, b) => b[1].total - a[1].total)
                          .map(([campaign, stats]) => (
                            <div key={campaign} className="glass-panel px-4 py-3 rounded-xl">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[11px] font-bold truncate">{campaign}</span>
                                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                  {stats.lastSent ? new Date(stats.lastSent).toLocaleDateString('ja-JP') : ''}
                                </span>
                              </div>
                              {/* Progress bar */}
                              <div className="h-2 rounded-full overflow-hidden flex mb-2" style={{ background: 'rgba(0,0,0,0.2)' }}>
                                {stats.success > 0 && (
                                  <div style={{ width: `${(stats.success / stats.total) * 100}%`, background: 'var(--accent-green)' }} />
                                )}
                                {stats.sending > 0 && (
                                  <div style={{ width: `${(stats.sending / stats.total) * 100}%`, background: 'var(--accent-amber)' }} />
                                )}
                                {stats.queued > 0 && (
                                  <div style={{ width: `${(stats.queued / stats.total) * 100}%`, background: 'var(--accent-primary)' }} />
                                )}
                                {stats.error > 0 && (
                                  <div style={{ width: `${(stats.error / stats.total) * 100}%`, background: 'var(--accent-pink)' }} />
                                )}
                              </div>
                              <div className="flex gap-3 text-[10px]">
                                <span style={{ color: 'var(--text-muted)' }}>全{stats.total}件</span>
                                <span style={{ color: 'var(--accent-green)' }}>成功 {stats.success}</span>
                                {stats.error > 0 && <span style={{ color: 'var(--accent-pink)' }}>失敗 {stats.error}</span>}
                                {(stats.queued + stats.sending) > 0 && (
                                  <span style={{ color: 'var(--accent-amber)' }}>処理中 {stats.queued + stats.sending}</span>
                                )}
                                {stats.total > 0 && (
                                  <span style={{ color: 'var(--accent-primary)' }}>
                                    成功率 {Math.round((stats.success / stats.total) * 1000) / 10}%
                                  </span>
                                )}
                              </div>
                            </div>
                          ));
                      })()}
                    </div>
                  )}
                </div>
              )}

              {/* Section D: シナリオ */}
              {dmSection === 'scenarios' && (
                <div className="glass-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold">📋 DMシナリオ</h3>
                    <div className="flex items-center gap-2">
                      <button
                        disabled={scenarioProcessing || !accountId}
                        onClick={async () => {
                          if (!accountId) return;
                          setScenarioProcessing(true);
                          setScenarioProcessResult(null);
                          try {
                            const { data: { session } } = await sb.auth.getSession();
                            const res = await fetch('/api/scenario/process', {
                              method: 'POST',
                              headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${session?.access_token || ''}`,
                              },
                              body: JSON.stringify({ account_id: accountId }),
                            });
                            const result = await res.json();
                            if (res.ok) {
                              setScenarioProcessResult(result);
                            } else {
                              alert(result.error || 'キュー処理失敗');
                            }
                          } catch (e) {
                            alert('キュー処理エラー: ' + (e instanceof Error ? e.message : ''));
                          } finally {
                            setScenarioProcessing(false);
                          }
                        }}
                        className="text-[10px] px-2 py-1 rounded-lg disabled:opacity-40"
                        style={{
                          background: 'rgba(34,197,94,0.12)',
                          border: '1px solid rgba(34,197,94,0.3)',
                          color: 'var(--accent-green)',
                        }}
                      >
                        {scenarioProcessing ? '処理中...' : '▶ キュー実行'}
                      </button>
                      <button
                        onClick={() => setScenarioCreating(!scenarioCreating)}
                        className="text-[10px] px-2 py-1 rounded-lg"
                        style={{
                          background: 'rgba(56,189,248,0.12)',
                          border: '1px solid rgba(56,189,248,0.3)',
                          color: 'var(--accent-primary)',
                        }}
                      >
                        {scenarioCreating ? '✕ 閉じる' : '＋ 新規作成'}
                      </button>
                    </div>
                  </div>

                  {/* キュー処理結果 */}
                  {scenarioProcessResult && (
                    <div className="glass-panel rounded-lg p-2 mb-3 flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--accent-green)' }}>処理: {scenarioProcessResult.processed}件</span>
                      {scenarioProcessResult.aiGenerated > 0 && (
                        <span style={{ color: 'var(--accent-purple)' }}>AI生成: {scenarioProcessResult.aiGenerated}件</span>
                      )}
                      {scenarioProcessResult.skipped > 0 && (
                        <span style={{ color: 'var(--text-muted)' }}>スキップ: {scenarioProcessResult.skipped}件</span>
                      )}
                      {scenarioProcessResult.errors > 0 && (
                        <span style={{ color: 'var(--accent-pink)' }}>エラー: {scenarioProcessResult.errors}件</span>
                      )}
                      {scenarioProcessResult.aiErrors > 0 && (
                        <span style={{ color: 'var(--accent-amber)' }}>AI失敗(テンプレ代替): {scenarioProcessResult.aiErrors}件</span>
                      )}
                    </div>
                  )}

                  {/* 新規作成フォーム */}
                  {scenarioCreating && (
                    <div className="glass-panel rounded-lg p-3 mb-3 space-y-2">
                      <input
                        className="input-glass text-xs w-full"
                        placeholder="シナリオ名（例: 初回応援お礼）"
                        value={newScenario.name}
                        onChange={e => setNewScenario(prev => ({ ...prev, name: e.target.value }))}
                      />
                      <select
                        className="input-glass text-xs w-full"
                        value={newScenario.triggerType}
                        onChange={e => setNewScenario(prev => ({ ...prev, triggerType: e.target.value }))}
                      >
                        <option value="first_payment">初回応援</option>
                        <option value="high_payment">高額応援</option>
                        <option value="visit_no_action">来訪（応援なし）</option>
                        <option value="dormant">離脱（N日不在）</option>
                        <option value="segment_change">セグメント変化</option>
                        <option value="manual">手動エンロール</option>
                        <option value="thankyou_vip">VIPお礼</option>
                        <option value="thankyou_regular">常連お礼</option>
                        <option value="thankyou_first">初回お礼</option>
                        <option value="churn_recovery">離脱防止</option>
                      </select>
                      {newScenario.triggerType === 'dormant' && (
                        <input
                          className="input-glass text-xs w-full"
                          placeholder='設定JSON（例: {"days": 7}）'
                          value={newScenario.config}
                          onChange={e => setNewScenario(prev => ({ ...prev, config: e.target.value }))}
                        />
                      )}
                      <button
                        className="btn-primary text-xs px-3 py-1.5 w-full"
                        disabled={!newScenario.name.trim()}
                        onClick={async () => {
                          if (!accountId || !newScenario.name.trim()) return;
                          // 重複チェック
                          const dupName = newScenario.name.trim();
                          if (scenarios.some(s => s.scenario_name === dupName)) {
                            alert('同じ名前のシナリオが既に存在します: ' + dupName);
                            return;
                          }
                          let config = {};
                          try { config = JSON.parse(newScenario.config); } catch { /* ignore */ }
                          const { error } = await sb.from('dm_scenarios').insert({
                            account_id: accountId,
                            scenario_name: newScenario.name.trim(),
                            trigger_type: newScenario.triggerType,
                            trigger_config: config,
                            segment_targets: [],
                            steps: [],
                            is_active: true,
                            auto_approve_step0: true,
                            daily_send_limit: 50,
                            min_interval_hours: 24,
                          });
                          if (error) {
                            if (error.code === '23505') {
                              alert('同じ名前のシナリオが既に存在します');
                            } else {
                              alert('作成失敗: ' + error.message);
                            }
                            return;
                          }
                          setScenarioCreating(false);
                          setNewScenario({ name: '', triggerType: 'first_payment', config: '{}' });
                          // リロード
                          const { data: fresh } = await sb.from('dm_scenarios')
                            .select('*').eq('account_id', accountId).order('created_at', { ascending: false });
                          setScenarios((fresh || []) as ScenarioItem[]);
                        }}
                      >
                        作成
                      </button>
                    </div>
                  )}

                  {/* シナリオ一覧 */}
                  {scenariosLoading ? (
                    <div className="space-y-2">
                      {[...Array(3)].map((_, i) => (
                        <div key={i} className="h-16 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.03)' }} />
                      ))}
                    </div>
                  ) : scenarios.length === 0 ? (
                    <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                      シナリオが登録されていません
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {scenarios.map(sc => {
                        const triggerLabels: Record<string, string> = {
                          first_payment: '初回応援', high_payment: '高額応援',
                          visit_no_action: '来訪（応援なし）', dormant: '離脱',
                          segment_change: 'セグメント変化', manual: '手動',
                          thankyou_vip: 'VIPお礼', thankyou_regular: '常連お礼',
                          thankyou_first: '初回お礼', churn_recovery: '離脱防止',
                        };
                        const enrollCount = scenarioEnrollCounts.get(sc.id) || 0;
                        const isExpanded = scenarioExpanded === sc.id;
                        return (
                          <div key={sc.id} className="glass-panel rounded-lg overflow-hidden">
                            <div
                              className="px-3 py-2.5 flex items-center justify-between cursor-pointer hover:bg-white/[0.02]"
                              onClick={() => setScenarioExpanded(isExpanded ? null : sc.id)}
                            >
                              <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${sc.is_active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                                <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
                                  {sc.scenario_name}
                                </span>
                                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{
                                  background: 'rgba(167,139,250,0.12)',
                                  color: 'var(--accent-purple)',
                                }}>
                                  {triggerLabels[sc.trigger_type] || sc.trigger_type}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                <span>{(sc.steps || []).length}ステップ</span>
                                {enrollCount > 0 && (
                                  <span style={{ color: 'var(--accent-primary)' }}>{enrollCount}名進行中</span>
                                )}
                                <span>{isExpanded ? '▲' : '▼'}</span>
                              </div>
                            </div>

                            {isExpanded && (
                              <div className="px-3 pb-3 space-y-2">
                                {/* Toggle active */}
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    {sc.is_active ? '有効' : '無効'}
                                  </span>
                                  <button
                                    className="text-[10px] px-2 py-0.5 rounded"
                                    style={{
                                      background: sc.is_active ? 'rgba(244,63,94,0.12)' : 'rgba(34,197,94,0.12)',
                                      color: sc.is_active ? 'var(--accent-pink)' : 'var(--accent-green)',
                                    }}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      await sb.from('dm_scenarios').update({ is_active: !sc.is_active }).eq('id', sc.id);
                                      setScenarios(prev => prev.map(s => s.id === sc.id ? { ...s, is_active: !s.is_active } : s));
                                    }}
                                  >
                                    {sc.is_active ? '無効にする' : '有効にする'}
                                  </button>
                                </div>

                                {/* Config info */}
                                {sc.trigger_config && Object.keys(sc.trigger_config).length > 0 && (
                                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    設定: {JSON.stringify(sc.trigger_config)}
                                  </p>
                                )}
                                {sc.segment_targets && sc.segment_targets.length > 0 && (
                                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    対象セグメント: {sc.segment_targets.join(', ')}
                                  </p>
                                )}

                                {/* Steps */}
                                <div className="space-y-1.5">
                                  <p className="text-[10px] font-bold" style={{ color: 'var(--text-secondary)' }}>ステップ一覧:</p>
                                  {(sc.steps || []).length === 0 ? (
                                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ステップ未設定</p>
                                  ) : (
                                    (sc.steps || []).map((step, i) => (
                                      <div key={i} className="flex items-start gap-2 text-[10px] rounded px-2 py-1.5"
                                        style={{ background: 'rgba(0,0,0,0.15)' }}>
                                        <span className="font-bold shrink-0" style={{ color: 'var(--accent-primary)' }}>
                                          Step {i}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                          <p style={{ color: 'var(--text-muted)' }}>
                                            {step.delay_hours > 0 ? `${step.delay_hours}時間後` : '即時'}
                                            {step.goal && ` → ゴール: ${step.goal}`}
                                          </p>
                                          <p className="truncate" style={{ color: 'var(--text-secondary)' }}>
                                            {step.message || step.template}
                                          </p>
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>

                                {/* Limits info */}
                                <div className="flex gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                  <span>日次上限: {sc.daily_send_limit}</span>
                                  <span>最小間隔: {sc.min_interval_hours}h</span>
                                  <span>Step0自動: {sc.auto_approve_step0 ? 'ON' : 'OFF'}</span>
                                </div>

                                {/* エンロールメント詳細リスト（折りたたみ） */}
                                {enrollCount > 0 && (() => {
                                  const details = scenarioEnrollDetails.get(sc.id) || [];
                                  const isEnrollOpen = enrollExpanded.has(sc.id);
                                  const displayLimit = 30;
                                  const visibleEnrolls = isEnrollOpen ? details.slice(0, displayLimit) : [];
                                  return (
                                    <div className="mt-1">
                                      <button
                                        onClick={() => setEnrollExpanded(prev => {
                                          const next = new Set(prev);
                                          if (next.has(sc.id)) next.delete(sc.id); else next.add(sc.id);
                                          return next;
                                        })}
                                        className="flex items-center gap-2 text-[10px] font-semibold w-full text-left hover:opacity-80 transition-opacity py-1"
                                        style={{ color: 'var(--accent-primary)' }}
                                      >
                                        <span>{isEnrollOpen ? '▼' : '▶'}</span>
                                        <span>進行中ユーザー（{enrollCount}名）</span>
                                      </button>
                                      {isEnrollOpen && (
                                        <div className="space-y-0.5 max-h-60 overflow-auto mt-1">
                                          {visibleEnrolls.map(e => (
                                            <div key={e.user_name} className="flex items-center justify-between text-[10px] px-2 py-1 rounded hover:bg-white/[0.03]">
                                              <span className="truncate font-medium" style={{ color: 'var(--text-secondary)' }}>
                                                {e.user_name}
                                              </span>
                                              <div className="flex items-center gap-2 flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                <span className="px-1.5 py-0.5 rounded" style={{
                                                  background: 'rgba(56,189,248,0.1)',
                                                  color: 'var(--accent-primary)',
                                                }}>
                                                  Step {e.current_step}
                                                </span>
                                                <span>{new Date(e.enrolled_at).toLocaleDateString('ja-JP')}</span>
                                              </div>
                                            </div>
                                          ))}
                                          {details.length > displayLimit && (
                                            <p className="text-[10px] text-center py-1" style={{ color: 'var(--text-muted)' }}>
                                              ... 他 {details.length - displayLimit}名
                                            </p>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Section E: 効果測定 */}
              {dmSection === 'effectiveness' && (
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold mb-3">📈 DM効果測定（セグメント別）</h3>
                  {dmEffLoading ? (
                    <div className="space-y-2">
                      {[...Array(4)].map((_, i) => (
                        <div key={i} className="h-10 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.03)' }} />
                      ))}
                    </div>
                  ) : dmEffectiveness.length === 0 ? (
                    <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                      直近30日間のDM送信データがありません
                    </p>
                  ) : (
                    <>
                      {/* サマリーカード */}
                      {(() => {
                        const segMap = new Map<string, { sent: number; paid: number; tokens: number }>();
                        dmEffectiveness.forEach(r => {
                          const prev = segMap.get(r.segment) || { sent: 0, paid: 0, tokens: 0 };
                          segMap.set(r.segment, {
                            sent: prev.sent + r.sent_count,
                            paid: prev.paid + r.paid_count,
                            tokens: prev.tokens + r.total_tokens,
                          });
                        });
                        const segArr = Array.from(segMap.entries())
                          .map(([seg, v]) => ({ seg, ...v, cvr: v.sent > 0 ? (v.paid / v.sent) * 100 : 0 }))
                          .sort((a, b) => b.cvr - a.cvr);
                        const best = segArr[0];
                        const totalSent = segArr.reduce((s, v) => s + v.sent, 0);
                        const totalPaid = segArr.reduce((s, v) => s + v.paid, 0);
                        const totalTk = segArr.reduce((s, v) => s + v.tokens, 0);
                        return (
                          <div className="grid grid-cols-4 gap-2 mb-4">
                            <div className="glass-panel rounded-lg p-2 text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>送信数</p>
                              <p className="text-lg font-bold">{totalSent.toLocaleString()}</p>
                            </div>
                            <div className="glass-panel rounded-lg p-2 text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>応援CVR</p>
                              <p className="text-lg font-bold" style={{ color: 'var(--accent-green)' }}>
                                {totalSent > 0 ? ((totalPaid / totalSent) * 100).toFixed(1) : '0'}%
                              </p>
                            </div>
                            <div className="glass-panel rounded-lg p-2 text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>売上貢献</p>
                              <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>
                                {formatTokens(totalTk)}
                              </p>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(totalTk)}</p>
                            </div>
                            <div className="glass-panel rounded-lg p-2 text-center" style={{ border: '1px solid rgba(34,197,94,0.3)' }}>
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>最高ROIセグメント</p>
                              <p className="text-sm font-bold" style={{ color: 'var(--accent-green)' }}>
                                {best ? best.seg : '-'}
                              </p>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                CVR {best ? best.cvr.toFixed(1) : 0}%
                              </p>
                            </div>
                          </div>
                        );
                      })()}

                      {/* テーブル */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                              <th className="text-left py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>キャンペーン</th>
                              <th className="text-left py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>セグメント</th>
                              <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>送信</th>
                              <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>来訪CVR</th>
                              <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>応援CVR</th>
                              <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>売上</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dmEffectiveness.map((r, i) => {
                              const segColors: Record<string, string> = {
                                whale: '#f59e0b', vip: '#a78bfa', regular: '#38bdf8',
                                light: '#94a3b8', new: '#22c55e', churned: '#f43f5e', unknown: '#475569',
                              };
                              return (
                                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                                  <td className="py-1.5 px-2 font-mono text-[10px]">{r.campaign || '-'}</td>
                                  <td className="py-1.5 px-2">
                                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                                      style={{
                                        background: `${segColors[r.segment] || '#475569'}20`,
                                        color: segColors[r.segment] || '#475569',
                                      }}>
                                      {r.segment}
                                    </span>
                                  </td>
                                  <td className="py-1.5 px-2 text-right">{r.sent_count}</td>
                                  <td className="py-1.5 px-2 text-right">
                                    <div className="flex items-center justify-end gap-1">
                                      <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                        <div className="h-full rounded-full" style={{
                                          width: `${Math.min(r.visit_cvr || 0, 100)}%`,
                                          background: 'var(--accent-primary)',
                                        }} />
                                      </div>
                                      <span>{(r.visit_cvr || 0).toFixed(1)}%</span>
                                    </div>
                                  </td>
                                  <td className="py-1.5 px-2 text-right">
                                    <div className="flex items-center justify-end gap-1">
                                      <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                        <div className="h-full rounded-full" style={{
                                          width: `${Math.min(r.payment_cvr || 0, 100)}%`,
                                          background: 'var(--accent-green)',
                                        }} />
                                      </div>
                                      <span style={{ color: 'var(--accent-green)' }}>{(r.payment_cvr || 0).toFixed(1)}%</span>
                                    </div>
                                  </td>
                                  <td className="py-1.5 px-2 text-right">
                                    <span>{formatTokens(r.total_tokens)}</span>
                                    <span className="text-[9px] ml-1" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(r.total_tokens)}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
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
                          コイン累計額 × 最終応援日の2軸で分類（coin_transactions基準）
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
                          <Accordion id="segment-legend" title="凡例" defaultOpen={true}>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-[10px]">
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.06)' }}>
                                <span className="font-bold w-6">S1</span>
                                <span>Whale現役 — 高額応援＋最近も応援</span>
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
                          </Accordion>
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
                              <th className="text-right px-3 py-2 font-semibold">応援率</th>
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
                      新規応援ユーザーの特定・DM施策の効果測定・チケットチャット初回ユーザー抽出
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
                                  <span style={{ color: 'var(--text-muted)' }}>最終応援: </span>
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
                                      <span className="ml-2" style={{ color: 'var(--text-muted)' }}>— このキャストの応援履歴なし</span>
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
                          { key: 'dm_converted', label: 'DM→応援のみ' },
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
                              DM→応援 {acqSummary.dmSent > 0 && <span className="font-bold">CVR {acqSummary.cvr}%</span>}
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
                                  最終応援 {acqSortKey === 'last_payment_date' && (acqSortAsc ? '↑' : '↓')}
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
                                        <span style={{ color: 'var(--accent-amber)' }}>✅ DM→応援</span>
                                      ) : u.dm_sent ? (
                                        <span style={{ color: 'var(--text-muted)' }}>💌 DM済・未応援</span>
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

              {/* 時間帯別パフォーマンス */}
              <div className="glass-card p-4">
                <h3 className="text-sm font-bold mb-3">⏰ 時間帯別パフォーマンス（直近30日）</h3>
                {hourlyPerfLoading ? (
                  <div className="h-40 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.03)' }} />
                ) : hourlyPerf.length === 0 ? (
                  <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                    配信データがありません（SPYログから自動推定）
                  </p>
                ) : (
                  <>
                    {/* 24時間バーチャート */}
                    {(() => {
                      const maxTph = Math.max(...hourlyPerf.map(h => h.avg_tokens_per_hour || 0), 1);
                      const top3Hours = [...hourlyPerf]
                        .sort((a, b) => (b.avg_tokens_per_hour || 0) - (a.avg_tokens_per_hour || 0))
                        .slice(0, 3)
                        .map(h => h.hour_jst);
                      const allHours = Array.from({ length: 24 }, (_, i) => i);
                      return (
                        <div className="mb-4">
                          <div className="flex items-end gap-[2px]" style={{ height: '120px' }}>
                            {allHours.map(h => {
                              const item = hourlyPerf.find(p => p.hour_jst === h);
                              const tph = item?.avg_tokens_per_hour || 0;
                              const pct = maxTph > 0 ? (tph / maxTph) * 100 : 0;
                              const isTop = top3Hours.includes(h);
                              return (
                                <div key={h} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                                  <div
                                    className="w-full rounded-t transition-all"
                                    style={{
                                      height: `${Math.max(pct, 2)}%`,
                                      background: isTop
                                        ? 'linear-gradient(180deg, rgba(34,197,94,0.8), rgba(34,197,94,0.3))'
                                        : item?.session_count
                                          ? 'linear-gradient(180deg, rgba(56,189,248,0.6), rgba(56,189,248,0.2))'
                                          : 'rgba(255,255,255,0.03)',
                                      minHeight: '2px',
                                    }}
                                  />
                                  <span className="text-[8px] mt-0.5" style={{ color: isTop ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                                    {h}
                                  </span>
                                  {/* ツールチップ */}
                                  {item && item.session_count > 0 && (
                                    <div className="absolute bottom-full mb-1 hidden group-hover:block z-10 glass-panel rounded p-1.5 text-[9px] whitespace-nowrap"
                                      style={{ minWidth: '100px' }}>
                                      <p>{h}時台 (JST)</p>
                                      <p>配信{item.session_count}回 / 平均{item.avg_duration_min}分</p>
                                      <p>時給: {formatTokens(item.avg_tokens_per_hour)} ({tokensToJPY(item.avg_tokens_per_hour)})</p>
                                      <p>平均視聴者: {item.avg_viewers}人</p>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex items-center gap-3 mt-2 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-sm" style={{ background: 'rgba(34,197,94,0.6)' }} /> 推奨時間帯（TOP3）
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-sm" style={{ background: 'rgba(56,189,248,0.4)' }} /> その他
                            </span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* 詳細テーブル */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                            <th className="text-left py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>時間(JST)</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>配信回数</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>平均時間</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>平均視聴者</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>平均売上</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>時給換算</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hourlyPerf
                            .filter(h => h.session_count > 0)
                            .sort((a, b) => a.hour_jst - b.hour_jst)
                            .map(h => {
                              const maxTph = Math.max(...hourlyPerf.map(p => p.avg_tokens_per_hour || 0), 1);
                              const top3 = [...hourlyPerf]
                                .sort((a, b) => (b.avg_tokens_per_hour || 0) - (a.avg_tokens_per_hour || 0))
                                .slice(0, 3)
                                .map(p => p.hour_jst);
                              const isTop = top3.includes(h.hour_jst);
                              return (
                                <tr key={h.hour_jst}
                                  style={{
                                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                                    background: isTop ? 'rgba(34,197,94,0.05)' : undefined,
                                  }}>
                                  <td className="py-1.5 px-2 font-mono">
                                    {isTop && <span className="mr-1">🏆</span>}
                                    {h.hour_jst}:00
                                  </td>
                                  <td className="py-1.5 px-2 text-right">{h.session_count}回</td>
                                  <td className="py-1.5 px-2 text-right">{h.avg_duration_min}分</td>
                                  <td className="py-1.5 px-2 text-right">{h.avg_viewers}人</td>
                                  <td className="py-1.5 px-2 text-right">
                                    {formatTokens(h.avg_tokens)}
                                    <span className="text-[9px] ml-1" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(h.avg_tokens)}</span>
                                  </td>
                                  <td className="py-1.5 px-2 text-right font-bold" style={{ color: isTop ? 'var(--accent-green)' : 'var(--text-primary)' }}>
                                    {formatTokens(h.avg_tokens_per_hour)}/h
                                    <span className="text-[9px] ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(h.avg_tokens_per_hour)}/h</span>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ============ SALES (analytics内に統合) ============ */}
          {activeTab === 'analytics' && (
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
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全応援（コインAPI）</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--text-secondary)' }}>
                        {tokensToJPY(salesLastWeek, coinRate)}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>先週売上</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全応援（コインAPI）</p>
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
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全応援（コインAPI）</p>
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
                          Stripchat Earnings APIからの応援履歴。cast_name絞り込み済み。
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
                              <div className="col-span-3">Campaign</div>
                              <div className="col-span-1 text-right">送信</div>
                              <div className="col-span-1 text-right">来場</div>
                              <div className="col-span-1 text-right">応援</div>
                              <div className="col-span-2 text-right">来場率</div>
                              <div className="col-span-2 text-right">応援率</div>
                              <div className="col-span-2 text-right">収益tk</div>
                            </div>
                            {/* Rows */}
                            {dmCvr.map(row => {
                              const payCvrColor = row.cvr_pct >= 50 ? 'var(--accent-green)'
                                : row.cvr_pct >= 20 ? 'var(--accent-amber)'
                                : 'var(--accent-pink)';
                              const visitCvrColor = (row.visit_cvr_pct || 0) >= 30 ? 'var(--accent-green)'
                                : (row.visit_cvr_pct || 0) >= 10 ? 'var(--accent-amber)'
                                : 'var(--accent-pink)';
                              const visitBarWidth = Math.min(row.visit_cvr_pct || 0, 100);
                              const payBarWidth = Math.min(row.cvr_pct, 100);
                              return (
                                <div key={row.campaign}>
                                  <div
                                    className="glass-panel px-2 py-2 rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={() => setDmCvrExpanded(dmCvrExpanded === row.campaign ? null : row.campaign)}
                                  >
                                    <div className="grid grid-cols-12 gap-2 items-center text-[11px]">
                                      <div className="col-span-3 truncate font-medium">{row.campaign}</div>
                                      <div className="col-span-1 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                                        {row.dm_sent.toLocaleString()}
                                      </div>
                                      <div className="col-span-1 text-right tabular-nums font-bold" style={{ color: visitCvrColor }}>
                                        {(row.visited_after || 0).toLocaleString()}
                                      </div>
                                      <div className="col-span-1 text-right tabular-nums font-bold" style={{ color: payCvrColor }}>
                                        {row.paid_after.toLocaleString()}
                                      </div>
                                      <div className="col-span-2 text-right tabular-nums font-bold" style={{ color: visitCvrColor }}>
                                        {Number(row.visit_cvr_pct || 0).toFixed(1)}%
                                      </div>
                                      <div className="col-span-2 text-right tabular-nums font-bold" style={{ color: payCvrColor }}>
                                        {Number(row.cvr_pct).toFixed(1)}%
                                      </div>
                                      <div className="col-span-2 text-right tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                        {row.total_tokens.toLocaleString()}
                                      </div>
                                    </div>
                                    {/* Dual CVR Bars: 来場(上) + 応援(下) */}
                                    <div className="mt-1.5 space-y-0.5">
                                      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                        <div
                                          className="h-full rounded-full transition-all"
                                          style={{ width: `${visitBarWidth}%`, background: visitCvrColor, opacity: 0.7 }}
                                        />
                                      </div>
                                      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                        <div
                                          className="h-full rounded-full transition-all"
                                          style={{ width: `${payBarWidth}%`, background: payCvrColor }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                  {/* Expanded detail */}
                                  {dmCvrExpanded === row.campaign && (
                                    <div className="mt-1 px-3 py-2 rounded-lg text-[10px] space-y-1" style={{ background: 'rgba(15,23,42,0.4)' }}>
                                      <div className="flex justify-between">
                                        <span style={{ color: 'var(--text-muted)' }}>来場率（チャット出現）</span>
                                        <span style={{ color: visitCvrColor }}>{(row.visited_after || 0).toLocaleString()}/{row.dm_sent.toLocaleString()} = {Number(row.visit_cvr_pct || 0).toFixed(1)}%</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span style={{ color: 'var(--text-muted)' }}>応援率（課金）</span>
                                        <span style={{ color: payCvrColor }}>{row.paid_after.toLocaleString()}/{row.dm_sent.toLocaleString()} = {Number(row.cvr_pct).toFixed(1)}%</span>
                                      </div>
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
                                        <span style={{ color: 'var(--text-muted)' }}>サポーター平均</span>
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

                  {/* ============ セッション別P/L ============ */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      📊 セッション別P/L（損益）
                    </h3>
                    {sessionPLLoading ? (
                      <div className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    ) : sessionPLError ? (
                      <p className="text-xs text-center py-6" style={{ color: 'var(--accent-pink)' }}>
                        P/Lデータの取得に失敗しました — ページを再読み込みしてください
                      </p>
                    ) : sessionPL.length === 0 ? (
                      <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
                        コスト未設定 — 設定タブの「コスト設定」で時給・手数料を入力してください
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                              <th className="text-left py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>日付</th>
                              <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>時間</th>
                              <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>トークン</th>
                              <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>粗売上</th>
                              <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>手数料</th>
                              <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>人件費</th>
                              <th className="text-right py-2 px-1.5 font-bold" style={{ color: 'var(--text-muted)' }}>粗利</th>
                              <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>利益率</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sessionPL.slice(0, 20).map((row, i) => {
                              const isProfit = row.gross_profit_jpy >= 0;
                              return (
                                <tr key={i} style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                  <td className="py-1.5 px-1.5">
                                    {row.started_at ? formatJST(row.started_at).slice(0, 10) : row.session_date}
                                  </td>
                                  <td className="py-1.5 px-1.5 text-right tabular-nums">
                                    {row.duration_minutes > 0 ? `${Math.floor(row.duration_minutes / 60)}h${row.duration_minutes % 60}m` : '—'}
                                  </td>
                                  <td className="py-1.5 px-1.5 text-right tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                    {formatTokens(row.total_tokens)}
                                  </td>
                                  <td className="py-1.5 px-1.5 text-right tabular-nums">
                                    {Math.round(row.gross_revenue_jpy).toLocaleString()}
                                  </td>
                                  <td className="py-1.5 px-1.5 text-right tabular-nums" style={{ color: 'var(--accent-pink)' }}>
                                    -{Math.round(row.platform_fee_jpy).toLocaleString()}
                                  </td>
                                  <td className="py-1.5 px-1.5 text-right tabular-nums" style={{ color: 'var(--accent-pink)' }}>
                                    -{Math.round(row.cast_cost_jpy).toLocaleString()}
                                  </td>
                                  <td className="py-1.5 px-1.5 text-right tabular-nums font-bold"
                                    style={{ color: isProfit ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                                    {isProfit ? '+' : ''}{Math.round(row.gross_profit_jpy).toLocaleString()}
                                  </td>
                                  <td className="py-1.5 px-1.5 text-right tabular-nums"
                                    style={{ color: isProfit ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                                    {row.profit_margin > 0 ? '+' : ''}{row.profit_margin}%
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {sessionPL.length > 20 && (
                          <p className="text-[10px] text-center mt-2" style={{ color: 'var(--text-muted)' }}>
                            直近20件を表示（全{sessionPL.length}件）
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ============ 月次P/L ============ */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      📅 月次P/L
                    </h3>
                    {monthlyPLLoading ? (
                      <div className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    ) : monthlyPLError ? (
                      <p className="text-xs text-center py-6" style={{ color: 'var(--accent-pink)' }}>
                        月次P/Lの取得に失敗しました — ページを再読み込みしてください
                      </p>
                    ) : monthlyPL.length === 0 ? (
                      <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
                        コスト未設定 — 設定タブの「コスト設定」で時給・手数料を入力してください
                      </p>
                    ) : (
                      <>
                        {/* 月次バーチャート */}
                        <div className="flex items-end gap-1 h-32 mb-4 px-2">
                          {(() => {
                            const maxRevenue = Math.max(...monthlyPL.map(m => Math.abs(m.net_revenue_jpy)), 1);
                            return Array.from(monthlyPL).reverse().map((m, i) => {
                              const isProfit = m.gross_profit_jpy >= 0;
                              const barH = Math.max((Math.abs(m.net_revenue_jpy) / maxRevenue) * 100, 4);
                              return (
                                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                  <span className="text-[9px] font-bold tabular-nums"
                                    style={{ color: isProfit ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                                    {Math.round(m.gross_profit_jpy / 1000)}k
                                  </span>
                                  <div className="w-full rounded-t-md transition-all" style={{
                                    height: `${barH}%`,
                                    background: isProfit
                                      ? 'linear-gradient(to top, rgba(34,197,94,0.3), rgba(34,197,94,0.6))'
                                      : 'linear-gradient(to top, rgba(244,63,94,0.3), rgba(244,63,94,0.6))',
                                    border: `1px solid ${isProfit ? 'rgba(34,197,94,0.3)' : 'rgba(244,63,94,0.3)'}`,
                                  }} />
                                  <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                    {m.month.slice(5)}月
                                  </span>
                                </div>
                              );
                            });
                          })()}
                        </div>

                        {/* 月次テーブル */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                <th className="text-left py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>月</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>配信数</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>時間</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>ネット売上</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>人件費</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>固定費</th>
                                <th className="text-right py-2 px-1.5 font-bold" style={{ color: 'var(--text-muted)' }}>粗利</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>利益率</th>
                              </tr>
                            </thead>
                            <tbody>
                              {monthlyPL.map((m, i) => {
                                const isProfit = m.gross_profit_jpy >= 0;
                                return (
                                  <tr key={i} style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                    <td className="py-1.5 px-1.5 font-medium">{m.month}</td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums">{m.total_sessions}</td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums">{m.total_hours}h</td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums">
                                      {Math.round(m.net_revenue_jpy).toLocaleString()}円
                                    </td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums" style={{ color: 'var(--accent-pink)' }}>
                                      -{Math.round(m.total_cast_cost_jpy).toLocaleString()}
                                    </td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums" style={{ color: 'var(--accent-pink)' }}>
                                      {m.monthly_fixed_cost_jpy > 0 ? `-${m.monthly_fixed_cost_jpy.toLocaleString()}` : '—'}
                                    </td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums font-bold"
                                      style={{ color: isProfit ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                                      {isProfit ? '+' : ''}{Math.round(m.gross_profit_jpy).toLocaleString()}円
                                    </td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums"
                                      style={{ color: isProfit ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                                      {m.profit_margin > 0 ? '+' : ''}{m.profit_margin}%
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>

                  {/* ── Revenue Share ── */}
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-bold flex items-center gap-2">
                        <span style={{ color: 'var(--accent-primary)' }}>$</span>
                        レベニューシェア（週次）
                      </h3>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        直近90日 / coin_transactions.tokens / 月曜03:00 JST境界
                      </span>
                    </div>

                    {revenueShareLoading ? (
                      <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    ) : revenueShare.length === 0 ? (
                      <div className="text-center py-6 rounded-xl" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
                        <p className="text-xs" style={{ color: 'var(--accent-amber)' }}>データなし</p>
                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          cast_cost_settings に設定がないか、該当期間の取引がありません
                        </p>
                      </div>
                    ) : (() => {
                      const rsTotals = revenueShare.reduce(
                        (acc, r) => ({
                          tokens: acc.tokens + r.total_tokens,
                          txCount: acc.txCount + r.transaction_count,
                          gross: acc.gross + r.gross_usd,
                          fee: acc.fee + r.platform_fee_usd,
                          net: acc.net + r.net_usd,
                          payment: acc.payment + r.cast_payment_usd,
                        }),
                        { tokens: 0, txCount: 0, gross: 0, fee: 0, net: 0, payment: 0 },
                      );
                      const fmtUsd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                      return (
                        <>
                          {/* Summary cards */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                            <div className="glass-panel p-3 rounded-xl text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>グロス売上</p>
                              <p className="text-lg font-bold font-mono">{fmtUsd(rsTotals.gross)}</p>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                {rsTotals.tokens.toLocaleString()} tk × ${revenueShare[0]?.setting_token_to_usd ?? 0.05}
                              </p>
                            </div>
                            <div className="glass-panel p-3 rounded-xl text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>PF手数料</p>
                              <p className="text-lg font-bold font-mono" style={{ color: 'var(--accent-pink)' }}>-{fmtUsd(rsTotals.fee)}</p>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                {revenueShare[0]?.setting_platform_fee_pct ?? 40}%
                              </p>
                            </div>
                            <div className="glass-panel p-3 rounded-xl text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ネット売上</p>
                              <p className="text-lg font-bold font-mono">{fmtUsd(rsTotals.net)}</p>
                            </div>
                            <div className="glass-panel p-3 rounded-xl text-center" style={{ border: '1px solid rgba(56,189,248,0.15)' }}>
                              <p className="text-[10px]" style={{ color: 'var(--accent-primary)' }}>キャスト支払い</p>
                              <p className="text-xl font-bold font-mono" style={{ color: 'var(--accent-primary)' }}>{fmtUsd(rsTotals.payment)}</p>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                ネット × {revenueShare[0]?.setting_revenue_share_pct ?? 50}%
                              </p>
                            </div>
                          </div>

                          {/* Weekly table */}
                          <div className="overflow-x-auto">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr style={{ color: 'var(--text-muted)' }}>
                                  <th className="text-left pb-2 font-medium">週</th>
                                  <th className="text-right pb-2 font-medium">トークン</th>
                                  <th className="text-right pb-2 font-medium">グロス</th>
                                  <th className="text-right pb-2 font-medium">手数料</th>
                                  <th className="text-right pb-2 font-medium">ネット</th>
                                  <th className="text-right pb-2 font-medium" style={{ color: 'var(--accent-primary)' }}>支払い</th>
                                  <th className="text-center pb-2 font-medium">根拠</th>
                                </tr>
                              </thead>
                              <tbody>
                                {revenueShare.map(r => (
                                  <tr key={r.week_start} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                                    <td className="py-1.5 font-mono">{r.week_label}</td>
                                    <td className="py-1.5 text-right tabular-nums">{r.total_tokens.toLocaleString()}</td>
                                    <td className="py-1.5 text-right tabular-nums font-mono">{fmtUsd(r.gross_usd)}</td>
                                    <td className="py-1.5 text-right tabular-nums font-mono" style={{ color: 'var(--accent-pink)' }}>-{fmtUsd(r.platform_fee_usd)}</td>
                                    <td className="py-1.5 text-right tabular-nums font-mono">{fmtUsd(r.net_usd)}</td>
                                    <td className="py-1.5 text-right tabular-nums font-mono font-bold" style={{ color: 'var(--accent-primary)' }}>{fmtUsd(r.cast_payment_usd)}</td>
                                    <td className="py-1.5 text-center">
                                      <button
                                        className="text-[10px] hover:text-sky-400 transition-colors"
                                        style={{ color: 'var(--text-muted)' }}
                                        onClick={() => setRevenueShareExpanded(revenueShareExpanded === r.week_start ? null : r.week_start)}
                                      >
                                        {revenueShareExpanded === r.week_start ? '閉じる' : '詳細'}
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                                {revenueShareExpanded && (() => {
                                  const r = revenueShare.find(r => r.week_start === revenueShareExpanded);
                                  if (!r) return null;
                                  return (
                                    <tr>
                                      <td colSpan={7} className="p-0">
                                        <div className="p-3 space-y-1.5 text-[10px] font-mono" style={{ background: 'rgba(56,189,248,0.03)', borderTop: '1px solid rgba(56,189,248,0.1)', borderBottom: '1px solid rgba(56,189,248,0.1)' }}>
                                          <p style={{ color: 'var(--text-muted)' }}>
                                            設定: 1tk=${r.setting_token_to_usd} / PF手数料={r.setting_platform_fee_pct}% / 分配率={r.setting_revenue_share_pct}%
                                          </p>
                                          <p>1. グロス: <span style={{ color: 'var(--text-primary)' }}>{r.formula_gross}</span></p>
                                          <p>2. PF手数料: <span style={{ color: 'var(--accent-pink)' }}>{r.formula_fee}</span></p>
                                          <p>3. ネット: <span style={{ color: 'var(--text-primary)' }}>{r.formula_net}</span></p>
                                          <p>4. キャスト支払い: <span style={{ color: 'var(--accent-primary)' }}>{r.formula_payment}</span></p>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })()}
                              </tbody>
                              <tfoot>
                                <tr className="font-bold" style={{ borderTop: '2px solid rgba(56,189,248,0.15)' }}>
                                  <td className="py-2">合計 ({revenueShare.length}週)</td>
                                  <td className="py-2 text-right tabular-nums">{rsTotals.tokens.toLocaleString()}</td>
                                  <td className="py-2 text-right tabular-nums font-mono">{fmtUsd(rsTotals.gross)}</td>
                                  <td className="py-2 text-right tabular-nums font-mono" style={{ color: 'var(--accent-pink)' }}>-{fmtUsd(rsTotals.fee)}</td>
                                  <td className="py-2 text-right tabular-nums font-mono">{fmtUsd(rsTotals.net)}</td>
                                  <td className="py-2 text-right tabular-nums font-mono" style={{ color: 'var(--accent-primary)' }}>{fmtUsd(rsTotals.payment)}</td>
                                  <td />
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ============ REALTIME ============ */}
          {activeTab === 'sessions' && (
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

          {/* ============ SCREENSHOTS — M-6: データ0件のため非表示。SPY基盤安定後に復元 ============ */}

          {/* ============ PERSONA ============ */}
          {activeTab === 'dm' && (
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

          {/* ============ OVERLAP (競合分析) ============ */}
          {activeTab === 'analytics' && (
            <div className="space-y-4">
              {overlapLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  ))}
                </div>
              ) : (
                <>
                  {/* Section 1: データ更新 */}
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold flex items-center gap-2">
                          🔄 プロフィール集計
                        </h3>
                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          spy_messages からユーザー×キャスト別にトークン・出現回数を集計
                        </p>
                        {lastProfileUpdate && (
                          <p className="text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>
                            最終更新: {formatJST(lastProfileUpdate)}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={handleRefreshProfiles}
                        disabled={overlapRefreshing}
                        className="btn-primary text-xs px-4 py-2"
                        style={{ opacity: overlapRefreshing ? 0.5 : 1 }}
                      >
                        {overlapRefreshing ? '集計中...' : '集計を更新'}
                      </button>
                    </div>
                  </div>

                  {/* Section 2: サマリーカード */}
                  {(() => {
                    const totalSpyUsers = new Set(spyTopUsers.map(u => u.user_name)).size;
                    const overlapUserSet = new Set(
                      spyTopUsers.filter(u => u.own_total_coins > 0).map(u => u.user_name)
                    );
                    const overlapRate = totalSpyUsers > 0
                      ? Math.round((overlapUserSet.size / totalSpyUsers) * 100)
                      : 0;
                    const avgSpyTokens = spyTopUsers.length > 0
                      ? Math.round(spyTopUsers.reduce((s, u) => s + u.spy_total_tokens, 0) / spyTopUsers.length)
                      : 0;
                    const prospectCount = spyTopUsers.filter(
                      u => u.own_total_coins === 0 && u.spy_total_tokens >= 100
                    ).length;
                    return (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {[
                          { label: '他社ユーザー数', value: totalSpyUsers.toLocaleString(), icon: '👥' },
                          { label: '自社との重複率', value: `${overlapRate}%`, icon: '🔗' },
                          { label: '平均他社tk', value: formatTokens(avgSpyTokens), icon: '💰' },
                          { label: '獲得候補数', value: prospectCount.toLocaleString(), icon: '🎯' },
                        ].map((card, i) => (
                          <div key={i} className="glass-card p-3 text-center">
                            <p className="text-lg mb-1">{card.icon}</p>
                            <p className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{card.value}</p>
                            <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{card.label}</p>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Section 3: 重複マトリクス */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      📊 ユーザー重複マトリクス
                    </h3>
                    {overlapMatrix.length === 0 ? (
                      <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>
                        データなし — 「集計を更新」を実行してください
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                              <th className="text-left py-2 px-2" style={{ color: 'var(--text-muted)' }}>他社キャスト</th>
                              <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>重複ユーザー</th>
                              <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>重複tk</th>
                              <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>重複率</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overlapMatrix.map((row, i) => {
                              const rate = row.own_total_users > 0
                                ? Math.round((row.overlap_users / row.own_total_users) * 100)
                                : 0;
                              const heatBg = `rgba(56,189,248,${Math.min(rate / 100, 0.4).toFixed(2)})`;
                              return (
                                <tr key={i} style={{ borderBottom: '1px solid var(--border-glass)', background: heatBg }}>
                                  <td className="py-2 px-2 font-medium">{row.spy_cast}</td>
                                  <td className="py-2 px-2 text-right">{row.overlap_users}</td>
                                  <td className="py-2 px-2 text-right" style={{ color: 'var(--accent-amber)' }}>
                                    {formatTokens(row.overlap_tokens)}
                                  </td>
                                  <td className="py-2 px-2 text-right font-bold">{rate}%</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Section 4: ユーザーランキング */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      🏆 他社高額応援ユーザーランキング
                    </h3>
                    {spyTopUsers.length === 0 ? (
                      <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>
                        データなし — 「集計を更新」を実行してください
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                              <th className="text-left py-2 px-2" style={{ color: 'var(--text-muted)' }}>#</th>
                              <th className="text-left py-2 px-2" style={{ color: 'var(--text-muted)' }}>ユーザー</th>
                              <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>他社tk</th>
                              <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>キャスト数</th>
                              <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>自社tk</th>
                              <th className="text-left py-2 px-2" style={{ color: 'var(--text-muted)' }}>セグメント</th>
                            </tr>
                          </thead>
                          <tbody>
                            {spyTopUsers.map((u, i) => {
                              const segBadge: Record<string, { icon: string; color: string }> = {
                                whale: { icon: '🐋', color: 'var(--accent-purple)' },
                                vip: { icon: '👑', color: 'var(--accent-amber)' },
                                regular: { icon: '⭐', color: 'var(--accent-green)' },
                                light: { icon: '💡', color: 'var(--text-secondary)' },
                                new: { icon: '🆕', color: 'var(--accent-primary)' },
                                churned: { icon: '💤', color: 'var(--text-muted)' },
                              };
                              const seg = u.own_segment ? segBadge[u.own_segment] : null;
                              return (
                                <tr key={i} style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                  <td className="py-2 px-2" style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                                  <td className="py-2 px-2">
                                    <a href={`/users/${encodeURIComponent(u.user_name)}`}
                                      className="hover:underline truncate block max-w-[180px]" style={{ color: 'var(--accent-primary)' }}>
                                      {u.user_name}
                                    </a>
                                    <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                      {(u.spy_casts || []).slice(0, 3).join(', ')}{(u.spy_casts || []).length > 3 ? ` +${u.spy_casts.length - 3}` : ''}
                                    </p>
                                  </td>
                                  <td className="py-2 px-2 text-right font-medium" style={{ color: 'var(--accent-amber)' }}>
                                    {formatTokens(u.spy_total_tokens)}
                                  </td>
                                  <td className="py-2 px-2 text-right">{u.cast_count}</td>
                                  <td className="py-2 px-2 text-right">
                                    {u.own_total_coins > 0 ? formatTokens(u.own_total_coins) : (
                                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    )}
                                  </td>
                                  <td className="py-2 px-2">
                                    {seg ? (
                                      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
                                        style={{ background: `${seg.color}20`, color: seg.color }}>
                                        {seg.icon} {u.own_segment}
                                      </span>
                                    ) : (
                                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>未応援</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
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

              {(dmCampaign || dmIsTest) && (
                <div className="glass-panel p-3 rounded-xl" style={dmIsTest ? { borderLeft: '2px solid var(--accent-amber)' } : undefined}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>キャンペーン</p>
                  <p className="text-xs">
                    {dmIsTest && <span style={{ color: 'var(--accent-amber)' }}>test_ </span>}
                    {dmCampaign || '(自動生成)'}
                  </p>
                  {dmIsTest && (
                    <p className="text-[9px] mt-1" style={{ color: 'var(--accent-amber)' }}>テスト送信 — 管理画面から一括削除可能</p>
                  )}
                </div>
              )}

              {/* 送信モード情報 */}
              <div className="glass-panel p-3 rounded-xl">
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>送信モード</p>
                <p className="text-xs font-semibold" style={{ color: dmDeliveryMode === 'fast_text' ? 'var(--accent-primary)' : 'var(--accent-purple)' }}>
                  {dmDeliveryMode === 'fast_text' ? '⚡ 高速テキスト' : `🖼 画像付きパイプライン (${dmTabs}tab)`}
                </p>
                {dmDeliveryMode === 'image_pipeline' && (
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    送信順序: {dmSendOrder === 'text_then_image' ? 'テキスト→画像' : dmSendOrder === 'image_then_text' ? '画像→テキスト' : dmSendOrder === 'image_only' ? '画像のみ' : 'テキストのみ'}
                  </p>
                )}
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  推定所要時間: ~{dmDeliveryMode === 'fast_text'
                    ? `${Math.ceil(dmTargets.size * 2 / 60)}分`
                    : `${Math.ceil(dmTargets.size * 18 / (dmSendMode === 'pipeline' ? dmTabs : 1) / 60)}分`
                  }
                </p>
              </div>

              {dmImagePreview && (
                <div className="glass-panel p-3 rounded-xl">
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>添付画像</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={dmImagePreview} alt="DM添付画像" className="w-16 h-16 rounded-lg object-cover" />
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

      {/* DM安全ゲート: 送信先プレビューモーダル */}
      {dmShowPreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="glass-card p-6 rounded-2xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col" style={{ border: '1px solid rgba(56,189,248,0.2)' }}>
            <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--accent-primary)' }}>
              送信先リスト確認（必須）
            </h3>

            {isDmTestMode() && (
              <div className="mb-3 p-2 rounded-lg text-[10px]" style={{ background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--accent-amber)' }}>
                DM_TEST_MODE: ON — ホワイトリスト以外への送信は自動ブロックされます
              </div>
            )}

            <div className="mb-3 grid grid-cols-2 gap-2 text-[10px]">
              <div className="glass-panel p-2 rounded-lg">
                <span style={{ color: 'var(--text-muted)' }}>送信先</span>
                <p className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{dmTargets.size}名</p>
              </div>
              <div className="glass-panel p-2 rounded-lg">
                <span style={{ color: 'var(--text-muted)' }}>キャンペーン</span>
                <p className="font-bold text-sm truncate" style={{ color: 'var(--accent-primary)' }}>{dmCampaign || '(未設定)'}</p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto mb-3 glass-panel rounded-lg p-2" style={{ maxHeight: '300px' }}>
              <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>送信対象ユーザー:</p>
              <div className="flex flex-wrap gap-1">
                {Array.from(dmTargets).map(u => (
                  <span key={u} className="text-[10px] px-2 py-0.5 rounded-full" style={{
                    background: DM_TEST_WHITELIST.has(u) ? 'rgba(34,197,94,0.15)' : 'rgba(15,23,42,0.6)',
                    border: `1px solid ${DM_TEST_WHITELIST.has(u) ? 'rgba(34,197,94,0.3)' : 'var(--border-glass)'}`,
                    color: DM_TEST_WHITELIST.has(u) ? 'var(--accent-green)' : 'var(--text-secondary)',
                  }}>
                    {u}{DM_TEST_WHITELIST.has(u) && ' (WL)'}
                  </span>
                ))}
              </div>
            </div>

            <div className="mb-3 glass-panel rounded-lg p-2">
              <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>メッセージ:</p>
              <p className="text-[11px] whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                {dmMessage.length > 200 ? dmMessage.slice(0, 200) + '...' : dmMessage}
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => { setDmShowPreview(false); setDmPreviewConfirmed(false); }}
                className="btn-ghost text-xs py-2 px-4 flex-1">
                キャンセル
              </button>
              <button
                onClick={() => {
                  setDmPreviewConfirmed(true);
                  setDmShowPreview(false);
                  setTimeout(() => handleDmSend(), 100);
                }}
                className="text-xs py-2 px-4 flex-1 rounded-xl font-semibold"
                style={{ background: 'linear-gradient(135deg, var(--accent-primary), #0284c7)', color: 'white' }}>
                {dmTargets.size}名への送信を確認
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
