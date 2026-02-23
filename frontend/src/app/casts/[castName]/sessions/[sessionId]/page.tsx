// -*- coding: utf-8 -*-
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, formatJST } from '@/lib/utils';
import Link from 'next/link';

/* ============================================================
   Types
   ============================================================ */
interface SessionSummary {
  session_id: string;
  cast_name: string;
  session_title: string | null;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  msg_count: number;
  unique_users: number;
  total_tokens: number;
  tip_count: number;
  tokens_by_type: Record<string, number>;
  top_users: { user_name: string; tokens: number; tip_count: number }[];
  prev_session_id: string | null;
  prev_total_tokens: number | null;
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
  const lastMessageTimeRef = useRef<string | null>(null);
  const dmSentUsersRef = useRef<Map<string, { sent_at: string; segment: string | null }>>(new Map());
  const sessionPayersRef = useRef<Set<string>>(new Set());

  // Recording / Transcript state
  const [transcripts, setTranscripts] = useState<CastTranscript[]>([]);
  const [transcriptsLoading, setTranscriptsLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

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

  // Load session summary
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    setError(null);

    sb.rpc('get_session_summary', {
      p_account_id: accountId,
      p_session_id: sessionId,
    }).then(async ({ data, error: rpcError }) => {
      if (rpcError) {
        await loadFallback();
        return;
      }
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length > 0) {
        const row = rows[0] as SessionSummary;
        if (typeof row.top_users === 'string') {
          try { row.top_users = JSON.parse(row.top_users); } catch { row.top_users = []; }
        }
        if (typeof row.tokens_by_type === 'string') {
          try { row.tokens_by_type = JSON.parse(row.tokens_by_type); } catch { row.tokens_by_type = {}; }
        }
        setSummary(row);
        setLoading(false);
        return;
      }
      await loadFallback();
    });
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
      session_id: sessionId, cast_name: msgs[0].cast_name, session_title: msgs[0].session_title,
      started_at: new Date(Math.min(...times)).toISOString(), ended_at: new Date(Math.max(...times)).toISOString(),
      duration_minutes: Math.round((Math.max(...times) - Math.min(...times)) / 60000),
      msg_count: msgs.length, unique_users: users.size, total_tokens: totalTk, tip_count: tips.length,
      tokens_by_type: typeMap, top_users: top5,
      prev_session_id: null, prev_total_tokens: null, prev_started_at: null, change_pct: null,
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

