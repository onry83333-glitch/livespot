// -*- coding: utf-8 -*-
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';
import { formatTokens, tokensToJPY, formatJST } from '@/lib/utils';
import Link from 'next/link';
import { queueDmBatch } from '@/lib/dm-sender';
import { checkAndEnroll } from '@/lib/scenario-engine';

/* ============================================================
   Types
   ============================================================ */
interface SessionSummary {
  // v2 broadcast group fields (v1 fallback: session_id mapped to broadcast_group_id)
  broadcast_group_id: string;
  session_ids: string[];
  cast_name: string;
  session_title: string | null;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  msg_count: number;
  unique_users: number;
  chat_tokens: number;
  tip_count: number;
  tokens_by_type: Record<string, number>;
  top_chatters: { user_name: string; tokens: number; tip_count: number }[];
  // Coin data (0 when v1 fallback)
  coin_tokens: number;
  coin_by_type: Record<string, number>;
  coin_top_users: { user_name: string; tokens: number; types: string[]; is_new: boolean }[];
  coin_new_users: number;
  coin_returning_users: number;
  total_revenue: number;
  // Comparison
  prev_broadcast_group_id: string | null;
  prev_total_revenue: number | null;
  prev_started_at: string | null;
  change_pct: number | null;
}

interface SessionActions {
  first_time_payers: { user_name: string; session_tokens: number; dm_sent: boolean }[];
  high_spenders: { user_name: string; session_tokens: number }[];
  visited_no_action: { user_name: string; segment: string }[];
  dm_no_visit: { user_name: string; segment: string; dm_sent_at: string }[];
  segment_breakdown: { segment: string; dm_sent: number; visited: number; paid: number }[];
}

interface DmTemplate {
  id: string;
  name: string;
  message: string;
}

interface LiveMessage {
  id: number;
  message_time: string;
  msg_type: string;
  user_name: string | null;
  message: string | null;
  tokens: number;
  user_color: string | null;
  is_vip: boolean;
}

interface LiveViewer {
  user_name: string;
  segment: string | null;
  lifetime_tokens: number;
  first_seen: string;
  is_new_payer: boolean;
}

interface DmVisitBanner {
  id: string;
  user_name: string;
  segment: string | null;
  dm_sent_at: string;
}

interface CastTranscript {
  id: string;
  session_id: string | null;
  cast_name: string;
  segment_start_seconds: number | null;
  segment_end_seconds: number | null;
  text: string;
  language: string;
  confidence: number | null;
  source_file: string | null;
  processing_status: 'pending' | 'processing' | 'completed' | 'failed';
  error_message: string | null;
  created_at: string;
}

interface TimelineEvent {
  event_time: string;
  event_type: 'transcript' | 'chat' | 'tip' | 'enter' | 'leave' | 'coin';
  user_name: string | null;
  message: string | null;
  tokens: number;
  coin_type: string | null;
  confidence: number | null;
  elapsed_sec: number;
  is_highlight: boolean;
}

type BroadcastMode = 'pre' | 'live' | 'post';

/* ============================================================
   Labels
   ============================================================ */
const LABELS = {
  min: '分',
  hours: '時間',
  sessionDetail: 'セッション詳細',
  backToList: 'セッション一覧',
  preBroadcast: '配信前',
  duringBroadcast: '配信中',
  postBroadcast: '配信後',
  developing: '開発中',
  loading: '読み込み中...',
  checkConsole: 'ブラウザの開発者コンソールを確認してください',
  sessionNotFound: 'セッションが見つかりません',
  prevCompare: '前回比',
  sales: '売上',
  tipCount: 'チップ数',
  users: 'ユーザー',
  messages: 'メッセージ',
  salesBreakdown: '売上内訳（msg_type別）',
  topUsers: 'トップユーザー',
  prevComparison: '前回セッション比較',
  prevSales: '前回売上',
  currentSales: '今回売上',
  changeRate: '変化率',
  analyzingActions: 'アクション分析中...',
  actionHeader: '今すぐやること',
  firstTimePayers: '初課金ユーザーへお礼DM',
  highSpenders: '高額課金ユーザーへ特別DM',
  visitedNoAction: '来訪したがアクションなし',
  dmNoVisit: 'DM送信→未来訪',
  sendTemplate: 'テンプレートで一括送信',
  createDm: '個別DM作成',
  followDm: 'フォローDMを送る',
  notImplemented: '次フェーズで実装予定',
  noData: '該当なし',
  dmSentBadge: '送信済み',
  personSuffix: '人',
  reviewDmTarget: '次回のDMターゲット見直しを検討',
  showFormulaTitle: '計算式を表示',
  segmentBreakdown: 'セグメント別ブレイクダウン',
  segment: 'セグメント',
  dmSentCol: 'DM送信',
  visited: '来訪',
  paid: '課金',
  total: '合計',
  // Pre-broadcast labels
  preBroadcastPrep: '配信準備',
  prevBroadcast: '前回配信',
  prevAttendance: '前回来場',
  prevNewUsers: '前回新規',
  preDm: '配信前DM',
  segmentSelect: 'セグメント選択',
  sendTarget: '送信対象',
  templateSelect: 'テンプレート選択',
  preview: 'プレビュー',
  bulkSend: '一括送信',
  byafLabel: 'BYAF文末（自動付与）',
  byafText: '来てくれたら嬉しいけど、無理しないでね！',
  defaultTemplateText: '今日21時から配信するよ！\n楽しみに待っててね💕',
  prevResult: '前回の結果',
  attendance: '来場',
  newPayers: '新規課金',
  unhandledAlert: '初課金{n}人にお礼DM未送信',
  goToPostMode: '配信後モードへ',
  dataNotAvailable: 'データなし',
  loadingPreData: '配信準備データを読み込み中...',
  unhandledLabel: '未対応',
  thanksDmUnsent: 'お礼DM未送信',
  // Live mode labels
  liveStatus: 'LIVE',
  broadcasting: '配信中',
  viewerCount: 'チャット参加',
  revenueLabel: 'チャット売上（チップ）',
  newUsersLabel: '新規',
  viewerPanel: 'チャット参加者',
  dmManagePage: 'DM管理画面へ',
  chatFeed: 'チャット',
  statsPanel: 'リアルタイム集計',
  revenueTrend: '売上推移',
  revenueBreakdownLive: '売上内訳',
  payingUsersLabel: '課金ユーザー',
  firstTimeLive: '初課金',
  avgPaymentLabel: '平均課金額',
  perPerson: '/人',
  entered: '入室しました',
  left: '退室しました',
  minutesAgo: '分前',
  justNow: 'たったいま',
  firstVisit: '初来訪',
  lifetimeLabel: '累計',
  dmVisitDetected: 'DM来訪',
  dmSentTimeAgo: 'DM送信',
  hoursAgo: '時間前',
  realtimeActive: 'Realtime接続中',
  pollingMode: 'ポーリングモード',
  noMessagesYet: 'メッセージなし',
  liveDataPast: '過去データ表示中',
  whisperLabel: 'ささやき',
  recordingSection: '配信録画',
  uploadRecording: 'ファイルを選択またはドラッグ&ドロップ',
  uploadHint: 'MP4 / WebM / MKV（最大2GB）',
  selectedFile: '選択済み',
  startTranscription: '文字起こし開始',
  noRecordingHint: '配信録画ファイルをアップロードすると、自動で文字起こしされます',
  processingTranscript: '文字起こし中...',
  nextPhase: '次フェーズで実装予定',
  recordingStartLabel: '録画開始時刻（任意）',
  recordingStartHint: '入力するとチャットログと突合できます',
  fileTooLarge: 'Whisper APIの上限は25MBです。音声ファイル（mp3/m4a/wav）に変換してアップロードしてください',
  transcribing: '文字起こし処理中...',
  transcribeComplete: '文字起こし完了',
  transcribeFailed: '文字起こし失敗',
  // Timeline labels
  timelineTitle: '時刻突合タイムライン',
  timelineDesc: '文字起こし・チャット・課金を時刻順に統合',
  timelineLoading: 'タイムラインを読み込み中...',
  timelineEmpty: '文字起こしデータがないためタイムラインを表示できません',
  timelineHighlight: '課金30秒以内の発言',
  filterAll: 'すべて',
  filterTranscript: '発言',
  filterPayment: '課金',
  filterChat: 'チャット',
} as const;

const COIN_RATE = 7.7;

const SEGMENT_GROUPS = [
  { id: 'whale_vip', label: 'Whale/VIP', segments: ['whale', 'vip'], defaultOn: true },
  { id: 'regular', label: 'Regular', segments: ['regular'], defaultOn: true },
  { id: 'light', label: 'Light', segments: ['light'], defaultOn: false },
  { id: 'churned', label: 'Churned', segments: ['churned'], defaultOn: false },
  { id: 'new', label: 'New', segments: ['new'], defaultOn: false },
] as const;

/* ============================================================
   Helpers
   ============================================================ */