  // Load transcripts for this session (post mode only)
  useEffect(() => {
    if (!accountId || resolvedMode !== 'post') return;
    setTranscriptsLoading(true);
    sb.from('cast_transcripts')
      .select('id, session_id, cast_name, segment_start_seconds, segment_end_seconds, text, language, confidence, source_file, processing_status, error_message, created_at')
      .eq('account_id', accountId)
      .eq('session_id', sessionId)
      .order('segment_start_seconds', { ascending: true, nullsFirst: false })
      .then(({ data, error: err }) => {
        if (!err && data) setTranscripts(data as CastTranscript[]);
        setTranscriptsLoading(false);
      });
  }, [accountId, sessionId, resolvedMode, sb]);

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
      for (const msg of data) handleNewMessage({ new: msg as unknown as Record<string, unknown> });
    }
  }, [accountId, sessionId, sb, handleNewMessage]);

  // Effect: Load live data when mode = 'live'
  useEffect(() => {
    if (resolvedMode !== 'live' || !accountId || !summary) return;
    loadLiveData();
  }, [resolvedMode, accountId, summary, loadLiveData]);

  // Effect: Realtime subscription
  useEffect(() => {
    if (resolvedMode !== 'live' || !accountId) return;
    const channel = sb
      .channel(`live-${sessionId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'spy_messages',
        filter: `session_id=eq.${sessionId}`,
      }, (payload: { new: Record<string, unknown> }) => {
        handleNewMessage(payload);
      })
      .subscribe((status: string) => {
        setRealtimeConnected(status === 'SUBSCRIBED');
      });
    return () => { sb.removeChannel(channel); };
  }, [resolvedMode, accountId, sessionId, sb, handleNewMessage]);

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
    isUserScrolledUp.current = el.scrollTop + el.clientHeight < el.scrollHeight - 50;
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
          <span style={{ color: 'var(--text-secondary)' }}>詳細</span>
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
                    <span>{`${LABELS.sales}: ${tokensToJPY(summary.total_tokens, COIN_RATE)}`}</span>
                    <span>{`${LABELS.prevAttendance}: ${summary.unique_users}${LABELS.personSuffix}`}</span>
                    <span>{`${LABELS.prevNewUsers}: ${actions ? actions.first_time_payers.length : '-'}${LABELS.personSuffix}`}</span>
                  </div>
                </div>

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
                        </div>
                      )}
                    </div>

                    {/* Template Selection */}
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>{LABELS.templateSelect}</p>
                      {templates.length > 0 && (
                        <select
                          value={selectedTemplateId || ''}
                          onChange={e => setSelectedTemplateId(e.target.value || null)}
                          className="input-glass w-full text-xs mb-3"
                        >
                          <option value="">---</option>
                          {templates.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      )}
                      <div className="rounded-lg p-4 text-xs whitespace-pre-wrap" style={{ background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', lineHeight: '1.8' }}>
                        {selectedTemplateMsg}
                      </div>
                    </div>

                    {/* BYAF */}
                    <div className="rounded-lg px-4 py-3 border" style={{ borderColor: 'rgba(245,158,11,0.2)', background: 'rgba(245,158,11,0.04)' }}>
                      <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>{LABELS.byafLabel}</p>
                      <p className="text-xs italic" style={{ color: 'rgb(251,191,36)' }}>{`「${LABELS.byafText}」`}</p>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-3 pt-2">
                      <button
                        onClick={() => setToast(LABELS.notImplemented)}
                        className="btn-ghost text-xs px-4 py-2"
                      >{LABELS.preview}</button>
                      <button
                        onClick={() => setToast(LABELS.notImplemented)}
                        className="text-xs px-5 py-2.5 rounded-lg font-bold transition-all"
                        style={{ background: 'linear-gradient(135deg, rgb(245,158,11), rgb(217,119,6))', color: '#fff' }}
                      >{`📤 ${LABELS.bulkSend}`}</button>
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
                      <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>{tokensToJPY(summary.total_tokens, COIN_RATE)}</p>
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
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* === Center: Chat Feed === */}
                      <div className={`glass-card flex flex-col ${mobileTab !== 'chat' ? 'hidden lg:flex' : ''}`} style={{ maxHeight: 'calc(100vh - 300px)', minHeight: '400px' }}>
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
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: LABELS.sales, value: formatTokens(summary.total_tokens), sub: tokensToJPY(summary.total_tokens, COIN_RATE), color: 'var(--accent-amber)' },
                      { label: LABELS.tipCount, value: `${summary.tip_count}`, sub: `${summary.tip_count > 0 ? `${Math.round(summary.total_tokens / summary.tip_count)} tk/tip` : ''}`, color: 'var(--accent-primary)' },
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
                </div>

                {/* Tokens by msg_type */}
                {summary.tokens_by_type && Object.keys(summary.tokens_by_type).length > 0 && (
                  <div className="glass-card p-5">
                    <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`💰 ${LABELS.salesBreakdown}`}</h3>
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

                {/* Top Users */}
                {summary.top_users && summary.top_users.length > 0 && (
                  <div className="glass-card p-5">
                    <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`👑 ${LABELS.topUsers}`}</h3>
                    <div className="space-y-1.5">
                      {summary.top_users.map((u, i) => (
                        <div key={u.user_name} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.02]">
                          <span className="text-xs font-bold w-6" style={{ color: i < 3 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>#{i + 1}</span>
                          <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }} onClick={e => e.stopPropagation()}>{u.user_name}</Link>
                          <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{u.tip_count} tips</span>
                          <span className="text-xs font-bold min-w-[80px] text-right" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.tokens)}</span>
                          <span className="text-[10px] min-w-[60px] text-right" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.tokens, COIN_RATE)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Previous Session Comparison */}
                {summary.prev_session_id && summary.prev_total_tokens !== null && (
                  <div className="glass-card p-5">
                    <h3 className="text-xs font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>{`📊 ${LABELS.prevComparison}`}</h3>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.prevSales}</p>
                        <p className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{formatTokens(summary.prev_total_tokens)}</p>
                        {summary.prev_started_at && (
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatJST(summary.prev_started_at).split(' ')[0]}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{LABELS.currentSales}</p>
                        <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(summary.total_tokens)}</p>
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
                            {actions.first_time_payers.length > 0 && (
                              <Link
                                href={`/casts/${encodeURIComponent(castName)}?tab=dm`}
                                className="text-[10px] px-3 py-1.5 rounded-lg font-semibold hover:opacity-80 transition-opacity"
                                style={{ background: 'rgba(249,115,22,0.2)', color: 'rgb(251,146,60)' }}
                              >{`${LABELS.sendTemplate} →`}</Link>
                            )}
                          </div>
                          {actions.first_time_payers.length === 0 ? (
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{LABELS.noData}</p>
                          ) : (
                            <div className="space-y-1.5">
                              {actions.first_time_payers.map(u => (
                                <div key={u.user_name} className="flex items-center gap-3 px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                                  <Link href={`/users/${encodeURIComponent(u.user_name)}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }}>{u.user_name}</Link>
                                  <span className="text-xs font-bold ml-auto" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.session_tokens)}</span>
                                  <span className="text-[10px]" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(u.session_tokens, COIN_RATE)}</span>
                                  {u.dm_sent ? (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.15)', color: 'rgb(74,222,128)' }}>{`✅${LABELS.dmSentBadge}`}</span>
                                  ) : (
                                    <Link
                                      href={`/casts/${encodeURIComponent(castName)}?tab=dm`}
                                      className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
                                      style={{ background: 'rgba(56,189,248,0.15)', color: 'var(--accent-primary)' }}
                                    >{`💬 DM`}</Link>
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
                              <Link
                                href={`/casts/${encodeURIComponent(castName)}?tab=dm`}
                                className="text-[10px] px-3 py-1.5 rounded-lg font-semibold hover:opacity-80 transition-opacity"
                                style={{ background: 'rgba(234,179,8,0.2)', color: 'rgb(250,204,21)' }}
                              >{`${LABELS.followDm} →`}</Link>
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
                            <h3 className="text-xs font-bold mb-4" style={{ color: 'var(--text-secondary)' }}>{`📊 ${LABELS.segmentBreakdown}`}</h3>
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
                              if (file && /\.(mp4|webm|mkv)$/i.test(file.name) && file.size <= 2 * 1024 * 1024 * 1024) {
                                setSelectedFile(file);
                              } else {
                                setToast('MP4/WebM/MKV（2GB以下）を選択してください');
                              }
                            }}
                            onClick={() => {
                              const input = document.createElement('input');
                              input.type = 'file';
                              input.accept = '.mp4,.webm,.mkv';
                              input.onchange = () => {
                                const file = input.files?.[0];
                                if (file && file.size <= 2 * 1024 * 1024 * 1024) {
                                  setSelectedFile(file);
                                } else if (file) {
                                  setToast('ファイルサイズは2GB以下にしてください');
                                }
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
                              </div>
                            )}
                          </div>

                          {selectedFile && (
                            <button
                              onClick={() => setToast(LABELS.nextPhase)}
                              className="mt-3 w-full text-xs px-4 py-2.5 rounded-lg font-bold transition-all hover:brightness-110"
                              style={{
                                background: 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(139,92,246,0.3))',
                                color: 'rgb(192,132,252)',
                                border: '1px solid rgba(168,85,247,0.3)',
                              }}
                            >
                              {`🎙 ${LABELS.startTranscription}`}
                            </button>
                          )}

                          {!selectedFile && (
                            <p className="text-[10px] mt-3 text-center" style={{ color: 'var(--text-muted)' }}>
                              {LABELS.noRecordingHint}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        ) : null}
      </div>

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