function formatDuration(minutes: number): string {
  if (!minutes || minutes < 0) return `0${LABELS.min}`;
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}${LABELS.min}`;
  return `${h}${LABELS.hours}${rem > 0 ? `${rem}${LABELS.min}` : ''}`;
}

function formatDateCompact(dateStr: string): string {
  const d = new Date(dateStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const mm = jst.getUTCMonth() + 1;
  const dd = jst.getUTCDate();
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mi = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function groupBySegmentRange(items: { segment: string }[]): { label: string; count: number }[] {
  const ranges = [
    { label: 'S1-S3', segments: ['S1', 'S2', 'S3'] },
    { label: 'S4-S6', segments: ['S4', 'S5', 'S6'] },
    { label: 'S7-S9', segments: ['S7', 'S8', 'S9'] },
    { label: 'S10', segments: ['S10'] },
  ];
  return ranges.map(r => ({
    label: r.label,
    count: items.filter(i => r.segments.includes(i.segment)).length,
  })).filter(r => r.count > 0);
}

function timeAgoText(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return LABELS.justNow;
  if (mins < 60) return `${mins}${LABELS.minutesAgo}`;
  const hours = Math.floor(mins / 60);
  return `${hours}${LABELS.hoursAgo}`;
}

function getSegmentEmoji(segment: string | null): string {
  switch (segment) {
    case 'whale': return '\u{1F535}';
    case 'vip': return '\u{1F7E2}';
    case 'regular': return '\u{1F7E1}';
    case 'light': return '\u26AA';
    case 'churned': return '\u{1F53B}';
    default: return '\u2B50';
  }
}

function getSegmentLabel(segment: string | null): string {
  switch (segment) {
    case 'whale': return 'Whale';
    case 'vip': return 'VIP';
    case 'regular': return 'Regular';
    case 'light': return 'Light';
    case 'churned': return 'Churned';
    default: return 'New';
  }
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getMsgStyle(msgType: string, tokens: number): { bg: string; color: string; italic?: boolean; small?: boolean } {
  if (tokens > 0) return { bg: 'rgba(245,158,11,0.12)', color: 'rgb(251,191,36)' };
  switch (msgType) {
    case 'enter': return { bg: 'transparent', color: 'var(--text-muted)', small: true };
    case 'leave': return { bg: 'transparent', color: 'var(--text-muted)', small: true };
    case 'system': return { bg: 'transparent', color: 'var(--text-muted)', italic: true };
    case 'whisper': return { bg: 'rgba(167,139,250,0.08)', color: 'rgb(167,139,250)' };
    default: return { bg: 'transparent', color: 'var(--text-secondary)' };
  }
}

/* ============================================================
   Component
   ============================================================ */
export default function SessionDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const castName = decodeURIComponent(params.castName as string);
  const sessionId = decodeURIComponent(params.sessionId as string);
  const urlMode = searchParams.get('mode') as BroadcastMode | null;

  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<BroadcastMode | null>(urlMode === 'pre' ? 'pre' : urlMode === 'live' ? 'live' : null);
  const [actions, setActions] = useState<SessionActions | null>(null);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showFormula, setShowFormula] = useState<string | null>(null);

  // Pre-broadcast state
  const [segmentCounts, setSegmentCounts] = useState<Map<string, number>>(new Map());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(
    new Set(SEGMENT_GROUPS.filter(g => g.defaultOn).map(g => g.id))
  );
  const [templates, setTemplates] = useState<DmTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [dmText, setDmText] = useState<string>(LABELS.defaultTemplateText);
  const [preLoading, setPreLoading] = useState(false);

  // Live mode state
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);
  const [liveViewers, setLiveViewers] = useState<LiveViewer[]>([]);
  const [liveTotalTokens, setLiveTotalTokens] = useState(0);
  const [livePayingCount, setLivePayingCount] = useState(0);
  const [liveNewPayerCount, setLiveNewPayerCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [dmVisitBanners, setDmVisitBanners] = useState<DmVisitBanner[]>([]);
  const [mobileTab, setMobileTab] = useState<'chat' | 'viewers' | 'stats'>('chat');
  const [messageLimitHit, setMessageLimitHit] = useState(false);
  const [liveRevenueByType, setLiveRevenueByType] = useState<Record<string, number>>({});
  const [liveLoading, setLiveLoading] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const lastMessageTimeRef = useRef<string | null>(null);
  const dmSentUsersRef = useRef<Map<string, { sent_at: string; segment: string | null }>>(new Map());
  const sessionPayersRef = useRef<Set<string>>(new Set());

  // Recording / Transcript state
  const [transcripts, setTranscripts] = useState<CastTranscript[]>([]);
  const [transcriptsLoading, setTranscriptsLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Screenshot state
  const [screenshotting, setScreenshotting] = useState(false);
  const [screenshots, setScreenshots] = useState<{ id: string; image_url: string; captured_at: string }[]>([]);
  const [screenshotModalUrl, setScreenshotModalUrl] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);

  // DM sending state
  const [dmSending, setDmSending] = useState(false);
  const [dmSentCampaign, setDmSentCampaign] = useState<string | null>(null);

  // DM confirmation modal state
  const [dmConfirm, setDmConfirm] = useState<{
    title: string;
    users: { user_name: string; detail: string }[];
    message: string;
    onConfirm: (selectedUsers: string[]) => Promise<void>;
  } | null>(null);
  const [dmConfirmExcluded, setDmConfirmExcluded] = useState<Set<string>>(new Set());

  // User DM history (inline expand)
  const [expandedDmUser, setExpandedDmUser] = useState<string | null>(null);
  const [userDmHistory, setUserDmHistory] = useState<{ message: string; status: string; campaign: string | null; sent_at: string | null; queued_at: string }[]>([]);
  const [userDmLoading, setUserDmLoading] = useState(false);

  // AI Analysis state
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<{
    summary: {
      total_events: number;
      transcript_segments: number;
      total_tips: number;
      total_tickets: number;
      total_privates: number;
      total_groups: number;
      total_enters: number;
      total_chats: number;
      total_tokens: number;
      tip_tokens: number;
      ticket_tokens: number;
      private_tokens: number;
      group_tokens: number;
    };
    triggers: { transcript_text: string; time: string; tokens_after: number; users_who_paid: string[] }[];
    phases: { start: string; end: string; type: string; events: number; tokens: number }[];
    feedback: string[];
  } | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Timeline state
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineFilter, setTimelineFilter] = useState<'all' | 'transcript' | 'payment' | 'chat'>('all');
  const [timelineOpen, setTimelineOpen] = useState(false);

  // Market analysis state (pre-broadcast)
  const [marketNow, setMarketNow] = useState<{
    current_hour: number;
    active_casts: number;
    avg_viewers_now: number;
    best_cast: string | null;
    best_viewers: number | null;
    own_avg_viewers: number | null;
  } | null>(null);
  const [viewerTrends, setViewerTrends] = useState<{
    cast_name: string;
    hour_of_day: number;
    avg_viewers: number;
    max_viewers: number;
    broadcast_count: number;
  }[]>([]);
  const [revenueTypes, setRevenueTypes] = useState<{
    cast_name: string;
    tip_count: number;
    ticket_count: number;
    group_count: number;
    total_tokens: number;
    broadcast_days: number;
  }[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);

  // Computed: total send targets
  const sendTargetCount = SEGMENT_GROUPS
    .filter(g => selectedGroups.has(g.id))
    .reduce((sum, g) => sum + g.segments.reduce((s, seg) => s + (segmentCounts.get(seg) || 0), 0), 0);

  const selectedTemplateMsg = selectedTemplateId
    ? templates.find(t => t.id === selectedTemplateId)?.message || ''
    : LABELS.defaultTemplateText;

  // Unhandled count (first_time_payers with dm_sent=false)
  const unhandledCount = actions
    ? actions.first_time_payers.filter(u => !u.dm_sent).length
    : 0;

  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  // Helper: v1 RPC結果をv2形式に変換
  const mapV1toV2 = (row: any): SessionSummary => {
    let topUsers = row.top_users || [];
    if (typeof topUsers === 'string') { try { topUsers = JSON.parse(topUsers); } catch { topUsers = []; } }
    let tokensByType = row.tokens_by_type || {};
    if (typeof tokensByType === 'string') { try { tokensByType = JSON.parse(tokensByType); } catch { tokensByType = {}; } }
    return {
      broadcast_group_id: row.session_id,
      session_ids: [row.session_id],
      cast_name: row.cast_name,
      session_title: row.session_title,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_minutes: row.duration_minutes,
      msg_count: row.msg_count,
      unique_users: row.unique_users,
      chat_tokens: row.total_tokens ?? 0,
      tip_count: row.tip_count,
      tokens_by_type: tokensByType,
      top_chatters: topUsers,
      coin_tokens: 0, coin_by_type: {}, coin_top_users: [],
      coin_new_users: 0, coin_returning_users: 0,
      total_revenue: row.total_tokens ?? 0,
      prev_broadcast_group_id: row.prev_session_id ?? null,
      prev_total_revenue: row.prev_total_tokens ?? null,
      prev_started_at: row.prev_started_at ?? null,
      change_pct: row.change_pct ?? null,
    };
  };

  // Helper: v2 RPC結果のJSONBフィールドをパース
  const parseV2Row = (row: any): SessionSummary => {
    let topChatters = row.top_chatters || [];
    if (typeof topChatters === 'string') { try { topChatters = JSON.parse(topChatters); } catch { topChatters = []; } }
    let tokensByType = row.tokens_by_type || {};
    if (typeof tokensByType === 'string') { try { tokensByType = JSON.parse(tokensByType); } catch { tokensByType = {}; } }
    let coinByType = row.coin_by_type || {};
    if (typeof coinByType === 'string') { try { coinByType = JSON.parse(coinByType); } catch { coinByType = {}; } }
    let coinTopUsers = row.coin_top_users || [];
    if (typeof coinTopUsers === 'string') { try { coinTopUsers = JSON.parse(coinTopUsers); } catch { coinTopUsers = []; } }
    return {
      broadcast_group_id: row.broadcast_group_id,
      session_ids: row.session_ids || [row.broadcast_group_id],
      cast_name: row.cast_name,
      session_title: row.session_title,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_minutes: row.duration_minutes,
      msg_count: row.msg_count,
      unique_users: row.unique_users,
      chat_tokens: row.chat_tokens ?? 0,
      tip_count: row.tip_count,
      tokens_by_type: tokensByType,
      top_chatters: topChatters,
      coin_tokens: row.coin_tokens ?? 0,
      coin_by_type: coinByType,
      coin_top_users: coinTopUsers,
      coin_new_users: row.coin_new_users ?? 0,
      coin_returning_users: row.coin_returning_users ?? 0,
      total_revenue: row.total_revenue ?? row.chat_tokens ?? 0,
      prev_broadcast_group_id: row.prev_broadcast_group_id ?? null,
      prev_total_revenue: row.prev_total_revenue ?? null,
      prev_started_at: row.prev_started_at ?? null,
      change_pct: row.change_pct ?? null,
    };
  };

  // Load session summary (v2 → v1 → fallback)
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    setError(null);

    (async () => {
      // Try v2 first
      const { data: v2data, error: v2err } = await sb.rpc('get_session_summary_v2', {
        p_account_id: accountId,
        p_session_id: sessionId,
      });
      if (!v2err) {
        const rows = Array.isArray(v2data) ? v2data : v2data ? [v2data] : [];
        if (rows.length > 0) {
          setSummary(parseV2Row(rows[0]));
          setLoading(false);
          return;
        }
      }
      console.warn('[Session] v2 RPC failed or empty, trying v1:', v2err?.message);

      // Try v1
      const { data: v1data, error: v1err } = await sb.rpc('get_session_summary', {
        p_account_id: accountId,
        p_session_id: sessionId,
      });
      if (!v1err) {
        const rows = Array.isArray(v1data) ? v1data : v1data ? [v1data] : [];
        if (rows.length > 0) {
          setSummary(mapV1toV2(rows[0]));
          setLoading(false);
          return;
        }
      }
      console.warn('[Session] v1 RPC also failed, using fallback:', v1err?.message);
      await loadFallback();
    })();
  }, [accountId, sessionId, sb]);

  const loadFallback = async () => {
    const { data: msgs } = await sb
      .from('spy_messages')
      .select('session_id, cast_name, session_title, message_time, user_name, tokens, msg_type')
      .eq('account_id', accountId!)
      .eq('session_id', sessionId)
      .order('message_time', { ascending: true });

    if (!msgs || msgs.length === 0) {
      setError(`${LABELS.sessionNotFound} (session_id: ${sessionId.slice(0, 8)}...)`);
      setLoading(false);
      return;
    }

    const times = msgs.map(m => new Date(m.message_time).getTime());
    const users = new Set(msgs.filter(m => m.user_name).map(m => m.user_name));
    const totalTk = msgs.reduce((s, m) => s + (m.tokens > 0 ? m.tokens : 0), 0);
    const tips = msgs.filter(m => m.tokens > 0);
    const typeMap: Record<string, number> = {};
    for (const m of msgs) {
      if (m.tokens > 0 && m.msg_type) typeMap[m.msg_type] = (typeMap[m.msg_type] || 0) + m.tokens;
    }
    const userMap = new Map<string, { tokens: number; count: number }>();
    for (const m of tips) {
      if (!m.user_name) continue;
      const u = userMap.get(m.user_name) || { tokens: 0, count: 0 };
      u.tokens += m.tokens;
      u.count += 1;
      userMap.set(m.user_name, u);
    }
    const top5 = Array.from(userMap.entries())
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 5)
      .map(([name, v]) => ({ user_name: name, tokens: v.tokens, tip_count: v.count }));

    setSummary({
      broadcast_group_id: sessionId, session_ids: [sessionId],
      cast_name: msgs[0].cast_name, session_title: msgs[0].session_title,
      started_at: new Date(Math.min(...times)).toISOString(), ended_at: new Date(Math.max(...times)).toISOString(),
      duration_minutes: Math.round((Math.max(...times) - Math.min(...times)) / 60000),
      msg_count: msgs.length, unique_users: users.size, chat_tokens: totalTk, tip_count: tips.length,
      tokens_by_type: typeMap, top_chatters: top5,
      coin_tokens: 0, coin_by_type: {}, coin_top_users: [],
      coin_new_users: 0, coin_returning_users: 0,
      total_revenue: totalTk,
      prev_broadcast_group_id: null, prev_total_revenue: null, prev_started_at: null, change_pct: null,
    });
    setLoading(false);
  };

  // Auto-detect mode (respect URL param)
  useEffect(() => {
    if (urlMode === 'pre') { setMode('pre'); return; }
    if (urlMode === 'live') { setMode('live'); return; }
    if (!summary) return;
    const endedAt = new Date(summary.ended_at).getTime();
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    setMode(endedAt < tenMinAgo ? 'post' : 'live');
  }, [summary, urlMode]);

  // Resolved mode (fallback to 'post' while auto-detecting)
  const resolvedMode: BroadcastMode = mode ?? 'post';

  // Load actions for post AND pre modes
  const loadActions = useCallback(async () => {
    if (!accountId || resolvedMode === 'live') return;
    setActionsLoading(true);
    const { data, error: actErr } = await sb.rpc('get_session_actions', {
      p_account_id: accountId,
      p_session_id: sessionId,
    });
    if (actErr) {
      console.warn('[Session] get_session_actions RPC error:', actErr.message);
      setActionsLoading(false);
      return;
    }
    const result = Array.isArray(data) ? data[0] : data;
    if (result) setActions(result as SessionActions);
    setActionsLoading(false);
  }, [accountId, sessionId, resolvedMode, sb]);

  useEffect(() => { loadActions(); }, [loadActions]);

  // Load model_id from registered_casts
  useEffect(() => {
    if (!accountId) return;
    sb.from('registered_casts')
      .select('stripchat_model_id')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .maybeSingle()
      .then(({ data }) => { if (data?.stripchat_model_id) setModelId(data.stripchat_model_id); });
  }, [accountId, castName, sb]);

  // Load screenshots for this session (post mode)
  const loadScreenshots = useCallback(async () => {
    if (!accountId) return;
    const { data } = await sb.from('cast_screenshots')
      .select('id, image_url, captured_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .eq('session_id', sessionId)
      .order('captured_at', { ascending: true });
    if (data) setScreenshots(data);
  }, [accountId, castName, sessionId, sb]);

  useEffect(() => {
    if (resolvedMode === 'post' && accountId) loadScreenshots();
  }, [resolvedMode, accountId, loadScreenshots]);

  // Capture screenshot
  const handleScreenshot = useCallback(async () => {
    if (!accountId || !modelId || screenshotting) return;
    setScreenshotting(true);
    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch('/api/screenshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          model_id: modelId,
          cast_name: castName,
          account_id: accountId,
          session_id: sessionId,
          thumbnail_type: 'manual',
        }),
      });
      if (res.ok) {
        const result = await res.json();
        setToast('スクリーンショットを保存しました');
        setScreenshots(prev => [...prev, { id: result.screenshot.id, image_url: result.image_url, captured_at: result.screenshot.captured_at }]);
      } else {
        setToast('スクリーンショットの取得に失敗しました');
      }
    } catch {
      setToast('スクリーンショットの取得に失敗しました');
    }
    setScreenshotting(false);
  }, [accountId, modelId, screenshotting, castName, sessionId, sb]);

  // Load pre-broadcast data (segments + templates)
  useEffect(() => {
    if (resolvedMode !== 'pre' || !accountId) return;
    const loadPreData = async () => {
      setPreLoading(true);
      // Load segment counts
      const { data: segData } = await sb
        .from('paid_users')
        .select('segment')
        .eq('account_id', accountId)
        .eq('cast_name', castName);
      if (segData) {
        const counts = new Map<string, number>();
        segData.forEach(r => {
          const s = r.segment || 'unknown';
          counts.set(s, (counts.get(s) || 0) + 1);
        });
        setSegmentCounts(counts);
      }
      // Load templates
      const { data: tplData } = await sb
        .from('dm_templates')
        .select('id, name, message')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false });
      if (tplData && tplData.length > 0) {
        setTemplates(tplData);
        if (!selectedTemplateId) setSelectedTemplateId(tplData[0].id);
      }
      // Load market data (spy competitor analysis)
      setMarketLoading(true);
      const [marketRes, trendsRes, revRes] = await Promise.all([
        sb.rpc('get_spy_market_now', { p_account_id: accountId, p_days: 7 }),
        sb.rpc('get_spy_viewer_trends', { p_account_id: accountId, p_days: 7 }),
        sb.rpc('get_spy_revenue_types', { p_account_id: accountId, p_days: 7 }),
      ]);
      if (marketRes.data && marketRes.data.length > 0) {
        setMarketNow(marketRes.data[0]);
      }
      if (trendsRes.data) setViewerTrends(trendsRes.data);
      if (revRes.data) setRevenueTypes(revRes.data);
      setMarketLoading(false);
      setPreLoading(false);
    };
    loadPreData();
  }, [resolvedMode, accountId, sb]);

  // Toast auto-clear
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Load transcripts for this session
  const loadTranscripts = useCallback(async () => {
    if (!accountId) return;
    setTranscriptsLoading(true);
    const { data, error: err } = await sb.from('cast_transcripts')
      .select('id, session_id, cast_name, segment_start_seconds, segment_end_seconds, text, language, confidence, source_file, processing_status, error_message, created_at')
      .eq('account_id', accountId)
      .eq('session_id', sessionId)
      .order('segment_start_seconds', { ascending: true, nullsFirst: false });
    if (!err && data) setTranscripts(data as CastTranscript[]);
    setTranscriptsLoading(false);
  }, [accountId, sessionId, sb]);

  useEffect(() => {
    if (resolvedMode === 'post') loadTranscripts();
  }, [resolvedMode, loadTranscripts]);

  // Load timeline (transcript + chat + coin correlation)
  const loadTimeline = useCallback(async () => {
    if (!accountId) return;
    setTimelineLoading(true);
    try {
      const { data, error: err } = await sb.rpc('get_transcript_timeline', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_session_id: sessionId,
      });
      if (!err && data) setTimeline(data as TimelineEvent[]);
    } catch {
      /* ignore */
    }
    setTimelineLoading(false);
  }, [accountId, castName, sessionId, sb]);

  // AI Analysis handler
  const handleAnalyze = useCallback(async () => {
    if (!accountId || analyzing) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisResult(null);
    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch('/api/analyze-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ session_id: sessionId, cast_name: castName, account_id: accountId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '分析に失敗しました');
      setAnalysisResult(json.analysis);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '分析に失敗しました';
      setAnalysisError(msg);
    } finally {
      setAnalyzing(false);
    }
  }, [accountId, sessionId, castName, analyzing, sb]);

  // Load DM history for a specific user (inline expand)
  const loadUserDmHistory = useCallback(async (userName: string) => {
    if (!accountId) return;
    if (expandedDmUser === userName) { setExpandedDmUser(null); return; }
    setExpandedDmUser(userName);
    setUserDmLoading(true);
    const { data } = await sb.from('dm_send_log')
      .select('message, status, campaign, sent_at, queued_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .eq('user_name', userName)
      .order('created_at', { ascending: false })
      .limit(5);
    setUserDmHistory(data || []);
    setUserDmLoading(false);
  }, [accountId, castName, sb, expandedDmUser]);

  // Pre-broadcast: bulk DM send (Step 1: show confirmation)
  const handlePreBroadcastDm = useCallback(async () => {
    if (!accountId || dmSending) return;
    const selectedSegments = SEGMENT_GROUPS
      .filter(g => selectedGroups.has(g.id))
      .flatMap(g => [...g.segments] as string[]);
    if (selectedSegments.length === 0 || sendTargetCount === 0) {
      setToast('送信対象のセグメントを選択してください');
      return;
    }
    const msg = dmText.trim() + '\n' + LABELS.byafText;

    // Fetch users for confirmation list
    const { data: users } = await sb
      .from('paid_users')
      .select('user_name, segment')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('segment', selectedSegments);
    if (!users || users.length === 0) {
      setToast('対象ユーザーが見つかりませんでした');
      return;
    }

    setDmConfirmExcluded(new Set());
    setDmConfirm({
      title: '配信前DM送信',
      users: users.map(u => ({ user_name: u.user_name, detail: u.segment || '' })),
      message: msg,
      onConfirm: async (selectedUsers: string[]) => {
        setDmSending(true);
        try {
          const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
          const campaign = `pre_broadcast_${sessionId.slice(0, 8)}_${ts}`;
          const targets = selectedUsers.map(u => ({ username: u, message: msg }));
          const result = await queueDmBatch(sb, accountId, castName, targets, campaign);
          setDmSentCampaign(campaign);
          setToast(`${result.queued}件のDMをキューに登録しました`);
        } catch (e: unknown) {
          setToast(e instanceof Error ? e.message : '送信エラー');
        }
        setDmSending(false);
        setDmConfirm(null);
      },
    });
  }, [accountId, dmSending, selectedGroups, sendTargetCount, dmText, sb, castName, sessionId]);

  // Post-broadcast: first-time payer thank DM (Step 1: show confirmation)
  const handleThankDm = useCallback(async () => {
    if (!accountId || !actions || dmSending) return;
    const unsent = actions.first_time_payers.filter(u => !u.dm_sent);
    if (unsent.length === 0) { setToast('全員送信済みです'); return; }

    setDmConfirmExcluded(new Set());
    setDmConfirm({
      title: '初課金ユーザーへお礼DM',
      users: unsent.map(u => ({ user_name: u.user_name, detail: `${formatTokens(u.session_tokens)}` })),
      message: (dmText || LABELS.defaultTemplateText).slice(0, 100) + '...',
      onConfirm: async (selectedUsers: string[]) => {
        setDmSending(true);
        try {
          const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
          const campaign = `post_thank_${sessionId.slice(0, 8)}_${ts}`;
          const targets = selectedUsers.map(u => ({
            username: u,
            message: (dmText || LABELS.defaultTemplateText).replace('{username}', u),
          }));
          const result = await queueDmBatch(sb, accountId, castName, targets, campaign);
          setDmSentCampaign(campaign);
          setToast(`${result.queued}件のお礼DMをキューに登録しました`);
          setActions(prev => prev ? {
            ...prev,
            first_time_payers: prev.first_time_payers.map(p =>
              selectedUsers.includes(p.user_name) ? { ...p, dm_sent: true } : p
            ),
          } : prev);

          // シナリオ自動エンロール（初課金お礼）
          for (const u of selectedUsers) {
            await checkAndEnroll(sb, accountId, castName, u, 'first_payment');
          }
        } catch (e: unknown) {
          setToast(e instanceof Error ? e.message : '送信エラー');
        }
        setDmSending(false);
        setDmConfirm(null);
      },
    });
  }, [accountId, actions, dmSending, dmText, sb, castName, sessionId]);

  // Post-broadcast: follow DM for visited_no_action (Step 1: show confirmation)
  const handleFollowDm = useCallback(async () => {
    if (!accountId || !actions || dmSending) return;
    const followTargets = actions.visited_no_action;
    if (followTargets.length === 0) { setToast('対象ユーザーがいません'); return; }

    setDmConfirmExcluded(new Set());
    setDmConfirm({
      title: 'フォローDM送信',
      users: followTargets.map(u => ({ user_name: u.user_name, detail: u.segment || '' })),
      message: '{username}さん、今日は来てくれてありがとう！...',
      onConfirm: async (selectedUsers: string[]) => {
        setDmSending(true);
        try {
          const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
          const campaign = `post_follow_${sessionId.slice(0, 8)}_${ts}`;
          const dmTargets = selectedUsers.map(u => ({
            username: u,
            message: `${u}さん、今日は来てくれてありがとう！\nまた気が向いたら遊びに来てくださいね😊`,
          }));
          const result = await queueDmBatch(sb, accountId, castName, dmTargets, campaign);
          setDmSentCampaign(campaign);
          setToast(`${result.queued}件のフォローDMをキューに登録しました`);

          // シナリオ自動エンロール（来訪フォロー）
          for (const u of selectedUsers) {
            await checkAndEnroll(sb, accountId, castName, u, 'visit_no_action');
          }
        } catch (e: unknown) {
          setToast(e instanceof Error ? e.message : '送信エラー');
        }
        setDmSending(false);
        setDmConfirm(null);
      },
    });
  }, [accountId, actions, dmSending, sb, castName, sessionId]);

  // ============================================================
  // LIVE MODE: Data loading + Realtime + Polling
  // ============================================================

  const handleNewMessage = useCallback((payload: { new: Record<string, unknown> }) => {
    const msg = payload.new as unknown as LiveMessage;
    setLiveMessages(prev => [...prev, msg]);
    lastMessageTimeRef.current = msg.message_time;

    if (msg.tokens > 0) {
      setLiveTotalTokens(prev => prev + msg.tokens);
      setLiveRevenueByType(prev => ({
        ...prev,
        [msg.msg_type || 'other']: (prev[msg.msg_type || 'other'] || 0) + msg.tokens,
      }));
    }

    // DM visit detection
    if (msg.user_name && dmSentUsersRef.current.has(msg.user_name)) {
      const dmInfo = dmSentUsersRef.current.get(msg.user_name)!;
      setDmVisitBanners(prev => {
        if (prev.some(b => b.user_name === msg.user_name)) return prev;
        return [...prev, {
          id: `${msg.user_name}-${Date.now()}`,
          user_name: msg.user_name!,
          segment: dmInfo.segment,
          dm_sent_at: dmInfo.sent_at,
        }];
      });
      dmSentUsersRef.current.delete(msg.user_name!);
    }

    // Update viewer list + paying user counts
    if (msg.user_name) {
      setLiveViewers(prev => {
        const idx = prev.findIndex(v => v.user_name === msg.user_name);
        if (idx >= 0) {
          if (msg.tokens > 0) {
            // Existing viewer tipping — check if first tip this session
            if (!sessionPayersRef.current.has(msg.user_name!)) {
              sessionPayersRef.current.add(msg.user_name!);
              setLivePayingCount(p => p + 1);
              // First-time payer for this cast (lifetime was 0 before)
              if (prev[idx].lifetime_tokens === 0) {
                setLiveNewPayerCount(p => p + 1);
              }
            }
            const updated = [...prev];
            updated[idx] = { ...updated[idx], lifetime_tokens: updated[idx].lifetime_tokens + msg.tokens };
            return updated.sort((a, b) => b.lifetime_tokens - a.lifetime_tokens);
          }
          return prev;
        }
        // New viewer
        if (msg.tokens > 0) {
          if (!sessionPayersRef.current.has(msg.user_name!)) {
            sessionPayersRef.current.add(msg.user_name!);
            setLivePayingCount(p => p + 1);
          }
          // New viewer with tip → first-time for this cast
          setLiveNewPayerCount(p => p + 1);
        }
        return [...prev, {
          user_name: msg.user_name!,
          segment: null,
          lifetime_tokens: msg.tokens > 0 ? msg.tokens : 0,
          first_seen: msg.message_time,
          is_new_payer: msg.tokens > 0,
        }].sort((a, b) => b.lifetime_tokens - a.lifetime_tokens);
      });

      // Async: fetch segment for new viewer from paid_users
      supabaseRef.current
        .from('paid_users')
        .select('segment')
        .eq('account_id', accountId!)
        .eq('cast_name', castName)
        .or(`username.eq.${msg.user_name},user_name.eq.${msg.user_name}`)
        .limit(1)
        .single()
        .then(({ data: puData }) => {
          if (puData?.segment) {
            setLiveViewers(prev => prev.map(v =>
              v.user_name === msg.user_name && v.segment === null
                ? { ...v, segment: puData.segment }
                : v
            ));
          }
        });
    }
  }, [accountId, castName]);

  const loadLiveData = useCallback(async () => {
    if (!accountId || !summary) return;
    setLiveLoading(true);

    // 1. Load messages
    const { data: msgs } = await sb
      .from('spy_messages')
      .select('id, message_time, msg_type, user_name, message, tokens, user_color, is_vip')
      .eq('session_id', sessionId)
      .eq('account_id', accountId)
      .order('message_time', { ascending: true })
      .limit(500);

    if (msgs && msgs.length > 0) {
      setLiveMessages(msgs as LiveMessage[]);
      lastMessageTimeRef.current = msgs[msgs.length - 1].message_time;
      if (msgs.length >= 500) setMessageLimitHit(true);

      let totalTk = 0;
      const typeMap: Record<string, number> = {};
      const payerSet = new Set<string>();
      for (const m of msgs) {
        if (m.tokens > 0) {
          totalTk += m.tokens;
          const t = m.msg_type || 'other';
          typeMap[t] = (typeMap[t] || 0) + m.tokens;
          if (m.user_name) payerSet.add(m.user_name);
        }
      }
      setLiveTotalTokens(totalTk);
      setLiveRevenueByType(typeMap);
      setLivePayingCount(payerSet.size);
      sessionPayersRef.current = new Set(payerSet);
    }

    // 2. Build viewer list from session messages
    const viewerMap = new Map<string, { first_seen: string; session_tokens: number }>();
    if (msgs) {
      for (const m of msgs) {
        if (!m.user_name) continue;
        if (!viewerMap.has(m.user_name)) {
          viewerMap.set(m.user_name, { first_seen: m.message_time, session_tokens: 0 });
        }
        if (m.tokens > 0) {
          viewerMap.get(m.user_name)!.session_tokens += m.tokens;
        }
      }
    }

    const userNames = Array.from(viewerMap.keys());

    // 3. Get lifetime tokens per user for this cast
    const lifetimeMap = new Map<string, number>();
    if (userNames.length > 0) {
      const { data: ltData } = await sb
        .from('spy_messages')
        .select('user_name, tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .in('user_name', userNames.slice(0, 200))
        .gt('tokens', 0);
      if (ltData) {
        for (const row of ltData) {
          if (row.user_name) lifetimeMap.set(row.user_name, (lifetimeMap.get(row.user_name) || 0) + row.tokens);
        }
      }
    }

    // 4. Get segments from paid_users
    const segmentMap = new Map<string, string>();
    if (userNames.length > 0) {
      const { data: puData } = await sb
        .from('paid_users')
        .select('username, segment')
        .eq('account_id', accountId)
        .eq('cast_name', castName);
      if (puData) {
        for (const row of puData as { username?: string; user_name?: string; segment: string }[]) {
          const uname = row.username || row.user_name;
          if (uname && row.segment) segmentMap.set(uname, row.segment);
        }
      }
    }

    // 5. Build viewers
    let newPayerCount = 0;
    const viewers: LiveViewer[] = [];
    for (const entry of Array.from(viewerMap.entries())) {
      const [name, data] = entry;
      const lifetime = lifetimeMap.get(name) || 0;
      const segment = segmentMap.get(name) || null;
      const isNew = data.session_tokens > 0 && lifetime <= data.session_tokens;
      if (isNew) newPayerCount++;
      viewers.push({ user_name: name, segment, lifetime_tokens: lifetime, first_seen: data.first_seen, is_new_payer: isNew });
    }
    viewers.sort((a, b) => b.lifetime_tokens - a.lifetime_tokens);
    setLiveViewers(viewers);
    setLiveNewPayerCount(newPayerCount);

    // 6. Load DM send log for visit detection
    const dayBefore = new Date(new Date(summary.started_at).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data: dmData } = await sb
      .from('dm_send_log')
      .select('user_name, sent_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .eq('status', 'success')
      .gte('sent_at', dayBefore)
      .lt('sent_at', summary.started_at);
    if (dmData) {
      const map = new Map<string, { sent_at: string; segment: string | null }>();
      for (const d of dmData) {
        if (d.user_name) map.set(d.user_name, { sent_at: d.sent_at, segment: segmentMap.get(d.user_name) || null });
      }
      dmSentUsersRef.current = map;
    }

    setLiveLoading(false);
  }, [accountId, sessionId, castName, summary, sb]);

  // Refs for Realtime — handleNewMessage を deps から除外してループ防止
  const handleNewMessageRef = useRef(handleNewMessage);
  handleNewMessageRef.current = handleNewMessage;
  const liveChannelRef = useRef<ReturnType<typeof sb.channel> | null>(null);

  const pollNewMessages = useCallback(async () => {
    if (!accountId || !lastMessageTimeRef.current) return;
    const { data } = await sb
      .from('spy_messages')
      .select('id, message_time, msg_type, user_name, message, tokens, user_color, is_vip')
      .eq('session_id', sessionId)
      .eq('account_id', accountId)
      .gt('message_time', lastMessageTimeRef.current)
      .order('message_time', { ascending: true })
      .limit(50);
    if (data && data.length > 0) {
      for (const msg of data) handleNewMessageRef.current({ new: msg as unknown as Record<string, unknown> });
    }
  }, [accountId, sessionId, sb]);

  // Effect: Load live data when mode = 'live'
  useEffect(() => {
    if (resolvedMode !== 'live' || !accountId || !summary) return;
    loadLiveData();
  }, [resolvedMode, accountId, summary, loadLiveData]);

  // Effect: Realtime subscription
  useEffect(() => {
    if (resolvedMode !== 'live' || !accountId) return;

    // 重複subscribe防止
    if (liveChannelRef.current) {
      sb.removeChannel(liveChannelRef.current);
      liveChannelRef.current = null;
    }

    const channel = sb
      .channel('live-session-messages')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'spy_messages',
        filter: `session_id=eq.${sessionId}`,
      }, (payload: { new: Record<string, unknown> }) => {
        handleNewMessageRef.current(payload);
      });
    subscribeWithRetry(channel, (status) => {
      setRealtimeConnected(status === 'SUBSCRIBED');
    });

    liveChannelRef.current = channel;

    return () => {
      if (liveChannelRef.current) {
        sb.removeChannel(liveChannelRef.current);
        liveChannelRef.current = null;
      }
    };
  }, [resolvedMode, accountId, sessionId, sb]);

  // Effect: Polling fallback (10s if Realtime not connected)
  useEffect(() => {
    if (resolvedMode !== 'live' || !accountId || realtimeConnected) return;
    const interval = setInterval(pollNewMessages, 10000);
    return () => clearInterval(interval);
  }, [resolvedMode, accountId, realtimeConnected, pollNewMessages]);

  // Effect: Auto-transition live→post after 10min inactivity
  useEffect(() => {
    if (resolvedMode !== 'live') return;
    const checkInactivity = () => {
      const lastTime = lastMessageTimeRef.current;
      if (!lastTime) return;
      const elapsed = Date.now() - new Date(lastTime).getTime();
      if (elapsed > 10 * 60 * 1000) {
        setMode('post');
      }
    };
    const interval = setInterval(checkInactivity, 30000);
    return () => clearInterval(interval);
  }, [resolvedMode]);

  // Effect: Elapsed time timer
  useEffect(() => {
    if (resolvedMode !== 'live' || !summary) return;
    const startTime = new Date(summary.started_at).getTime();
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startTime) / 1000)));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [resolvedMode, summary]);

  // Effect: DM visit banner auto-clear (5s)
  useEffect(() => {
    if (dmVisitBanners.length === 0) return;
    const t = setTimeout(() => setDmVisitBanners(prev => prev.slice(1)), 5000);
    return () => clearTimeout(t);
  }, [dmVisitBanners]);

  // Effect: Auto-scroll chat
  useEffect(() => {
    if (!isUserScrolledUp.current && chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [liveMessages.length]);

  const handleChatScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const scrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - 50;
    isUserScrolledUp.current = scrolledUp;
    setShowScrollToBottom(scrolledUp);
  };

  // Computed: revenue buckets (10-min intervals)
  const revenueBuckets = (() => {
    if (!summary || liveMessages.length === 0) return [];
    const startTime = new Date(summary.started_at).getTime();
    const bucketSize = 10 * 60 * 1000;
    const bucketMap = new Map<number, number>();
    for (const msg of liveMessages) {
      if (msg.tokens <= 0) continue;
      const idx = Math.floor((new Date(msg.message_time).getTime() - startTime) / bucketSize);
      bucketMap.set(idx, (bucketMap.get(idx) || 0) + msg.tokens);
    }
    if (bucketMap.size === 0) return [];
    const maxIdx = Math.max(...Array.from(bucketMap.keys()));
    const result: { label: string; tokens: number; cumulative: number }[] = [];
    let cum = 0;
    for (let i = 0; i <= maxIdx; i++) {
      const tk = bucketMap.get(i) || 0;
      cum += tk;
      const t = new Date(startTime + i * bucketSize);
      const jst = new Date(t.getTime() + 9 * 60 * 60 * 1000);
      result.push({ label: `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`, tokens: tk, cumulative: cum });
    }
    return result;
  })();

  // Session is "truly live" if ended_at is within 10 minutes
  const isSessionActive = summary ? (Date.now() - new Date(summary.ended_at).getTime()) < 10 * 60 * 1000 : false;

  const toggleGroup = (groupId: string) => {
    setSelectedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  };

  const modeLabels: Record<BroadcastMode, string> = {
    pre: LABELS.preBroadcast,
    live: LABELS.duringBroadcast,
    post: LABELS.postBroadcast,
  };

  // Mode colors: pre=amber, live=red(disabled), post=emerald
  const modeColors: Record<BroadcastMode, { bg: string; border: string; text: string }> = {
    pre:  { bg: 'rgba(245,158,11,0.1)', border: 'rgb(245,158,11)', text: 'rgb(251,191,36)' },
    live: { bg: 'rgba(239,68,68,0.1)', border: 'rgb(239,68,68)', text: 'rgb(248,113,113)' },
    post: { bg: 'rgba(16,185,129,0.1)', border: 'rgb(16,185,129)', text: 'rgb(52,211,153)' },
  };

  return (
    <div className="min-h-screen bg-mesh">
      <div className={`mx-auto px-4 py-8 space-y-6 ${resolvedMode === 'live' ? 'max-w-7xl' : 'max-w-5xl'}`}>
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <Link href="/casts" className="hover:underline">キャスト</Link>
          <span>/</span>
          <Link href={`/casts/${encodeURIComponent(castName)}`} className="hover:underline">{castName}</Link>
          <span>/</span>
          <Link href={`/casts/${encodeURIComponent(castName)}/sessions`} className="hover:underline">セッション一覧</Link>
          <span>/</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {resolvedMode === 'pre' ? '配信準備' : resolvedMode === 'live' ? '配信中' : 'アクション分析'}
          </span>
        </nav>

        {/* Header */}
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {resolvedMode === 'pre' ? `📡 ${LABELS.preBroadcastPrep}` : resolvedMode === 'live' ? `🔴 ${LABELS.liveStatus}` : `📺 ${LABELS.sessionDetail}`}
          </h1>
        </div>

        {/* Mode skeleton while auto-detecting */}
        {mode === null && !loading && (
          <div className="glass-card p-6 text-center animate-pulse">
            <div className="h-4 bg-white/5 rounded w-1/4 mx-auto mb-2" />
            <div className="h-3 bg-white/5 rounded w-1/2 mx-auto" />
          </div>
        )}

        {/* Mode Tabs */}
        {summary && mode !== null && (
          <div className="flex gap-1">
            {(['pre', 'live', 'post'] as BroadcastMode[]).map(m => {
              const isActive = resolvedMode === m;
              const isLive = m === 'live';
              const colors = modeColors[m];
              return (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className="px-4 py-2 text-xs font-semibold rounded-t-lg transition-all"
                  style={{
                    background: isActive ? colors.bg : 'transparent',
                    borderBottom: isActive ? `2px solid ${colors.border}` : '2px solid transparent',
                    color: isActive ? colors.text : 'var(--text-muted)',
                  }}
                >{modeLabels[m]}</button>
              );
            })}
          </div>
        )}

        {/* Loading / Error */}
        {loading ? (
          <div className="glass-card p-12 text-center">
            <div className="inline-block w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>{LABELS.loading}</p>
          </div>
        ) : error ? (
          <div className="glass-card p-8 text-center">
            <p className="text-sm" style={{ color: 'var(--accent-pink)' }}>{error}</p>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{LABELS.checkConsole}</p>
          </div>
        ) : summary ? (
          <>
            {/* ============================================================
               PRE-BROADCAST MODE
               ============================================================ */}
            {resolvedMode === 'pre' && (
              <>
                {/* Summary Bar */}
                <div className="rounded-xl p-5 border-2" style={{ borderColor: 'rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.05)' }}>
                  <h2 className="text-sm font-bold mb-2" style={{ color: 'rgb(251,191,36)' }}>
                    {`📡 ${castName} ${LABELS.preBroadcastPrep}`}
                  </h2>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span>{`${LABELS.prevBroadcast}: ${formatDateCompact(summary.started_at)}~${formatDateCompact(summary.ended_at).split(' ')[1]}`}</span>
                    <span>{`${LABELS.sales}: ${tokensToJPY(summary.total_revenue, COIN_RATE)}`}</span>
                    <span>{`${LABELS.prevAttendance}: ${summary.unique_users}${LABELS.personSuffix}`}</span>
                    <span>{`${LABELS.prevNewUsers}: ${actions ? actions.first_time_payers.length : '-'}${LABELS.personSuffix}`}</span>
                  </div>
                </div>

                {/* Market Analysis Section */}
                {marketLoading ? (
                  <div className="glass-card p-6 text-center">
                    <div className="inline-block w-5 h-5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>マーケットデータ読み込み中...</p>
                  </div>
                ) : (viewerTrends.length > 0 || revenueTypes.length > 0) ? (
                  <div className="glass-card p-5 space-y-4">
                    <h3 className="text-sm font-bold" style={{ color: 'rgb(6,182,212)' }}>📊 マーケット状況（過去7日）</h3>

                    {/* Market Now Summary */}
                    {marketNow && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>現在の時間帯</p>
                          <p className="text-lg font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.current_hour}時台</p>
                        </div>
                        <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>他社アクティブ</p>
                          <p className="text-lg font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.active_casts}配信</p>
                        </div>
                        <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>他社平均視聴者</p>
                          <p className="text-lg font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.avg_viewers_now ?? '-'}人</p>
                        </div>
                        <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>自社平均視聴者</p>
                          <p className="text-lg font-bold" style={{ color: marketNow.own_avg_viewers != null && marketNow.avg_viewers_now > 0 && marketNow.own_avg_viewers >= marketNow.avg_viewers_now ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
                            {marketNow.own_avg_viewers ?? '-'}人
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Best Cast Banner */}
                    {marketNow?.best_cast && (
                      <div className="rounded-lg px-4 py-2.5 flex items-center gap-3" style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)' }}>
                        <span className="text-sm">👑</span>
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          この時間帯のトップ: <strong style={{ color: 'var(--accent-purple)' }}>{marketNow.best_cast}</strong>
                          （最大{marketNow.best_viewers}人）
                        </span>
                      </div>
                    )}

                    {/* Viewer Heatmap (hours × casts) */}
                    {viewerTrends.length > 0 && (() => {
                      const castNames = Array.from(new Set(viewerTrends.map(v => v.cast_name)));
                      const hours = Array.from({ length: 24 }, (_, i) => i);
                      const maxV = Math.max(...viewerTrends.map(v => v.avg_viewers), 1);
                      const currentHour = marketNow?.current_hour ?? new Date().getHours();
                      return (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>時間帯別視聴者数ヒートマップ</p>
                          <div className="overflow-x-auto">
                            <table className="text-[9px] w-full" style={{ minWidth: '600px' }}>
                              <thead>
                                <tr>
                                  <th className="text-left px-1 py-1 sticky left-0" style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)', minWidth: '80px' }}>キャスト</th>
                                  {hours.map(h => (
                                    <th key={h} className="px-0.5 py-1 text-center font-normal" style={{
                                      color: h === currentHour ? 'rgb(6,182,212)' : 'var(--text-muted)',
                                      fontWeight: h === currentHour ? 700 : 400,
                                    }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {castNames.map(cn => (
                                  <tr key={cn}>
                                    <td className="px-1 py-0.5 truncate sticky left-0" style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)', maxWidth: '80px' }}>{cn}</td>
                                    {hours.map(h => {
                                      const cell = viewerTrends.find(v => v.cast_name === cn && v.hour_of_day === h);
                                      const val = cell ? cell.avg_viewers : 0;
                                      const intensity = val / maxV;
                                      return (
                                        <td key={h} className="px-0.5 py-0.5 text-center" style={{
                                          background: val > 0
                                            ? `rgba(6,182,212,${Math.max(0.08, intensity * 0.6)})`
                                            : 'transparent',
                                          color: val > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                                          borderLeft: h === currentHour ? '1px solid rgba(6,182,212,0.5)' : undefined,
                                          borderRight: h === currentHour ? '1px solid rgba(6,182,212,0.5)' : undefined,
                                        }}>
                                          {val > 0 ? Math.round(val) : ''}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>値 = 平均視聴者数 / 縦線 = 現在時刻</p>
                        </div>
                      );
                    })()}

                    {/* Revenue Types */}
                    {revenueTypes.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>他社キャスト課金タイプ分布</p>
                        <div className="overflow-x-auto">
                          <table className="text-[10px] w-full">
                            <thead>
                              <tr style={{ color: 'var(--text-muted)' }}>
                                <th className="text-left px-2 py-1.5">キャスト</th>
                                <th className="text-right px-2 py-1.5">チップ</th>
                                <th className="text-right px-2 py-1.5">チケット</th>
                                <th className="text-right px-2 py-1.5">グループ</th>
                                <th className="text-right px-2 py-1.5">合計tk</th>
                                <th className="text-right px-2 py-1.5">配信日数</th>
                              </tr>
                            </thead>
                            <tbody>
                              {revenueTypes.map(r => (
                                <tr key={r.cast_name} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                                  <td className="px-2 py-1.5 font-semibold truncate" style={{ color: 'var(--text-secondary)', maxWidth: '100px' }}>{r.cast_name}</td>
                                  <td className="px-2 py-1.5 text-right" style={{ color: r.tip_count > 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>{r.tip_count}</td>
                                  <td className="px-2 py-1.5 text-right" style={{ color: r.ticket_count > 0 ? 'var(--accent-purple)' : 'var(--text-muted)' }}>{r.ticket_count}</td>
                                  <td className="px-2 py-1.5 text-right" style={{ color: r.group_count > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}>{r.group_count}</td>
                                  <td className="px-2 py-1.5 text-right font-bold" style={{ color: 'var(--accent-primary)' }}>{r.total_tokens.toLocaleString()}</td>
                                  <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{r.broadcast_days}日</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                {/* DM Section */}
                {preLoading ? (
                  <div className="glass-card p-8 text-center">
                    <div className="inline-block w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{LABELS.loadingPreData}</p>
                  </div>
                ) : (
                  <div className="glass-card p-5 space-y-5">
                    <h3 className="text-sm font-bold" style={{ color: 'rgb(251,191,36)' }}>{`📨 ${LABELS.preDm}`}</h3>

                    {/* Segment Selection */}
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>{LABELS.segmentSelect}</p>
                      {segmentCounts.size === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.dataNotAvailable}</p>
                      ) : (
                        <div className="space-y-2">
                          {SEGMENT_GROUPS.map(g => {
                            const count = g.segments.reduce((s, seg) => s + (segmentCounts.get(seg) || 0), 0);
                            const checked = selectedGroups.has(g.id);
                            return (
                              <label
                                key={g.id}
                                className="flex items-center gap-3 px-4 py-2.5 rounded-lg cursor-pointer transition-all"
                                style={{
                                  background: checked ? 'rgba(245,158,11,0.08)' : 'rgba(0,0,0,0.1)',
                                  border: `1px solid ${checked ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.04)'}`,
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleGroup(g.id)}
                                  className="w-4 h-4 rounded accent-amber-500"
                                />
                                <span className="text-xs font-semibold flex-1" style={{ color: checked ? 'rgb(251,191,36)' : 'var(--text-secondary)' }}>
                                  {g.label}
                                </span>
                                <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>
                                  {count}{LABELS.personSuffix}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {segmentCounts.size > 0 && (
                        <div className="mt-3 px-4 py-2 rounded-lg" style={{ background: 'rgba(245,158,11,0.06)' }}>
                          <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>{LABELS.sendTarget}: </span>
                          <span className="text-sm font-bold" style={{ color: 'rgb(251,191,36)' }}>{sendTargetCount}{LABELS.personSuffix}</span>
                          <span className="text-[10px] ml-2" style={{ color: 'var(--text-muted)' }}>
                            ({SEGMENT_GROUPS.filter(g => selectedGroups.has(g.id)).map(g => g.label).join(', ') || 'なし'})
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Template Selection */}
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>{LABELS.templateSelect}</p>
                      {templates.length > 0 && (
                        <select
                          value={selectedTemplateId || ''}
                          onChange={e => {
                            const id = e.target.value || null;
                            setSelectedTemplateId(id);
                            const tpl = templates.find(t => t.id === id);
                            setDmText(tpl ? tpl.message : LABELS.defaultTemplateText);
                          }}
                          className="input-glass w-full text-xs mb-3"
                        >
                          <option value="">---</option>
                          {templates.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      )}
                      <textarea
                        value={dmText}
                        onChange={e => setDmText(e.target.value)}
                        className="w-full rounded-lg p-4 text-xs resize-y min-h-[100px]"
                        style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', lineHeight: '1.8', border: '1px solid var(--border-glass)' }}
                        placeholder="DMメッセージを入力..."
                      />
                    </div>

                    {/* BYAF */}
                    <div className="rounded-lg px-4 py-3 border" style={{ borderColor: 'rgba(245,158,11,0.2)', background: 'rgba(245,158,11,0.04)' }}>
                      <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>{LABELS.byafLabel}</p>
                      <p className="text-xs italic" style={{ color: 'rgb(251,191,36)' }}>{`「${LABELS.byafText}」`}</p>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-3 pt-2">
                      <button
                        onClick={handlePreBroadcastDm}
                        disabled={dmSending || !!dmSentCampaign?.startsWith('pre_broadcast_') || sendTargetCount === 0}
                        className="text-xs px-5 py-2.5 rounded-lg font-bold transition-all disabled:opacity-50"
                        style={{ background: 'linear-gradient(135deg, rgb(245,158,11), rgb(217,119,6))', color: '#fff' }}
                      >{dmSending ? '送信中...' : dmSentCampaign?.startsWith('pre_broadcast_') ? '✅ 送信済み' : `📤 ${LABELS.bulkSend}`}</button>
                    </div>
                  </div>
                )}

                {/* Previous Result Mini Section */}
                <div className="glass-card p-5">
                  <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>
                    {`📊 ${LABELS.prevResult}（${formatDateCompact(summary.started_at).split(' ')[0]}配信）`}
                  </h3>
                  <div className="grid grid-cols-3 gap-4 text-center mb-4">
                    <div>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.sales}</p>
                      <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>{tokensToJPY(summary.total_revenue, COIN_RATE)}</p>
                      {summary.change_pct !== null && (
                        <p className="text-[10px]" style={{ color: summary.change_pct >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                          {`(${LABELS.prevCompare} ${summary.change_pct >= 0 ? '+' : ''}${summary.change_pct}%) ${summary.change_pct >= 0 ? '⇑' : '⇓'}`}
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.attendance}</p>
                      <p className="text-sm font-bold" style={{ color: 'var(--accent-primary)' }}>{summary.unique_users}{LABELS.personSuffix}</p>
                    </div>
                    <div>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.newPayers}</p>
                      <p className="text-sm font-bold" style={{ color: 'var(--accent-purple)' }}>
                        {actions ? actions.first_time_payers.length : '-'}{LABELS.personSuffix}
                      </p>
                    </div>
                  </div>

                  {/* Unhandled alert */}
                  {unhandledCount > 0 && (
                    <div className="flex items-center justify-between px-4 py-3 rounded-lg border" style={{ background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.2)' }}>
                      <p className="text-xs" style={{ color: 'rgb(248,113,113)' }}>
                        {`⚠️ ${LABELS.unhandledLabel}: ${LABELS.firstTimePayers.replace(/^.*/, '')}${unhandledCount}${LABELS.personSuffix}に${LABELS.thanksDmUnsent}`}
                      </p>
                      <button
                        onClick={() => setMode('post')}
                        className="text-[10px] px-3 py-1.5 rounded-lg font-semibold transition-colors"
                        style={{ background: 'rgba(16,185,129,0.15)', color: 'rgb(52,211,153)' }}
                      >{`→ ${LABELS.goToPostMode}`}</button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ============================================================
               LIVE MODE
               ============================================================ */}
            {resolvedMode === 'live' && (
              <>
                {/* Live Status Bar */}
                <div className="rounded-xl p-4 border-2" style={{ borderColor: 'rgba(239,68,68,0.5)', background: 'rgba(239,68,68,0.08)' }}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg anim-pulse-glow" style={{ background: 'rgba(239,68,68,0.2)', color: 'rgb(248,113,113)' }}>
                        {`🔴 ${LABELS.liveStatus}`}
                      </span>
                      <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{castName}</span>
                      <span className="text-sm font-mono font-bold" style={{ color: 'rgb(248,113,113)' }}>{formatElapsed(elapsedSeconds)}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <span>{`${LABELS.viewerCount}: ${liveViewers.length}${LABELS.personSuffix}`}</span>
                      <span style={{ color: 'var(--accent-amber)' }}>{`${LABELS.revenueLabel}: ${tokensToJPY(liveTotalTokens, COIN_RATE)}`}</span>
                      <span style={{ color: 'var(--accent-green)' }}>{`${LABELS.newUsersLabel}: ${liveNewPayerCount}${LABELS.personSuffix}`}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded" style={{
                        background: realtimeConnected ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)',
                        color: realtimeConnected ? 'rgb(74,222,128)' : 'rgb(251,191,36)',
                      }}>
                        {realtimeConnected ? `● ${LABELS.realtimeActive}` : `○ ${LABELS.pollingMode}`}
                      </span>
                      {modelId && (
                        <button
                          onClick={handleScreenshot}
                          disabled={screenshotting}
                          className="text-[10px] px-2 py-0.5 rounded hover:opacity-80 transition-opacity disabled:opacity-50"
                          style={{ background: 'rgba(56,189,248,0.15)', color: 'var(--accent-primary)' }}
                        >{screenshotting ? '撮影中...' : '📸 スクショ'}</button>
                      )}
                    </div>
                  </div>
                  {!isSessionActive && (
                    <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>{`※ ${LABELS.liveDataPast}`}</p>
                  )}
                </div>

                {/* DM Visit Banners */}
                {dmVisitBanners.map(b => (
                  <div key={b.id} className="rounded-lg px-4 py-2.5 border anim-fade-up" style={{ background: 'rgba(56,189,248,0.08)', borderColor: 'rgba(56,189,248,0.25)' }}>
                    <span className="text-xs" style={{ color: 'var(--accent-primary)' }}>
                      {`📩 ${LABELS.dmVisitDetected}: `}
                      <span className="font-bold">{b.user_name}</span>
                      {b.segment && ` (${getSegmentLabel(b.segment)})`}
                      {` ${LABELS.entered}（${LABELS.dmSentTimeAgo} ${timeAgoText(b.dm_sent_at)}）`}
                    </span>
                  </div>
                ))}

                {liveLoading ? (
                  <div className="glass-card p-12 text-center">
                    <div className="inline-block w-6 h-6 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                    <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>{LABELS.loading}</p>
                  </div>
                ) : (
                  <>
                    {/* Mobile tab switcher (lg未満) */}
                    <div className="flex gap-1 lg:hidden">
                      {(['chat', 'viewers', 'stats'] as const).map(tab => (
                        <button
                          key={tab}
                          onClick={() => setMobileTab(tab)}
                          className="flex-1 px-3 py-2 text-xs font-semibold rounded-lg transition-all"
                          style={{
                            background: mobileTab === tab ? 'rgba(239,68,68,0.1)' : 'transparent',
                            color: mobileTab === tab ? 'rgb(248,113,113)' : 'var(--text-muted)',
                            borderBottom: mobileTab === tab ? '2px solid rgb(239,68,68)' : '2px solid transparent',
                          }}
                        >
                          {tab === 'chat' ? `💬 ${LABELS.chatFeed}` : tab === 'viewers' ? `👥 ${LABELS.viewerPanel}` : `📊 ${LABELS.statsPanel}`}
                        </button>
                      ))}
                    </div>

                    {/* 3-Column Layout */}
                    <div className="grid grid-cols-1 lg:grid-cols-[250px_1fr_280px] gap-4" style={{ minHeight: '500px' }}>
                      {/* === Left: Viewer Panel === */}
                      <div className={`glass-card p-4 overflow-y-auto ${mobileTab !== 'viewers' ? 'hidden lg:block' : ''}`} style={{ maxHeight: 'calc(100vh - 300px)', minHeight: '400px' }}>
                        <h3 className="text-xs font-bold mb-3 sticky top-0 pb-2" style={{ color: 'rgb(248,113,113)', background: 'inherit' }}>
                          {`👥 ${LABELS.viewerPanel} (${liveViewers.length}${LABELS.personSuffix})`}
                        </h3>
                        {liveViewers.length === 0 ? (
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                        ) : (
                          <div className="space-y-1">
                            {liveViewers.map(v => (
                              <div key={v.user_name} className="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.03] transition-colors">
                                <span className="text-sm mt-0.5">{getSegmentEmoji(v.segment)}</span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <Link href={`/users/${encodeURIComponent(v.user_name)}`} className="text-[11px] font-semibold truncate hover:underline" style={{ color: 'var(--accent-primary)' }}>
                                      {v.user_name}
                                    </Link>
                                    {v.is_new_payer && (
                                      <span className="text-[9px] px-1 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.15)', color: 'rgb(251,191,36)' }}>NEW</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    <span>{getSegmentLabel(v.segment)}</span>
                                    {v.lifetime_tokens > 0 && (
                                      <span style={{ color: 'var(--accent-amber)' }}>{`${LABELS.lifetimeLabel}${tokensToJPY(v.lifetime_tokens, COIN_RATE)}`}</span>
                                    )}
                                  </div>
                                  <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{timeAgoText(v.first_seen)}</p>
                                </div>
                                <Link
                                  href={`/casts/${encodeURIComponent(castName)}?tab=dm&target=${encodeURIComponent(v.user_name)}`}
                                  className="text-[10px] opacity-40 hover:opacity-100 transition-opacity shrink-0 mt-1"
                                  title="DMを送る"
                                  onClick={e => e.stopPropagation()}
                                >{'💬'}</Link>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* === Center: Chat Feed === */}
                      <div className={`glass-card flex flex-col relative ${mobileTab !== 'chat' ? 'hidden lg:flex' : ''}`} style={{ maxHeight: 'calc(100vh - 300px)', minHeight: '400px' }}>
                        <h3 className="text-xs font-bold px-4 pt-4 pb-2" style={{ color: 'rgb(248,113,113)' }}>
                          {`💬 ${LABELS.chatFeed} (${liveMessages.length})`}
                        </h3>
                        {messageLimitHit && (
                          <div className="mx-4 mb-2 px-3 py-1.5 rounded-lg text-[10px]" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', color: 'rgb(251,191,36)' }}>
                            ⚠ 初期表示は直近500件のみ。以降のメッセージはリアルタイムで追加されます。
                          </div>
                        )}
                        <div
                          ref={chatContainerRef}
                          onScroll={handleChatScroll}
                          className="flex-1 overflow-y-auto px-4 pb-4 space-y-0.5"
                        >
                          {liveMessages.length === 0 ? (
                            <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>{LABELS.noMessagesYet}</p>
                          ) : (
                            liveMessages.map((msg, i) => {
                              const style = getMsgStyle(msg.msg_type, msg.tokens);
                              const timeJst = formatDateCompact(msg.message_time).split(' ')[1] || '';
                              return (
                                <div
                                  key={msg.id || i}
                                  className={`rounded px-2.5 py-1 ${style.small ? 'py-0.5' : ''}`}
                                  style={{ background: style.bg }}
                                >
                                  <div className="flex items-baseline gap-2">
                                    <span className="text-[9px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>{timeJst}</span>
                                    {msg.tokens > 0 && (
                                      <span className="text-[10px] font-bold shrink-0" style={{ color: 'rgb(251,191,36)' }}>{`💎 ${msg.tokens}tk`}</span>
                                    )}
                                    {msg.user_name && (
                                      <span className={`text-[11px] font-semibold shrink-0 ${style.small ? 'text-[10px]' : ''}`} style={{ color: msg.tokens > 0 ? 'rgb(251,191,36)' : 'var(--accent-primary)' }}>
                                        {msg.user_name}
                                      </span>
                                    )}
                                    <span className={`text-[11px] break-all ${style.small ? 'text-[10px]' : ''} ${style.italic ? 'italic' : ''}`} style={{ color: style.color }}>
                                      {msg.msg_type === 'enter' ? LABELS.entered
                                        : msg.msg_type === 'leave' ? LABELS.left
                                        : msg.msg_type === 'whisper' ? `[${LABELS.whisperLabel}] ${msg.message || ''}`
                                        : msg.message || ''}
                                    </span>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                        {/* Scroll to bottom button */}
                        {showScrollToBottom && (
                          <button
                            onClick={() => {
                              chatContainerRef.current?.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior: 'smooth' });
                              setShowScrollToBottom(false);
                            }}
                            className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs px-3 py-1.5 rounded-full shadow-lg z-10 hover:brightness-110 transition-all"
                            style={{ background: 'rgba(248,113,113,0.8)', color: '#fff' }}
                          >
                            ↓ 最新メッセージへ
                          </button>
                        )}
                      </div>

                      {/* === Right: Stats Panel === */}
                      <div className={`glass-card p-4 overflow-y-auto ${mobileTab !== 'stats' ? 'hidden lg:block' : ''}`} style={{ maxHeight: 'calc(100vh - 300px)', minHeight: '400px' }}>
                        <h3 className="text-xs font-bold mb-4" style={{ color: 'rgb(248,113,113)' }}>
                          {`📊 ${LABELS.statsPanel}`}
                        </h3>

                        {/* Revenue Trend Bars */}
                        {revenueBuckets.length > 0 && (
                          <div className="mb-5">
                            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>{LABELS.revenueTrend}</p>
                            <div className="space-y-1">
                              {revenueBuckets.map((b, i) => {
                                const maxCum = revenueBuckets[revenueBuckets.length - 1]?.cumulative || 1;
                                const pct = Math.round(b.cumulative / maxCum * 100);
                                return (
                                  <div key={i} className="flex items-center gap-1.5">
                                    <span className="text-[9px] font-mono w-10 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>{b.label}</span>
                                    <div className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)' }}>
                                      <div className="h-full rounded-sm transition-all" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--accent-amber), var(--accent-green))' }} />
                                    </div>
                                    <span className="text-[9px] w-16 text-right shrink-0" style={{ color: 'var(--accent-amber)' }}>{tokensToJPY(b.cumulative, COIN_RATE)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Revenue Breakdown */}
                        {Object.keys(liveRevenueByType).length > 0 && (
                          <div className="mb-5">
                            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>{LABELS.revenueBreakdownLive}</p>
                            <div className="space-y-1.5">
                              {Object.entries(liveRevenueByType)
                                .sort(([, a], [, b]) => b - a)
                                .map(([type, tokens]) => {
                                  const pct = liveTotalTokens > 0 ? Math.round(tokens / liveTotalTokens * 100) : 0;
                                  return (
                                    <div key={type} className="flex items-center justify-between">
                                      <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{type}</span>
                                      <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-bold" style={{ color: 'var(--accent-amber)' }}>{tokensToJPY(tokens, COIN_RATE)}</span>
                                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{pct}%</span>
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          </div>
                        )}

                        {/* Key Metrics */}
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.payingUsersLabel}</span>
                            <span className="text-xs font-bold" style={{ color: 'var(--accent-primary)' }}>{`${livePayingCount}${LABELS.personSuffix}`}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.firstTimeLive}</span>
                            <span className="text-xs font-bold" style={{ color: 'var(--accent-green)' }}>{`${liveNewPayerCount}${LABELS.personSuffix}`}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.avgPaymentLabel}</span>
                            <span className="text-xs font-bold" style={{ color: 'var(--accent-amber)' }}>
                              {livePayingCount > 0 ? `${tokensToJPY(Math.round(liveTotalTokens / livePayingCount), COIN_RATE)}${LABELS.perPerson}` : '-'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.messages}</span>
                            <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{liveMessages.length}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {/* ============================================================
               POST-BROADCAST MODE
               ============================================================ */}
            {resolvedMode === 'post' && (
              <>
                {/* Session Info */}
                <div className="glass-card p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                        {summary.session_title || summary.cast_name}
                      </h2>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        {formatJST(summary.started_at)} ~ {formatJST(summary.ended_at)}
                        <span className="ml-3">{`⏱ ${formatDuration(summary.duration_minutes)}`}</span>
                      </p>
                    </div>
                    {summary.change_pct !== null && (
                      <div className="text-right">
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.prevCompare}</p>
                        <p className="text-sm font-bold" style={{
                          color: summary.change_pct >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)',
                        }}>
                          {summary.change_pct >= 0 ? '+' : ''}{summary.change_pct}%
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {[
                      { label: '総売上（チップ+コイン）', value: formatTokens(summary.total_revenue), sub: tokensToJPY(summary.total_revenue, COIN_RATE), color: 'var(--accent-amber)' },
                      { label: 'チャットチップ（SPY監視分）', value: formatTokens(summary.chat_tokens), sub: tokensToJPY(summary.chat_tokens, COIN_RATE), color: 'var(--accent-primary)' },
                      { label: 'コイン売上（API集計）', value: formatTokens(summary.coin_tokens), sub: summary.coin_tokens > 0 ? tokensToJPY(summary.coin_tokens, COIN_RATE) : '-', color: summary.coin_tokens > 0 ? 'var(--accent-pink)' : 'var(--text-muted)' },
                      { label: LABELS.users, value: `${summary.unique_users}`, sub: '', color: 'var(--accent-purple)' },
                      { label: LABELS.messages, value: `${summary.msg_count}`, sub: '', color: 'var(--text-primary)' },
                    ].map(kpi => (
                      <div key={kpi.label} className="glass-panel px-4 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{kpi.label}</p>
                        <p className="text-base font-bold" style={{ color: kpi.color }}>{kpi.value}</p>
                        {kpi.sub && <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{kpi.sub}</p>}
                      </div>
                    ))}
                  </div>
                  {/* Merged sessions badge */}
                  {summary.session_ids && summary.session_ids.length > 1 && (
                    <div className="mt-2 text-[10px] px-3 py-1.5 rounded-lg inline-block" style={{
                      background: 'rgba(167,139,250,0.1)',
                      border: '1px solid rgba(167,139,250,0.25)',
                      color: 'var(--accent-purple)',
                    }}>
                      {summary.session_ids.length}セッション統合（30分ギャップ基準）
                    </div>
                  )}
                </div>

                {/* Coin Revenue Breakdown */}
                {summary.coin_tokens > 0 && Object.keys(summary.coin_by_type).length > 0 && (
                  <div className="glass-card p-5">
                    <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{'💰 コイン売上内訳'}</h3>
                    <div className="space-y-2">
                      {(() => {
                        const coinTypeColors: Record<string, string> = {
                          tip: '#f59e0b', private: '#f43f5e', ticket: '#a78bfa',
                          group: '#38bdf8', spy: '#22c55e', striptease: '#ec4899',
                        };
                        const coinTypeLabels: Record<string, string> = {
                          tip: 'チップ', private: 'プライベート', ticket: 'チケットショー',
                          group: 'グループ', spy: 'スパイ', striptease: 'ストリップ',
                        };
                        return Object.entries(summary.coin_by_type)
                          .sort(([, a], [, b]) => b - a)
                          .map(([type, tokens]) => {
                            const pct = summary.coin_tokens > 0 ? Math.round(tokens / summary.coin_tokens * 100) : 0;
                            const color = coinTypeColors[type] || '#64748b';
                            return (
                              <div key={type} className="flex items-center gap-3">
                                <span className="text-xs w-28 text-right" style={{ color: 'var(--text-secondary)' }}>{coinTypeLabels[type] || type}</span>
                                <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                                </div>
                                <span className="text-xs font-bold min-w-[80px] text-right" style={{ color }}>{formatTokens(tokens)}</span>
                                <span className="text-[10px] min-w-[40px] text-right" style={{ color: 'var(--text-muted)' }}>{pct}%</span>
                              </div>
                            );
                          });
                      })()}
                    </div>
                  </div>
                )}

                {/* Coin Top Users */}
                {summary.coin_top_users && summary.coin_top_users.length > 0 && (
                  <div className="glass-card p-5">
                    <h3 className="text-xs font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>{'👑 コイン売上ランキング（API集計・TOP 5）'}</h3>
                    <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
                      新規 {summary.coin_new_users}人 / リピーター {summary.coin_returning_users}人
                    </p>
                    <div className="space-y-1.5">
                      {summary.coin_top_users.map((u, i) => (
                        <div key={u.user_name} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.02]">
                          <span className="text-xs font-bold w-6" style={{ color: i < 3 ? 'var(--accent-pink)' : 'var(--text-muted)' }}>#{i + 1}</span>
                          <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }} onClick={e => e.stopPropagation()}>{u.user_name}</Link>
                          {u.is_new && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.15)', color: 'rgb(74,222,128)' }}>NEW</span>
                          )}
                          <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{u.types?.join(', ')}</span>
                          <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-pink)' }}>{formatTokens(u.tokens)}</span>
                          <span className="text-[10px] min-w-[60px] text-right" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.tokens, COIN_RATE)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tokens by msg_type (Chat) */}
                {summary.tokens_by_type && Object.keys(summary.tokens_by_type).length > 0 && (
                  <div className="glass-card p-5">
                    <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`💬 ${LABELS.salesBreakdown}`}</h3>
                    <div className="space-y-2">
                      {(() => {
                        const typeTotal = Object.values(summary.tokens_by_type).reduce((s, v) => s + v, 0);
                        return Object.entries(summary.tokens_by_type)
                          .sort(([, a], [, b]) => b - a)
                          .map(([type, tokens]) => {
                            const pct = typeTotal > 0 ? Math.round(tokens / typeTotal * 100) : 0;
                            return (
                              <div key={type} className="flex items-center gap-3">
                                <span className="text-xs w-24 text-right" style={{ color: 'var(--text-secondary)' }}>{type}</span>
                                <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--accent-amber), var(--accent-green))' }} />
                                </div>
                                <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-amber)' }}>{formatTokens(tokens)}</span>
                                <span className="text-[10px] min-w-[40px] text-right" style={{ color: 'var(--text-muted)' }}>{pct}%</span>
                              </div>
                            );
                          });
                      })()}
                    </div>
                  </div>
                )}

                {/* Top Chatters (チャットチップ) */}
                {summary.top_chatters && summary.top_chatters.length > 0 && (
                  <div className="glass-card p-5">
                    <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`💬 チャットチップ ランキング（SPY監視分・TOP 5）`}</h3>
                    <div className="space-y-1.5">
                      {summary.top_chatters.map((u, i) => (
                        <div key={u.user_name} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.02]">
                          <span className="text-xs font-bold w-6" style={{ color: i < 3 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>#{i + 1}</span>
                          <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }} onClick={e => e.stopPropagation()}>{u.user_name}</Link>
                          <Link
                            href={`/casts/${encodeURIComponent(castName)}?tab=dm&target=${encodeURIComponent(u.user_name)}`}
                            className="text-[10px] hover:opacity-70 transition-opacity"
                            style={{ color: 'var(--text-muted)' }}
                            onClick={e => e.stopPropagation()}
                            title="DMを送る"
                          >💬</Link>
                          <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{u.tip_count} tips</span>
                          <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.tokens)}</span>
                          <span className="text-[10px] min-w-[60px] text-right" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.tokens, COIN_RATE)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Previous Broadcast Comparison */}
                {summary.prev_broadcast_group_id && summary.prev_total_revenue !== null && (
                  <div className="glass-card p-5">
                    <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`📊 ${LABELS.prevComparison}`}</h3>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.prevSales}</p>
                        <p className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{formatTokens(summary.prev_total_revenue)}</p>
                        {summary.prev_started_at && (
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatJST(summary.prev_started_at).split(' ')[0]}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.currentSales}</p>
                        <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(summary.total_revenue)}</p>
                      </div>
                      <div>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.changeRate}</p>
                        <p className="text-sm font-bold" style={{
                          color: (summary.change_pct ?? 0) >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)',
                        }}>
                          {summary.change_pct !== null ? `${summary.change_pct >= 0 ? '+' : ''}${summary.change_pct}%` : '-'}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Post-broadcast actions */}
                {resolvedMode === 'post' && (
                  <>
                    {actionsLoading ? (
                      <div className="glass-card p-8 text-center">
                        <div className="inline-block w-5 h-5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{LABELS.analyzingActions}</p>
                      </div>
                    ) : actions ? (
                      <>
                        <div className="flex items-center gap-2 pt-2">
                          <span className="text-base">{'⚡'}</span>
                          <h3 className="text-sm font-bold" style={{ color: 'rgb(52,211,153)' }}>{LABELS.actionHeader}</h3>
                        </div>

                        {/* 1. First-time Payers */}
                        <div className="rounded-xl p-5 border" style={{ background: 'rgba(249,115,22,0.08)', borderColor: 'rgba(249,115,22,0.25)' }}>
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-xs font-bold" style={{ color: 'rgb(251,146,60)' }}>
                              {`🟠 ${LABELS.firstTimePayers} (${actions.first_time_payers.length}${LABELS.personSuffix})`}
                            </h4>
                            {actions.first_time_payers.filter(u => !u.dm_sent).length > 0 && (
                              <button
                                onClick={handleThankDm}
                                disabled={dmSending || !!dmSentCampaign?.startsWith('post_thank_')}
                                className="text-[10px] px-3 py-1.5 rounded-lg font-semibold hover:opacity-80 transition-opacity disabled:opacity-50"
                                style={{ background: 'rgba(249,115,22,0.2)', color: 'rgb(251,146,60)' }}
                              >{dmSending ? '送信中...' : dmSentCampaign?.startsWith('post_thank_') ? '✅ 送信済み' : `${LABELS.sendTemplate}`}</button>
                            )}
                          </div>
                          {actions.first_time_payers.length === 0 ? (
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                          ) : (
                            <div className="space-y-1.5">
                              {actions.first_time_payers.map(u => (
                                <div key={u.user_name}>
                                  <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                                    <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }}>{u.user_name}</Link>
                                    <span className="text-xs font-bold ml-auto" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.session_tokens)}</span>
                                    <span className="text-[10px]" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.session_tokens, COIN_RATE)}</span>
                                    {u.dm_sent ? (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.15)', color: 'rgb(74,222,128)' }}>{`✅${LABELS.dmSentBadge}`}</span>
                                    ) : (
                                      <>
                                        <Link
                                          href={`/casts/${encodeURIComponent(castName)}?tab=dm&target=${encodeURIComponent(u.user_name)}`}
                                          className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
                                          style={{ background: 'rgba(56,189,248,0.15)', color: 'var(--accent-primary)' }}
                                        >{'💬 DM'}</Link>
                                        <button
                                          onClick={async (e) => {
                                            e.stopPropagation();
                                            await sb.from('dm_send_log').insert({
                                              account_id: accountId,
                                              cast_name: castName,
                                              user_name: u.user_name,
                                              message: '手動送信済み',
                                              status: 'success',
                                              sent_via: 'manual',
                                              campaign: `post_thank_${sessionId}`,
                                            });
                                            setActions(prev => prev ? {
                                              ...prev,
                                              first_time_payers: prev.first_time_payers.map(p =>
                                                p.user_name === u.user_name ? { ...p, dm_sent: true } : p
                                              ),
                                            } : prev);
                                            setToast('送信済みに更新しました');
                                          }}
                                          className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
                                          style={{ background: 'rgba(249,115,22,0.15)', color: 'rgb(251,146,60)' }}
                                        >{'✅ 送信済みにする'}</button>
                                      </>
                                    )}
                                    <button
                                      onClick={() => loadUserDmHistory(u.user_name)}
                                      className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
                                      style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
                                    >{expandedDmUser === u.user_name ? '▲ 閉じる' : '📋 DM履歴'}</button>
                                  </div>
                                  {/* Inline DM History Timeline */}
                                  {expandedDmUser === u.user_name && (
                                    <div className="ml-6 mt-1 mb-2 pl-3 border-l-2 space-y-1.5" style={{ borderColor: 'rgba(249,115,22,0.3)' }}>
                                      {userDmLoading ? (
                                        <p className="text-[10px] py-1" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
                                      ) : userDmHistory.length === 0 ? (
                                        <p className="text-[10px] py-1" style={{ color: 'var(--text-muted)' }}>DM履歴なし</p>
                                      ) : (
                                        <>
                                          {userDmHistory.map((dm, i) => (
                                            <div key={i} className="flex items-start gap-2 py-1">
                                              <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                                                dm.status === 'success' ? 'bg-green-500/15 text-green-400' :
                                                dm.status === 'error' ? 'bg-red-500/15 text-red-400' :
                                                'bg-amber-500/15 text-amber-400'
                                              }`}>{dm.status}</span>
                                              <p className="text-[10px] flex-1 break-all" style={{ color: 'var(--text-secondary)' }}>
                                                {(dm.message || '').slice(0, 80)}{(dm.message || '').length > 80 ? '...' : ''}
                                              </p>
                                              <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                {dm.sent_at ? formatDateCompact(dm.sent_at) : formatDateCompact(dm.queued_at)}
                                              </span>
                                            </div>
                                          ))}
                                          <Link
                                            href={`/users/${encodeURIComponent(u.user_name)}`}
                                            className="text-[10px] hover:underline"
                                            style={{ color: 'var(--accent-primary)' }}
                                          >{'もっと見る →'}</Link>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* 2. High Spenders */}
                        <div className="rounded-xl p-5 border" style={{ background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.25)' }}>
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-xs font-bold" style={{ color: 'rgb(96,165,250)' }}>
                              {`🔵 ${LABELS.highSpenders} (${actions.high_spenders.length}${LABELS.personSuffix})`}
                            </h4>
                            {actions.high_spenders.length > 0 && (
                              <Link
                                href={`/casts/${encodeURIComponent(castName)}?tab=dm`}
                                className="text-[10px] px-3 py-1.5 rounded-lg font-semibold hover:opacity-80 transition-opacity"
                                style={{ background: 'rgba(59,130,246,0.2)', color: 'rgb(96,165,250)' }}
                              >{`${LABELS.createDm} →`}</Link>
                            )}
                          </div>
                          {actions.high_spenders.length === 0 ? (
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                          ) : (
                            <div className="space-y-1.5">
                              {actions.high_spenders.map(u => (
                                <div key={u.user_name} className="flex items-center gap-3 px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                                  <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }}>{u.user_name}</Link>
                                  <span className="text-xs font-bold ml-auto" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.session_tokens)}</span>
                                  <span className="text-[10px]" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.session_tokens, COIN_RATE)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* 3. Visited No Action */}
                        <div className="rounded-xl p-5 border" style={{ background: 'rgba(234,179,8,0.08)', borderColor: 'rgba(234,179,8,0.25)' }}>
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-xs font-bold" style={{ color: 'rgb(250,204,21)' }}>
                              {`🟡 ${LABELS.visitedNoAction} (${actions.visited_no_action.length}${LABELS.personSuffix})`}
                            </h4>
                            {actions.visited_no_action.length > 0 && (
                              <button
                                onClick={handleFollowDm}
                                disabled={dmSending || !!dmSentCampaign?.startsWith('post_follow_')}
                                className="text-[10px] px-3 py-1.5 rounded-lg font-semibold hover:opacity-80 transition-opacity disabled:opacity-50"
                                style={{ background: 'rgba(234,179,8,0.2)', color: 'rgb(250,204,21)' }}
                              >{dmSending ? '送信中...' : dmSentCampaign?.startsWith('post_follow_') ? '✅ 送信済み' : `${LABELS.followDm}`}</button>
                            )}
                          </div>
                          {actions.visited_no_action.length === 0 ? (
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                          ) : (
                            <div className="space-y-2">
                              <div className="flex flex-wrap gap-2">
                                {groupBySegmentRange(actions.visited_no_action).map(g => (
                                  <span key={g.label} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)' }}>
                                    {g.label}: <span className="font-bold" style={{ color: 'rgb(250,204,21)' }}>{g.count}{LABELS.personSuffix}</span>
                                  </span>
                                ))}
                              </div>
                              <details className="mt-2">
                                <summary className="text-[10px] cursor-pointer select-none" style={{ color: 'var(--text-muted)' }}>
                                  {`ユーザー一覧を表示 (${actions.visited_no_action.length}${LABELS.personSuffix})`}
                                </summary>
                                <div className="mt-2 space-y-1 max-h-60 overflow-y-auto">
                                  {actions.visited_no_action.map(u => (
                                    <div key={u.user_name} className="flex items-center gap-2 px-3 py-1 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{u.segment}</span>
                                      <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-[11px] font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }}>{u.user_name}</Link>
                                      <Link
                                        href={`/casts/${encodeURIComponent(castName)}?tab=dm`}
                                        className="text-[10px] px-1.5 py-0.5 rounded ml-auto hover:opacity-80 transition-opacity"
                                        style={{ background: 'rgba(56,189,248,0.15)', color: 'var(--accent-primary)' }}
                                      >{'💬 DM'}</Link>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            </div>
                          )}
                        </div>

                        {/* 4. DM No Visit */}
                        <div className="rounded-xl p-5 border" style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)' }}>
                          <h4 className="text-xs font-bold mb-3" style={{ color: 'rgb(248,113,113)' }}>
                            {`🔴 ${LABELS.dmNoVisit} (${actions.dm_no_visit.length}${LABELS.personSuffix})`}
                          </h4>
                          {actions.dm_no_visit.length === 0 ? (
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                          ) : (
                            <>
                              <div className="flex flex-wrap gap-2 mb-3">
                                {groupBySegmentRange(actions.dm_no_visit).map(g => (
                                  <span key={g.label} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)' }}>
                                    {g.label}: <span className="font-bold" style={{ color: 'rgb(248,113,113)' }}>{g.count}{LABELS.personSuffix}</span>
                                  </span>
                                ))}
                              </div>
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.reviewDmTarget}</p>
                            </>
                          )}
                        </div>

                        {/* Segment Breakdown Table */}
                        {actions.segment_breakdown && actions.segment_breakdown.length > 0 && (
                          <div className="glass-card p-5">
                            <h3 className="text-xs font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>{`📊 ${LABELS.segmentBreakdown}`}</h3>
                            <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
                              S1-S3: Whale/VIP（高額課金）　S4-S6: Regular（常連）　S7-S9: Light（少額）　S10: Churned/New
                            </p>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr style={{ color: 'var(--text-muted)' }}>
                                    <th className="text-left pb-2 pr-4 font-semibold">{LABELS.segment}</th>
                                    <th className="text-right pb-2 px-2 font-semibold">{LABELS.dmSentCol}</th>
                                    <th className="text-right pb-2 px-2 font-semibold">{LABELS.visited}</th>
                                    <th className="text-right pb-2 px-2 font-semibold">{LABELS.paid}</th>
                                    <th className="text-right pb-2 px-2 font-semibold">Visit CVR</th>
                                    <th className="text-right pb-2 pl-2 font-semibold">Payment CVR</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {actions.segment_breakdown.map(row => {
                                    const visitCvr = row.dm_sent > 0 ? (row.visited / row.dm_sent * 100).toFixed(1) : '-';
                                    const payCvr = row.visited > 0 ? (row.paid / row.visited * 100).toFixed(1) : '-';
                                    return (
                                      <tr key={row.segment} className="border-t" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                                        <td className="py-2 pr-4 font-bold" style={{ color: 'var(--accent-primary)' }}>{row.segment}</td>
                                        <td className="py-2 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{row.dm_sent}</td>
                                        <td className="py-2 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{row.visited}</td>
                                        <td className="py-2 px-2 text-right" style={{ color: 'var(--accent-amber)' }}>{row.paid}</td>
                                        <td className="py-2 px-2 text-right">
                                          <span style={{ color: 'var(--accent-green)' }}>{visitCvr !== '-' ? `${visitCvr}%` : '-'}</span>
                                          {visitCvr !== '-' && (
                                            <button onClick={() => setShowFormula(showFormula === `${row.segment}-visit` ? null : `${row.segment}-visit`)} className="ml-1 opacity-50 hover:opacity-100 transition-opacity" title={LABELS.showFormulaTitle}>{'📐'}</button>
                                          )}
                                          {showFormula === `${row.segment}-visit` && (
                                            <div className="text-[10px] mt-0.5" style={{ color: 'var(--accent-amber)' }}>{`${row.visited}${LABELS.personSuffix} / ${row.dm_sent}${LABELS.personSuffix} = ${visitCvr}%`}</div>
                                          )}
                                        </td>
                                        <td className="py-2 pl-2 text-right">
                                          <span style={{ color: 'var(--accent-purple)' }}>{payCvr !== '-' ? `${payCvr}%` : '-'}</span>
                                          {payCvr !== '-' && (
                                            <button onClick={() => setShowFormula(showFormula === `${row.segment}-pay` ? null : `${row.segment}-pay`)} className="ml-1 opacity-50 hover:opacity-100 transition-opacity" title={LABELS.showFormulaTitle}>{'📐'}</button>
                                          )}
                                          {showFormula === `${row.segment}-pay` && (
                                            <div className="text-[10px] mt-0.5" style={{ color: 'var(--accent-amber)' }}>{`${row.paid}${LABELS.personSuffix} / ${row.visited}${LABELS.personSuffix} = ${payCvr}%`}</div>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                  {(() => {
                                    const totals = actions.segment_breakdown.reduce(
                                      (acc, r) => ({ dm: acc.dm + r.dm_sent, vis: acc.vis + r.visited, pay: acc.pay + r.paid }),
                                      { dm: 0, vis: 0, pay: 0 }
                                    );
                                    const totalVisitCvr = totals.dm > 0 ? (totals.vis / totals.dm * 100).toFixed(1) : '-';
                                    const totalPayCvr = totals.vis > 0 ? (totals.pay / totals.vis * 100).toFixed(1) : '-';
                                    return (
                                      <tr className="border-t-2" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
                                        <td className="py-2 pr-4 font-bold" style={{ color: 'var(--text-primary)' }}>{LABELS.total}</td>
                                        <td className="py-2 px-2 text-right font-bold" style={{ color: 'var(--text-primary)' }}>{totals.dm}</td>
                                        <td className="py-2 px-2 text-right font-bold" style={{ color: 'var(--text-primary)' }}>{totals.vis}</td>
                                        <td className="py-2 px-2 text-right font-bold" style={{ color: 'var(--accent-amber)' }}>{totals.pay}</td>
                                        <td className="py-2 px-2 text-right font-bold" style={{ color: 'var(--accent-green)' }}>{totalVisitCvr !== '-' ? `${totalVisitCvr}%` : '-'}</td>
                                        <td className="py-2 pl-2 text-right font-bold" style={{ color: 'var(--accent-purple)' }}>{totalPayCvr !== '-' ? `${totalPayCvr}%` : '-'}</td>
                                      </tr>
                                    );
                                  })()}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </>
                    ) : null}

                    {/* 📸 Screenshot Gallery */}
                    {screenshots.length > 0 && (
                      <div className="glass-card p-5">
                        <h3 className="text-xs font-bold mb-3 flex items-center gap-2" style={{ color: 'var(--accent-primary)' }}>
                          {`📸 スクリーンショット (${screenshots.length}枚)`}
                        </h3>
                        <div className="grid grid-cols-3 gap-2">
                          {screenshots.map(ss => (
                            <button key={ss.id} onClick={() => setScreenshotModalUrl(ss.image_url)} className="relative group rounded-lg overflow-hidden border hover:border-sky-400/40 transition-all" style={{ borderColor: 'var(--border-glass)' }}>
                              <img src={ss.image_url} alt={`Screenshot ${ss.captured_at}`} className="w-full h-24 object-cover" loading="lazy" />
                              <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5">
                                <span className="text-[9px]" style={{ color: 'var(--text-secondary)' }}>{formatDateCompact(ss.captured_at)}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Screenshot Modal */}
                    {screenshotModalUrl && (
                      <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center" onClick={() => setScreenshotModalUrl(null)}>
                        <div className="relative max-w-4xl max-h-[90vh]">
                          <img src={screenshotModalUrl} alt="Screenshot" className="max-w-full max-h-[90vh] object-contain rounded-lg" />
                          <button onClick={() => setScreenshotModalUrl(null)} className="absolute top-2 right-2 text-white bg-black/50 rounded-full w-8 h-8 flex items-center justify-center hover:bg-black/80">{'✕'}</button>
                        </div>
                      </div>
                    )}

                    {/* 🎬 Recording & Transcript Section */}
                    <div className="glass-card p-5">
                      <h3 className="text-xs font-bold mb-3 flex items-center gap-2" style={{ color: 'rgb(192,132,252)' }}>
                        {`🎬 ${LABELS.recordingSection}`}
                      </h3>

                      {transcriptsLoading ? (
                        <div className="text-center py-4">
                          <div className="inline-block w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: 'rgb(168,85,247)', borderTopColor: 'transparent' }} />
                        </div>
                      ) : transcripts.length > 0 && transcripts.some(t => t.processing_status === 'completed') ? (
                        /* Completed transcripts timeline */
                        <div className="space-y-1.5 max-h-80 overflow-y-auto">
                          {transcripts
                            .filter(t => t.processing_status === 'completed')
                            .map(t => (
                              <div key={t.id} className="flex gap-3 px-3 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                                <span className="text-[10px] font-mono whitespace-nowrap pt-0.5" style={{ color: 'rgb(192,132,252)' }}>
                                  {t.segment_start_seconds != null
                                    ? `${Math.floor(t.segment_start_seconds / 60).toString().padStart(2, '0')}:${Math.floor(t.segment_start_seconds % 60).toString().padStart(2, '0')}`
                                    : '--:--'}
                                </span>
                                <p className="text-xs flex-1" style={{ color: 'var(--text-secondary)' }}>{t.text}</p>
                                {t.confidence != null && (
                                  <span className="text-[10px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                                    {`${Math.round(t.confidence * 100)}%`}
                                  </span>
                                )}
                              </div>
                            ))}
                        </div>
                      ) : transcripts.some(t => t.processing_status === 'processing' || t.processing_status === 'pending') ? (
                        <div className="text-center py-4">
                          <div className="inline-block w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: 'rgb(168,85,247)', borderTopColor: 'transparent' }} />
                          <p className="text-xs mt-2" style={{ color: 'rgb(192,132,252)' }}>{LABELS.processingTranscript}</p>
                        </div>
                      ) : (
                        /* Upload area */
                        <>
                          <div
                            className="rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-all"
                            style={{
                              borderColor: isDragOver ? 'rgba(168,85,247,0.6)' : 'rgba(168,85,247,0.2)',
                              background: isDragOver ? 'rgba(168,85,247,0.08)' : 'transparent',
                            }}
                            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                            onDragLeave={() => setIsDragOver(false)}
                            onDrop={(e) => {
                              e.preventDefault();
                              setIsDragOver(false);
                              const file = e.dataTransfer.files[0];
                              if (file && /\.(mp4|webm|mkv|mp3|m4a|wav|ogg)$/i.test(file.name)) {
                                setSelectedFile(file);
                              } else {
                                setToast('対応形式: mp4, webm, mkv, mp3, m4a, wav');
                              }
                            }}
                            onClick={() => {
                              const input = document.createElement('input');
                              input.type = 'file';
                              input.accept = '.mp4,.webm,.mkv,.mp3,.m4a,.wav,.ogg';
                              input.onchange = () => {
                                const file = input.files?.[0];
                                if (file) setSelectedFile(file);
                              };
                              input.click();
                            }}
                          >
                            {selectedFile ? (
                              <div>
                                <p className="text-xs font-bold" style={{ color: 'rgb(192,132,252)' }}>
                                  {`✅ ${LABELS.selectedFile}`}
                                </p>
                                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                                  {selectedFile.name}
                                </p>
                                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  {`${(selectedFile.size / (1024 * 1024)).toFixed(1)} MB`}
                                  {selectedFile.size > 25 * 1024 * 1024 && (
                                    <span style={{ color: 'var(--accent-pink)' }}>{` — ⚠ 25MB超`}</span>
                                  )}
                                </p>
                              </div>
                            ) : (
                              <div>
                                <p className="text-3xl mb-2" style={{ opacity: 0.4 }}>📁</p>
                                <p className="text-xs" style={{ color: 'rgb(192,132,252)' }}>
                                  {LABELS.uploadRecording}
                                </p>
                                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                  {LABELS.uploadHint}
                                </p>
                                <p className="text-[9px] mt-2" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
                                  対応形式: mp3, m4a, wav, webm, mp4（25MBまで）
                                </p>
                              </div>
                            )}
                          </div>

                          {selectedFile && (
                            <div className="mt-3 space-y-3">
                              {/* Recording start time (optional) */}
                              <div>
                                <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>
                                  {LABELS.recordingStartLabel}
                                </label>
                                <input
                                  type="datetime-local"
                                  value={recordingStartedAt}
                                  onChange={e => setRecordingStartedAt(e.target.value)}
                                  className="input-glass w-full text-xs"
                                />
                                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  {LABELS.recordingStartHint}
                                </p>
                              </div>

                              {/* 25MB warning */}
                              {selectedFile.size > 25 * 1024 * 1024 && (
                                <p className="text-[10px] px-3 py-2 rounded-lg" style={{ background: 'rgba(244,63,94,0.1)', color: 'var(--accent-pink)' }}>
                                  {LABELS.fileTooLarge}
                                </p>
                              )}

                              {/* Progress bar */}
                              {transcribing && (
                                <div className="space-y-1">
                                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(168,85,247,0.1)' }}>
                                    <div
                                      className="h-full rounded-full transition-all duration-500"
                                      style={{
                                        width: `${uploadProgress}%`,
                                        background: 'linear-gradient(90deg, rgb(168,85,247), rgb(139,92,246))',
                                      }}
                                    />
                                  </div>
                                  <p className="text-[9px] text-right" style={{ color: 'var(--text-muted)' }}>
                                    {uploadProgress < 30 ? 'アップロード中...' : uploadProgress < 90 ? 'Whisper API処理中...' : '保存中...'}
                                  </p>
                                </div>
                              )}

                              {/* Transcribe / Cancel buttons */}
                              <div className="flex gap-2">
                                <button
                                  disabled={transcribing || selectedFile.size > 25 * 1024 * 1024}
                                  onClick={async () => {
                                    setTranscribing(true);
                                    setUploadProgress(10);
                                    const controller = new AbortController();
                                    abortControllerRef.current = controller;
                                    try {
                                      const { data: { session: authSession } } = await sb.auth.getSession();
                                      const fd = new FormData();
                                      fd.append('audio', selectedFile);
                                      fd.append('session_id', sessionId);
                                      fd.append('cast_name', castName);
                                      fd.append('account_id', accountId!);
                                      if (recordingStartedAt) {
                                        fd.append('recording_started_at', new Date(recordingStartedAt).toISOString());
                                      }
                                      setUploadProgress(30);
                                      const res = await fetch('/api/transcribe', {
                                        method: 'POST',
                                        headers: authSession?.access_token ? { Authorization: `Bearer ${authSession.access_token}` } : {},
                                        body: fd,
                                        signal: controller.signal,
                                      });
                                      setUploadProgress(90);
                                      const json = await res.json();
                                      if (!res.ok) throw new Error(json.error || LABELS.transcribeFailed);
                                      setUploadProgress(100);
                                      setToast(`${LABELS.transcribeComplete}（${json.segments}セグメント）`);
                                      setSelectedFile(null);
                                      await loadTranscripts();
                                    } catch (err: unknown) {
                                      if (err instanceof DOMException && err.name === 'AbortError') {
                                        setToast('文字起こしをキャンセルしました');
                                      } else {
                                        const msg = err instanceof Error ? err.message : LABELS.transcribeFailed;
                                        setToast(`${LABELS.transcribeFailed}: ${msg}`);
                                      }
                                      await loadTranscripts();
                                    } finally {
                                      setTranscribing(false);
                                      setUploadProgress(0);
                                      abortControllerRef.current = null;
                                    }
                                  }}
                                  className="flex-1 text-xs px-4 py-2.5 rounded-lg font-bold transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
                                  style={{
                                    background: 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(139,92,246,0.3))',
                                    color: 'rgb(192,132,252)',
                                    border: '1px solid rgba(168,85,247,0.3)',
                                  }}
                                >
                                  {transcribing ? (
                                    <span className="flex items-center justify-center gap-2">
                                      <span className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin" style={{ borderColor: 'rgb(192,132,252)', borderTopColor: 'transparent' }} />
                                      {LABELS.transcribing}
                                    </span>
                                  ) : `🎙 ${LABELS.startTranscription}`}
                                </button>
                                {transcribing && (
                                  <button
                                    onClick={() => abortControllerRef.current?.abort()}
                                    className="text-xs px-3 py-2.5 rounded-lg font-bold transition-all hover:brightness-110"
                                    style={{
                                      background: 'rgba(244,63,94,0.15)',
                                      color: 'var(--accent-pink)',
                                      border: '1px solid rgba(244,63,94,0.3)',
                                    }}
                                  >キャンセル</button>
                                )}
                              </div>
                            </div>
                          )}

                          {!selectedFile && (
                            <p className="text-[10px] mt-3 text-center" style={{ color: 'var(--text-muted)' }}>
                              {LABELS.noRecordingHint}
                            </p>
                          )}
                        </>
                      )}
                    </div>

                    {/* ⏱ 時刻突合タイムライン */}
                    {transcripts.length > 0 && transcripts.some(t => t.processing_status === 'completed') && (
                      <div className="glass-card p-5">
                        <div className="flex items-center justify-between mb-1">
                          <h3 className="text-xs font-bold flex items-center gap-2" style={{ color: '#22c55e' }}>
                            {'⏱ ' + LABELS.timelineTitle}
                          </h3>
                          <button
                            onClick={() => {
                              if (!timelineOpen && timeline.length === 0) loadTimeline();
                              setTimelineOpen(prev => !prev);
                            }}
                            className="text-[11px] px-3 py-1 rounded-lg font-semibold transition-all hover:brightness-110"
                            style={{
                              background: timelineOpen ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.08)',
                              color: '#22c55e',
                              border: '1px solid rgba(34,197,94,0.2)',
                            }}
                          >
                            {timelineOpen ? '▲ 閉じる' : '▼ 展開'}
                          </button>
                        </div>
                        <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
                          {LABELS.timelineDesc}
                        </p>

                        {timelineOpen && (
                          <>
                            {timelineLoading ? (
                              <div className="text-center py-6">
                                <div className="inline-block w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: '#22c55e', borderTopColor: 'transparent' }} />
                                <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>{LABELS.timelineLoading}</p>
                              </div>
                            ) : timeline.length === 0 ? (
                              <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>{LABELS.timelineEmpty}</p>
                            ) : (
                              <>
                                {/* Filter buttons */}
                                <div className="flex items-center gap-2 mb-3 flex-wrap">
                                  {([
                                    { key: 'all' as const, label: LABELS.filterAll, color: '#94a3b8' },
                                    { key: 'transcript' as const, label: LABELS.filterTranscript, color: 'rgb(192,132,252)' },
                                    { key: 'payment' as const, label: LABELS.filterPayment, color: '#f59e0b' },
                                    { key: 'chat' as const, label: LABELS.filterChat, color: '#94a3b8' },
                                  ]).map(f => (
                                    <button
                                      key={f.key}
                                      onClick={() => setTimelineFilter(f.key)}
                                      className="text-[10px] px-2.5 py-1 rounded-full font-semibold transition-all"
                                      style={{
                                        background: timelineFilter === f.key ? `${f.color}22` : 'transparent',
                                        color: timelineFilter === f.key ? f.color : 'var(--text-muted)',
                                        border: `1px solid ${timelineFilter === f.key ? `${f.color}44` : 'rgba(255,255,255,0.06)'}`,
                                      }}
                                    >
                                      {f.label}
                                    </button>
                                  ))}
                                  {/* Highlight legend */}
                                  <span className="ml-auto text-[9px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'rgba(245,158,11,0.4)' }} />
                                    {LABELS.timelineHighlight}
                                  </span>
                                </div>

                                {/* Timeline list */}
                                <div className="space-y-0.5 max-h-[500px] overflow-y-auto">
                                  {timeline
                                    .filter(ev => {
                                      if (timelineFilter === 'all') return true;
                                      if (timelineFilter === 'transcript') return ev.event_type === 'transcript';
                                      if (timelineFilter === 'payment') return ev.event_type === 'tip' || ev.event_type === 'coin';
                                      if (timelineFilter === 'chat') return ev.event_type === 'chat';
                                      return true;
                                    })
                                    .map((ev, i) => {
                                      const isTranscript = ev.event_type === 'transcript';
                                      const isTip = ev.event_type === 'tip';
                                      const isCoin = ev.event_type === 'coin';
                                      const isEnter = ev.event_type === 'enter';
                                      const isLeave = ev.event_type === 'leave';
                                      const isPayment = isTip || isCoin;

                                      // Colors per type
                                      const typeConfig: Record<string, { icon: string; color: string }> = {
                                        transcript: { icon: '🎤', color: 'rgb(192,132,252)' },
                                        chat: { icon: '💬', color: '#94a3b8' },
                                        tip: { icon: '💰', color: '#f59e0b' },
                                        coin: { icon: '🎫', color: '#22c55e' },
                                        enter: { icon: '➡️', color: '#475569' },
                                        leave: { icon: '⬅️', color: '#475569' },
                                      };
                                      const cfg = typeConfig[ev.event_type] || typeConfig.chat;

                                      // Elapsed time formatting
                                      const elapsedH = Math.floor(Math.abs(ev.elapsed_sec) / 3600);
                                      const elapsedM = Math.floor((Math.abs(ev.elapsed_sec) % 3600) / 60);
                                      const elapsedS = Math.abs(ev.elapsed_sec) % 60;
                                      const elapsedStr = `${elapsedH}:${String(elapsedM).padStart(2, '0')}:${String(elapsedS).padStart(2, '0')}`;

                                      return (
                                        <div
                                          key={`${ev.event_time}-${ev.event_type}-${i}`}
                                          className="flex items-start gap-2 px-3 py-1.5 rounded-lg transition-colors"
                                          style={{
                                            background: ev.is_highlight
                                              ? 'rgba(245,158,11,0.08)'
                                              : isPayment
                                                ? 'rgba(245,158,11,0.04)'
                                                : 'rgba(0,0,0,0.08)',
                                            borderLeft: ev.is_highlight ? '2px solid rgba(245,158,11,0.5)' : '2px solid transparent',
                                          }}
                                        >
                                          {/* Elapsed time */}
                                          <span className="text-[9px] font-mono whitespace-nowrap pt-0.5 w-14 shrink-0 text-right" style={{ color: cfg.color }}>
                                            {elapsedStr}
                                          </span>

                                          {/* Icon */}
                                          <span className="text-[10px] shrink-0 pt-0.5">{cfg.icon}</span>

                                          {/* Content */}
                                          <div className="flex-1 min-w-0">
                                            {isTranscript ? (
                                              <p className="text-xs leading-relaxed" style={{ color: ev.is_highlight ? 'rgb(192,132,252)' : 'var(--text-secondary)' }}>
                                                {ev.message}
                                                {ev.confidence != null && (
                                                  <span className="ml-2 text-[9px]" style={{ color: 'var(--text-muted)' }}>{`${Math.round(ev.confidence * 100)}%`}</span>
                                                )}
                                              </p>
                                            ) : isPayment ? (
                                              <p className="text-xs font-semibold" style={{ color: cfg.color }}>
                                                <span style={{ color: 'var(--accent-primary)' }}>{ev.user_name}</span>
                                                <span className="ml-2">{formatTokens(ev.tokens)}</span>
                                                {isCoin && ev.coin_type && (
                                                  <span className="ml-1.5 text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>({ev.coin_type})</span>
                                                )}
                                                {ev.message && (
                                                  <span className="ml-2 font-normal text-[10px]" style={{ color: 'var(--text-muted)' }}>{ev.message}</span>
                                                )}
                                              </p>
                                            ) : isEnter || isLeave ? (
                                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                                <span style={{ color: 'var(--text-secondary)' }}>{ev.user_name}</span>
                                                {` ${isEnter ? '入室' : '退室'}`}
                                              </p>
                                            ) : (
                                              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                                <span className="font-semibold" style={{ color: ev.tokens > 0 ? '#f59e0b' : 'var(--text-secondary)' }}>{ev.user_name}</span>
                                                {ev.message && <span className="ml-2">{ev.message}</span>}
                                                {ev.tokens > 0 && <span className="ml-2 font-bold" style={{ color: '#f59e0b' }}>{formatTokens(ev.tokens)}</span>}
                                              </p>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                </div>

                                {/* Summary stats */}
                                {(() => {
                                  const transcriptCount = timeline.filter(e => e.event_type === 'transcript').length;
                                  const highlightCount = timeline.filter(e => e.is_highlight).length;
                                  const paymentCount = timeline.filter(e => e.event_type === 'tip' || e.event_type === 'coin').length;
                                  const totalTokens = timeline
                                    .filter(e => e.event_type === 'tip' || e.event_type === 'coin')
                                    .reduce((sum, e) => sum + e.tokens, 0);
                                  return (
                                    <div className="flex items-center gap-4 mt-3 pt-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                        {'🎤 ' + transcriptCount + 'セグメント'}
                                      </span>
                                      <span className="text-[10px]" style={{ color: '#f59e0b' }}>
                                        {'💰 ' + paymentCount + '件 / ' + formatTokens(totalTokens)}
                                      </span>
                                      {highlightCount > 0 && (
                                        <span className="text-[10px]" style={{ color: 'rgb(192,132,252)' }}>
                                          {'⚡ ' + highlightCount + '件ハイライト'}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })()}
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {/* 🧠 AI Analysis Section */}
                    <div className="glass-card p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-bold flex items-center gap-2" style={{ color: '#38bdf8' }}>
                          {'🧠 AI分析'}
                        </h3>
                        <button
                          onClick={handleAnalyze}
                          disabled={analyzing}
                          className="text-[11px] px-4 py-1.5 rounded-lg font-semibold transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{
                            background: 'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(99,102,241,0.2))',
                            color: '#38bdf8',
                            border: '1px solid rgba(56,189,248,0.3)',
                          }}
                        >
                          {analyzing ? (
                            <span className="flex items-center gap-2">
                              <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin" style={{ borderColor: '#38bdf8', borderTopColor: 'transparent' }} />
                              分析中...
                            </span>
                          ) : analysisResult ? '🔄 再分析' : '▶ 配信を分析'}
                        </button>
                      </div>

                      {analysisError && (
                        <div className="px-3 py-2 rounded-lg text-xs mb-3" style={{ background: 'rgba(244,63,94,0.1)', color: 'var(--accent-pink)' }}>
                          {analysisError}
                        </div>
                      )}

                      {analysisResult ? (
                        <div className="space-y-4">
                          {/* Summary Stats */}
                          <div>
                            <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>{'📊 サマリー'}</p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                              {[
                                { label: 'イベント数', value: analysisResult.summary.total_events.toLocaleString() },
                                { label: '文字起こし', value: `${analysisResult.summary.transcript_segments}セグメント` },
                                { label: 'チップ', value: `${analysisResult.summary.total_tips}回 / ${formatTokens(analysisResult.summary.tip_tokens)}` },
                                { label: 'チケット', value: `${analysisResult.summary.total_tickets}回 / ${formatTokens(analysisResult.summary.ticket_tokens)}` },
                                { label: 'プライベート', value: `${analysisResult.summary.total_privates}回 / ${formatTokens(analysisResult.summary.private_tokens)}` },
                                { label: 'グループ', value: `${analysisResult.summary.total_groups}回 / ${formatTokens(analysisResult.summary.group_tokens)}` },
                                { label: '入室', value: `${analysisResult.summary.total_enters}回` },
                                { label: '総売上', value: `${formatTokens(analysisResult.summary.total_tokens)} (${tokensToJPY(analysisResult.summary.total_tokens)})` },
                              ].map(({ label, value }) => (
                                <div key={label} className="px-3 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                                  <p className="text-[9px] font-semibold" style={{ color: 'var(--text-muted)' }}>{label}</p>
                                  <p className="text-xs font-bold mt-0.5" style={{ color: 'var(--text-primary)' }}>{value}</p>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Phase Classification */}
                          {analysisResult.phases.length > 0 && (
                            <div>
                              <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>{'📋 配信構成'}</p>
                              <div className="flex gap-1 flex-wrap">
                                {analysisResult.phases.map((phase, i) => {
                                  const phaseColors: Record<string, { bg: string; color: string; label: string }> = {
                                    free_chat: { bg: 'rgba(148,163,184,0.12)', color: '#94a3b8', label: 'フリーチャット' },
                                    tip_rush: { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', label: 'チップラッシュ' },
                                    ticket_show: { bg: 'rgba(168,85,247,0.12)', color: '#a78bfa', label: 'チケットショー' },
                                    private: { bg: 'rgba(244,63,94,0.12)', color: '#f43f5e', label: 'プライベート' },
                                    group_show: { bg: 'rgba(34,197,94,0.12)', color: '#22c55e', label: 'グループ' },
                                    mixed: { bg: 'rgba(56,189,248,0.12)', color: '#38bdf8', label: '混合' },
                                  };
                                  const pc = phaseColors[phase.type] || phaseColors.mixed;
                                  const startTime = new Date(phase.start);
                                  const endTime = new Date(phase.end);
                                  const durationMin = Math.round((endTime.getTime() - startTime.getTime()) / 60000);
                                  return (
                                    <div key={i} className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold" style={{ background: pc.bg, color: pc.color }}>
                                      <span>{pc.label}</span>
                                      <span className="ml-1.5 opacity-70">{`${durationMin}分`}</span>
                                      {phase.tokens > 0 && <span className="ml-1 opacity-70">{`${formatTokens(phase.tokens)}`}</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Payment Triggers */}
                          {analysisResult.triggers.length > 0 && (
                            <div>
                              <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>{'🎯 課金トリガー発言ランキング'}</p>
                              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                                {analysisResult.triggers.map((trigger, i) => (
                                  <div key={i} className="flex items-start gap-3 px-3 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                                    <span className="text-[10px] font-mono whitespace-nowrap pt-0.5 font-bold" style={{ color: '#f59e0b' }}>
                                      {`#${i + 1}`}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                                        {`「${trigger.transcript_text}」`}
                                      </p>
                                      <div className="flex items-center gap-3 mt-1">
                                        <span className="text-[10px] font-mono" style={{ color: 'rgb(192,132,252)' }}>
                                          {new Date(trigger.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                        </span>
                                        <span className="text-[10px] font-bold" style={{ color: '#f59e0b' }}>
                                          {`${formatTokens(trigger.tokens_after)}`}
                                        </span>
                                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                          {`${trigger.users_who_paid.length}人が課金`}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Feedback */}
                          {analysisResult.feedback.length > 0 && (
                            <div>
                              <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>{'💡 フィードバック'}</p>
                              <div className="space-y-1">
                                {analysisResult.feedback.map((point, i) => (
                                  <div key={i} className="flex gap-2 px-3 py-1.5 rounded-lg text-xs" style={{ background: 'rgba(56,189,248,0.05)', color: 'var(--text-secondary)' }}>
                                    <span style={{ color: '#38bdf8' }}>{'•'}</span>
                                    <span>{point}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : !analyzing && !analysisError ? (
                        <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>
                          「配信を分析」ボタンを押すと、タイムラインデータを元に配信構成・課金トリガーを分析します
                        </p>
                      ) : null}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        ) : null}
      </div>

      {/* DM Confirmation Modal */}
      {dmConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
          <div className="glass-card w-full max-w-lg mx-4 max-h-[80vh] flex flex-col" style={{ border: '1px solid var(--border-glow)' }}>
            {/* Header */}
            <div className="px-5 pt-5 pb-3 border-b" style={{ borderColor: 'var(--border-glass)' }}>
              <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {`📩 ${dmConfirm.title}`}
              </h3>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                {`送信先を確認してください — ${dmConfirm.users.length - dmConfirmExcluded.size}/${dmConfirm.users.length}人 選択中`}
              </p>
            </div>

            {/* Message Preview */}
            <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border-glass)', background: 'rgba(245,158,11,0.04)' }}>
              <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>メッセージ</p>
              <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                {dmConfirm.message.length > 120 ? dmConfirm.message.slice(0, 120) + '...' : dmConfirm.message}
              </p>
            </div>

            {/* Select All / Deselect All */}
            <div className="px-5 py-2 flex items-center gap-3 border-b" style={{ borderColor: 'var(--border-glass)' }}>
              <button
                onClick={() => setDmConfirmExcluded(new Set())}
                className="text-[10px] hover:underline"
                style={{ color: 'var(--accent-primary)' }}
              >全選択</button>
              <button
                onClick={() => setDmConfirmExcluded(new Set(dmConfirm.users.map(u => u.user_name)))}
                className="text-[10px] hover:underline"
                style={{ color: 'var(--text-muted)' }}
              >全解除</button>
            </div>

            {/* User List */}
            <div className="flex-1 overflow-y-auto px-5 py-2" style={{ maxHeight: '320px' }}>
              {dmConfirm.users.map(u => {
                const excluded = dmConfirmExcluded.has(u.user_name);
                return (
                  <label
                    key={u.user_name}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors hover:bg-white/[0.03]"
                    style={{ opacity: excluded ? 0.4 : 1 }}
                  >
                    <input
                      type="checkbox"
                      checked={!excluded}
                      onChange={() => {
                        setDmConfirmExcluded(prev => {
                          const next = new Set(prev);
                          if (next.has(u.user_name)) next.delete(u.user_name); else next.add(u.user_name);
                          return next;
                        });
                      }}
                      className="w-3.5 h-3.5 rounded accent-sky-500 shrink-0"
                    />
                    <span className="text-xs font-semibold truncate" style={{ color: 'var(--accent-primary)' }}>{u.user_name}</span>
                    {u.detail && (
                      <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>{u.detail}</span>
                    )}
                  </label>
                );
              })}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t flex items-center justify-between" style={{ borderColor: 'var(--border-glass)' }}>
              <button
                onClick={() => setDmConfirm(null)}
                className="text-xs px-4 py-2 rounded-lg transition-colors hover:bg-white/[0.05]"
                style={{ color: 'var(--text-muted)' }}
              >キャンセル</button>
              <button
                onClick={() => {
                  const selected = dmConfirm.users
                    .filter(u => !dmConfirmExcluded.has(u.user_name))
                    .map(u => u.user_name);
                  if (selected.length === 0) { setToast('送信対象が0人です'); return; }
                  dmConfirm.onConfirm(selected);
                }}
                disabled={dmSending || dmConfirm.users.length - dmConfirmExcluded.size === 0}
                className="text-xs px-5 py-2 rounded-lg font-bold transition-all disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #38bdf8, #0ea5e9)', color: '#fff' }}
              >
                {dmSending ? '送信中...' : `📤 ${dmConfirm.users.length - dmConfirmExcluded.size}人に送信`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl backdrop-blur-xl border shadow-lg anim-fade-up"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-glass)' }}
        >
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{toast}</p>
        </div>
      )}
    </div>
  );
}
