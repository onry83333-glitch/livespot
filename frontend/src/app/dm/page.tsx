'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';

import { createClient } from '@/lib/supabase/client';
import { tokensToJPY } from '@/lib/utils';
import type { DMFunnel } from '@/types';

/* ============================================================
   Constants
   ============================================================ */
const CHURN_TEMPLATE = '{username}さん、最近見かけないので気になっちゃって😊\n元気にしてますか？\nまた気が向いたらふらっと来てくれたら嬉しいです。\nでも無理しないでね、あなたの自由だから😊';

const THANK_TEMPLATES: Record<string, string | null> = {
  'S1': null, // Manual input required
  'S2': '{username}さん、今日はありがとう😊\nすごく嬉しかったです！\nまた気が向いたら遊びに来てくださいね。\nでも無理しないでね😊',
  'S3': '{username}さん、今日はありがとう😊\nすごく嬉しかったです！\nまた気が向いたら遊びに来てくださいね。\nでも無理しないでね😊',
  'S4': '{username}さん、今日はありがとう😊\nすごく楽しかったです！\n気が向いたらまた遊びに来てくださいね。',
  'S5': '{username}さん、今日はありがとう😊\nすごく楽しかったです！\n気が向いたらまた遊びに来てくださいね。',
  'S6': '{username}さん、ありがとう😊\nまた会えたら嬉しいです。\nあなたの自由だから、気が向いたらね😊',
  'S7': '{username}さん、ありがとう😊\nまた会えたら嬉しいです。\nあなたの自由だから、気が向いたらね😊',
  'S8': '{username}さん、ありがとう😊\nまた会えたら嬉しいです。\nあなたの自由だから、気が向いたらね😊',
  'S9': '{username}さん、ありがとう😊\nまた会えたら嬉しいです。\nあなたの自由だから、気が向いたらね😊',
};

function getSegmentBadgeClasses(segment: string): string {
  if (segment === 'S1') return 'bg-amber-500/15 text-amber-400 border border-amber-500/20';
  if (segment === 'S2' || segment === 'S3') return 'bg-purple-500/15 text-purple-400 border border-purple-500/20';
  if (segment === 'S4' || segment === 'S5') return 'bg-sky-500/15 text-sky-400 border border-sky-500/20';
  return 'bg-slate-500/15 text-slate-400 border border-slate-500/20';
}

/* ============================================================
   Types
   ============================================================ */
interface DMLogItem {
  id: number;
  user_name: string;
  message: string | null;
  status: string;
  error: string | null;
  campaign: string;
  queued_at: string;
  sent_at: string | null;
  sent_via?: string | null;
}

interface NewWhale {
  user_name: string;
  total_tokens: number;
  first_paid: string;
  already_dm_sent: boolean;
}

interface ThankYouCandidate {
  user_name: string;
  tokens_in_session: number;
  segment: string;
  suggested_template: string | null;
}

interface AccountWithCasts {
  id: string;
  account_name: string;
  cast_usernames?: string[];
}

interface AutoDMItem {
  id: number;
  user_name: string;
  cast_name: string | null;
  message: string | null;
  campaign: string;
  template_name: string;
  queued_at: string;
  ai_generated?: boolean;
  ai_reasoning?: string | null;
  ai_confidence?: number | null;
  scenario_enrollment_id?: string | null;
}

interface PendingAIDM {
  id: number;
  user_name: string;
  cast_name: string | null;
  message: string | null;
  campaign: string;
  template_name: string;
  queued_at: string;
  ai_generated: boolean;
  ai_reasoning: string | null;
  ai_confidence: number | null;
  scenario_enrollment_id: string | null;
}

interface ScenarioItem {
  id: string;
  scenario_name: string;
  trigger_type: string;
  segment_targets: string[];
  steps: { step: number; delay_hours: number; template: string; message?: string; goal: string }[];
  is_active: boolean;
  auto_approve_step0: boolean;
  daily_send_limit: number;
}

interface EnrollmentItem {
  id: string;
  scenario_id: string;
  cast_name: string | null;
  username: string;
  enrolled_at: string;
  current_step: number;
  status: string;
  next_step_due_at: string | null;
  goal_reached_at: string | null;
}

/* ============================================================
   Page
   ============================================================ */
export default function DmPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [tab, setTab] = useState<'bulk' | 'thank' | 'auto' | 'scenario'>('bulk');

  // === 共通 ===
  const [accounts, setAccounts] = useState<AccountWithCasts[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  // === 一斉送信 state ===
  const [targetsText, setTargetsText] = useState('');
  const [message, setMessage] = useState('');
  const [sendOrder, setSendOrder] = useState<'text-image' | 'image-text' | 'text-only'>('text-image');
  const [accessImage, setAccessImage] = useState<'free' | 'paid'>('free');
  const [sendMode, setSendMode] = useState<'sequential' | 'pipeline'>('pipeline');
  const [tabs, setTabs] = useState(3);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [apiSessionValid, setApiSessionValid] = useState(false);
  const [apiSessionExportedAt, setApiSessionExportedAt] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [statusCounts, setStatusCounts] = useState({ total: 0, queued: 0, sending: 0, success: 0, error: 0 });
  const [recentLogs, setRecentLogs] = useState<DMLogItem[]>([]);

  // === お礼DM state ===
  const [thankPeriod, setThankPeriod] = useState<'1' | '3' | '7'>('1');
  const [thankMinCoins, setThankMinCoins] = useState(100);
  const [whales, setWhales] = useState<NewWhale[]>([]);
  const [whaleChecked, setWhaleChecked] = useState<Set<string>>(new Set());
  const [whaleLoading, setWhaleLoading] = useState(false);
  const [whaleError, setWhaleError] = useState<string | null>(null);
  const [thankMessage, setThankMessage] = useState(
    '{username}さん、昨日は応援ありがとうございました！とっても嬉しかったです💕 また遊びに来てくださいね！'
  );
  const [thankSending, setThankSending] = useState(false);
  const [thankResult, setThankResult] = useState<{ queued: number; batch_id: string } | null>(null);

  // === お礼DM v2 (API-based auto-load) state ===
  const [thankCandidates, setThankCandidates] = useState<ThankYouCandidate[]>([]);
  const [thankCandidateChecked, setThankCandidateChecked] = useState<Set<string>>(new Set());
  const [thankCandidateMessages, setThankCandidateMessages] = useState<Record<string, string>>({});
  const [thankCandidateLoading, setThankCandidateLoading] = useState(false);
  const [thankApiAvailable, setThankApiAvailable] = useState<boolean | null>(null); // null = unknown, true/false after first call
  const [thankConfirmOpen, setThankConfirmOpen] = useState(false);

  // === 自動DM state ===
  const [autoDMs, setAutoDMs] = useState<AutoDMItem[]>([]);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoApproving, setAutoApproving] = useState(false);
  const [autoChecked, setAutoChecked] = useState<Set<number>>(new Set());
  const [editingDMId, setEditingDMId] = useState<number | null>(null);
  const [editingDMMessage, setEditingDMMessage] = useState('');

  // === シナリオ state ===
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [enrollments, setEnrollments] = useState<EnrollmentItem[]>([]);
  const [scenarioLoading, setScenarioLoading] = useState(false);
  const [scenarioFilter, setScenarioFilter] = useState<'all' | 'active' | 'completed' | 'goal_reached' | 'cancelled'>('all');
  const [enrollmentListExpanded, setEnrollmentListExpanded] = useState(false);
  const [autoGroupExpanded, setAutoGroupExpanded] = useState<Set<string>>(new Set());

  // === キャンペーン効果 state ===
  const [campaignStats, setCampaignStats] = useState<{ campaign: string; total: number; success: number; error: number; rate: number }[]>([]);
  const [campaignStatsLoading, setCampaignStatsLoading] = useState(false);

  // === DMファネル state ===
  const [funnelData, setFunnelData] = useState<DMFunnel[]>([]);

  // === API offline state ===
  const [apiOffline, setApiOffline] = useState(false);

  // === URL preset handled flag ===
  const presetHandledRef = useRef(false);

  const targets = targetsText.split('\n').map(t => t.trim()).filter(Boolean);

  // アカウント取得 (with cast_usernames)
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id, account_name, cast_usernames').order('created_at').then(({ data }) => {
      const list = (data || []) as AccountWithCasts[];
      setAccounts(list);
      if (list.length > 0) setSelectedAccount(list[0].id);
    });
  }, [user, sb]);

  // === API DM送信セッション確認 ===
  useEffect(() => {
    if (!selectedAccount) return;
    sb.from('stripchat_sessions')
      .select('id, is_valid, exported_at, stripchat_user_id')
      .eq('account_id', selectedAccount)
      .eq('is_valid', true)
      .maybeSingle()
      .then(({ data: scSession }) => {
        setApiSessionValid(!!scSession);
        setApiSessionExportedAt(scSession?.exported_at || null);
      });
  }, [selectedAccount, sb]);

  // === キャンペーン効果測定データ取得 ===
  useEffect(() => {
    if (!selectedAccount) return;
    setCampaignStatsLoading(true);
    sb.from('dm_send_log')
      .select('campaign, status')
      .eq('account_id', selectedAccount)
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setApiOffline(true);
          setCampaignStatsLoading(false);
          return;
        }
        const items = data || [];
        const campMap: Record<string, { total: number; success: number; error: number }> = {};
        items.forEach(item => {
          const c = item.campaign || '(なし)';
          if (!campMap[c]) campMap[c] = { total: 0, success: 0, error: 0 };
          campMap[c].total++;
          if (item.status === 'success') campMap[c].success++;
          if (item.status === 'error') campMap[c].error++;
        });
        setCampaignStats(
          Object.entries(campMap).map(([campaign, v]) => ({
            campaign,
            total: v.total,
            success: v.success,
            error: v.error,
            rate: v.total > 0 ? Math.round((v.success / v.total) * 1000) / 10 : 0,
          }))
        );
        setCampaignStatsLoading(false);
      });
  }, [selectedAccount, sb]);

  // === DMファネル分析データ取得 ===
  useEffect(() => {
    if (!selectedAccount) return;
    const acct = accounts.find(a => a.id === selectedAccount);
    const castName = acct?.cast_usernames?.[0] || null;
    const fetchFunnel = async () => {
      const { data } = await sb.rpc('get_dm_funnel', {
        p_account_id: selectedAccount,
        p_cast_name: castName,
      });
      if (data) setFunnelData(data);
    };
    fetchFunnel();
  }, [selectedAccount, accounts, sb]);

  // === URL preset handling (Task 3) ===
  useEffect(() => {
    if (presetHandledRef.current) return;
    const preset = searchParams.get('preset');
    const usersParam = searchParams.get('users');

    if (preset === 'churn' && usersParam) {
      presetHandledRef.current = true;
      const usernames = usersParam.split(',').filter(Boolean);
      setTab('bulk');
      setTargetsText(usernames.join('\n'));
      setMessage(CHURN_TEMPLATE);
      // Clear URL params after loading
      router.replace('/dm', { scroll: false });
    }
  }, [searchParams, router]);

  // === お礼DM v2: Auto-load candidates when tab = thank ===
  const loadThankCandidates = useCallback(async () => {
    if (!selectedAccount || thankApiAvailable === false) return;

    const acct = accounts.find(a => a.id === selectedAccount);
    const castName = acct?.cast_usernames?.[0];
    if (!castName) return;

    // FastAPIバックエンド未デプロイのためフォールバックモード
    setThankApiAvailable(false);
    setThankCandidateLoading(false);
  }, [selectedAccount, accounts, thankMinCoins, thankApiAvailable]);

  useEffect(() => {
    if (tab === 'thank' && selectedAccount && accounts.length > 0 && thankApiAvailable !== false) {
      loadThankCandidates();
    }
  }, [tab, selectedAccount, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // === 自動DMロジック ===
  const loadAutoDMs = useCallback(async () => {
    if (!selectedAccount) return;
    setAutoLoading(true);
    try {
      const { data } = await sb.from('dm_send_log')
        .select('id, user_name, cast_name, message, campaign, template_name, queued_at, ai_generated, ai_reasoning, ai_confidence, scenario_enrollment_id')
        .eq('account_id', selectedAccount)
        .eq('status', 'pending')
        .order('queued_at', { ascending: false })
        .limit(200);
      setAutoDMs((data || []) as AutoDMItem[]);
      setAutoChecked(new Set());
    } catch { /* ignore */ }
    setAutoLoading(false);
  }, [selectedAccount, sb]);

  useEffect(() => {
    if (tab === 'auto' && selectedAccount) {
      loadAutoDMs();
    }
  }, [tab, selectedAccount]); // eslint-disable-line react-hooks/exhaustive-deps

  // === シナリオロジック ===
  const loadScenarios = useCallback(async () => {
    if (!selectedAccount) return;
    setScenarioLoading(true);
    try {
      const [scenarioRes, enrollRes] = await Promise.all([
        sb.from('dm_scenarios')
          .select('id, scenario_name, trigger_type, segment_targets, steps, is_active, auto_approve_step0, daily_send_limit')
          .eq('account_id', selectedAccount)
          .order('created_at'),
        sb.from('dm_scenario_enrollments')
          .select('id, scenario_id, cast_name, username, enrolled_at, current_step, status, next_step_due_at, goal_reached_at')
          .eq('account_id', selectedAccount)
          .order('enrolled_at', { ascending: false })
          .limit(500),
      ]);
      setScenarios((scenarioRes.data || []) as ScenarioItem[]);
      setEnrollments((enrollRes.data || []) as EnrollmentItem[]);
    } catch { /* ignore */ }
    setScenarioLoading(false);
  }, [selectedAccount, sb]);

  useEffect(() => {
    if (tab === 'scenario' && selectedAccount) {
      loadScenarios();
    }
  }, [tab, selectedAccount]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApproveAutoDMs = async (ids: number[]) => {
    if (ids.length === 0) return;
    setAutoApproving(true);
    try {
      await sb.from('dm_send_log')
        .update({ status: 'queued' })
        .in('id', ids);
      setAutoDMs(prev => prev.filter(d => !ids.includes(d.id)));
      setAutoChecked(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    } catch { /* ignore */ }
    setAutoApproving(false);
  };

  const handleDismissAutoDMs = async (ids: number[]) => {
    if (ids.length === 0) return;
    try {
      await sb.from('dm_send_log')
        .delete()
        .in('id', ids);
      setAutoDMs(prev => prev.filter(d => !ids.includes(d.id)));
      setAutoChecked(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    } catch { /* ignore */ }
  };

  const handleEditDM = (dm: AutoDMItem) => {
    setEditingDMId(dm.id);
    setEditingDMMessage(dm.message || '');
  };

  const handleSaveEdit = async (id: number) => {
    try {
      await sb.from('dm_send_log')
        .update({
          message: editingDMMessage,
          edited_by_human: true,
          original_ai_message: autoDMs.find(d => d.id === id)?.message || null,
        })
        .eq('id', id);
      setAutoDMs(prev => prev.map(d =>
        d.id === id ? { ...d, message: editingDMMessage } : d
      ));
      setEditingDMId(null);
      setEditingDMMessage('');
    } catch { /* ignore */ }
  };

  const handleCancelEdit = () => {
    setEditingDMId(null);
    setEditingDMMessage('');
  };

  // === 一斉送信ロジック ===
  const pollStatus = useCallback(async (bid: string) => {
    try {
      const { data: items } = await sb.from('dm_send_log')
        .select('*')
        .eq('campaign', bid)
        .eq('account_id', selectedAccount)
        .order('created_at', { ascending: false });
      const logs = items || [];
      const counts = { total: logs.length, queued: 0, sending: 0, success: 0, error: 0 };
      logs.forEach(l => {
        if (l.status in counts) (counts as Record<string, number>)[l.status]++;
      });
      setStatusCounts(counts);
      setRecentLogs(logs.map(l => ({
        id: l.id, user_name: l.user_name, message: l.message,
        status: l.status, error: l.error, campaign: l.campaign,
        queued_at: l.queued_at || l.created_at, sent_at: l.sent_at,
        sent_via: l.sent_via,
      })));
    } catch { /* ignore */ }
  }, [sb, selectedAccount]);

  useEffect(() => {
    if (!user) return;
    const channel = sb
      .channel('dm-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_send_log', filter: selectedAccount ? `account_id=eq.${selectedAccount}` : undefined }, () => {
        if (batchId) pollStatus(batchId);
      })
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [user, batchId, pollStatus, sb, selectedAccount]);

  const handleSend = async () => {
    if (targets.length === 0) { setError('ターゲットを1件以上入力してください'); return; }
    if (!message.trim()) { setError('メッセージを入力してください'); return; }
    if (!selectedAccount) { setError('アカウントを選択してください'); return; }
    setSending(true); setError(null); setBatchId(null);
    try {
      // ターゲットからユーザー名を抽出
      const usernames = targets.map(t => t.replace(/.*\/user\//, '').trim());

      const { data, error: rpcErr } = await sb.rpc('create_dm_batch', {
        p_account_id: selectedAccount,
        p_targets: usernames,
        p_message: message,
        p_template_name: null,
      });

      if (rpcErr) throw rpcErr;

      // RPC関数がエラーを返した場合（上限超え等）
      if (data?.error) {
        setError(`${data.error} (使用済み: ${data.used}/${data.limit})`);
        return;
      }

      const originalBid = data?.batch_id;
      const count = data?.count || usernames.length;

      // 送信モード設定をキャンペーンに埋め込み（background.jsが解析）
      const modePrefix = sendMode === 'pipeline' ? `pipe${tabs}` : 'seq';
      const bid = `${modePrefix}_${originalBid}`;

      // dm_send_logのcampaignフィールドを更新
      await sb.from('dm_send_log')
        .update({ campaign: bid })
        .eq('campaign', originalBid);

      setBatchId(bid);
      setQueuedCount(count);
      setStatusCounts({ total: count, queued: count, sending: 0, success: 0, error: 0 });
      if (bid) pollStatus(bid);

      // API送信モード: サーバーサイドでバッチ処理
      if (apiSessionValid) {
        fetch('/api/dm/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            account_id: selectedAccount,
            limit: 50,
          }),
        }).catch(e => console.warn('API batch send failed, extension will pick up:', e));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSending(false);
  };

  // === お礼DMロジック (legacy / fallback) ===
  const detectWhales = async () => {
    if (!selectedAccount) { setWhaleError('アカウントを選択してください'); return; }
    setWhaleLoading(true); setWhaleError(null); setWhales([]); setWhaleChecked(new Set()); setThankResult(null);
    try {
      const daysAgo = parseInt(thankPeriod);
      const sinceDate = new Date(Date.now() - daysAgo * 86400000);
      sinceDate.setHours(0, 0, 0, 0);

      // coin_transactions から期間内の課金ユーザーを取得
      const { data: txData } = await sb.from('coin_transactions')
        .select('user_name, tokens, created_at')
        .eq('account_id', selectedAccount)
        .gte('created_at', sinceDate.toISOString());

      // ユーザー別集計
      const userMap: Record<string, { total: number; first: string }> = {};
      (txData || []).forEach(tx => {
        if (!userMap[tx.user_name]) userMap[tx.user_name] = { total: 0, first: tx.created_at };
        userMap[tx.user_name].total += (tx.tokens || 0);
      });

      // 最低コイン数以上をフィルタ
      const filtered = Object.entries(userMap)
        .filter(([, v]) => v.total >= thankMinCoins)
        .map(([user_name, v]) => ({
          user_name,
          total_tokens: v.total,
          first_paid: v.first || sinceDate.toISOString(),
          already_dm_sent: false,
        }));

      // DM送信済みチェック
      if (filtered.length > 0) {
        const { data: dmData } = await sb.from('dm_send_log')
          .select('user_name')
          .eq('account_id', selectedAccount)
          .in('user_name', filtered.map(f => f.user_name))
          .eq('status', 'success');
        const sentSet = new Set((dmData || []).map(d => d.user_name));
        filtered.forEach(f => { f.already_dm_sent = sentSet.has(f.user_name); });
      }

      setWhales(filtered);
      const autoChecked = new Set<string>();
      filtered.forEach(w => { if (!w.already_dm_sent) autoChecked.add(w.user_name); });
      setWhaleChecked(autoChecked);
    } catch (e: unknown) {
      setWhaleError(e instanceof Error ? e.message : 'エラーが発生しました');
    }
    setWhaleLoading(false);
  };

  const toggleWhale = (un: string) => {
    setWhaleChecked(prev => {
      const next = new Set(prev);
      if (next.has(un)) next.delete(un); else next.add(un);
      return next;
    });
  };

  const selectAll = () => setWhaleChecked(new Set(whales.map(w => w.user_name)));
  const deselectAll = () => setWhaleChecked(new Set());

  // === Thank candidate v2 toggle/select ===
  const toggleCandidate = (un: string) => {
    setThankCandidateChecked(prev => {
      const next = new Set(prev);
      if (next.has(un)) next.delete(un); else next.add(un);
      return next;
    });
  };
  const selectAllCandidates = () => setThankCandidateChecked(new Set(thankCandidates.map(c => c.user_name)));
  const deselectAllCandidates = () => setThankCandidateChecked(new Set());

  const updateCandidateMessage = (un: string, msg: string) => {
    setThankCandidateMessages(prev => ({ ...prev, [un]: msg }));
  };

  // Segment breakdown for confirmation
  const getSegmentBreakdown = (): Record<string, number> => {
    const breakdown: Record<string, number> = {};
    thankCandidates
      .filter(c => thankCandidateChecked.has(c.user_name))
      .forEach(c => {
        breakdown[c.segment] = (breakdown[c.segment] || 0) + 1;
      });
    return breakdown;
  };

  // === お礼DM送信 (shared for both v1 and v2) ===
  const handleThankSend = async () => {
    if (whaleChecked.size === 0) { setWhaleError('ユーザーを1名以上選択してください'); return; }
    if (!thankMessage.trim()) { setWhaleError('メッセージを入力してください'); return; }
    if (!selectedAccount) { setWhaleError('アカウントを選択してください'); return; }
    setThankSending(true); setWhaleError(null); setThankResult(null);
    try {
      const usernames = Array.from(whaleChecked);
      const { data, error: rpcErr } = await sb.rpc('create_dm_batch_personalized', {
        p_account_id: selectedAccount,
        p_usernames: usernames,
        p_message_template: thankMessage,
        p_template_name: 'thank_dm',
      });

      if (rpcErr) {
        if (rpcErr.message?.includes('function') || rpcErr.code === '42883') {
          console.warn('[DM] create_dm_batch_personalized未実装 → 直接INSERT');
          const bid = `thank_${Date.now()}`;
          const rows = usernames.map(un => ({
            account_id: selectedAccount,
            user_name: un,
            profile_url: `https://stripchat.com/user/${un}`,
            message: thankMessage.replace('{username}', un),
            status: 'queued',
            campaign: bid,
            template_name: 'thank_dm',
            queued_at: new Date().toISOString(),
          }));
          const { error: insertErr } = await sb.from('dm_send_log').insert(rows);
          if (insertErr) throw insertErr;
          setThankResult({ queued: rows.length, batch_id: bid });
        } else {
          throw rpcErr;
        }
      } else if (data?.error) {
        setWhaleError(`${data.error} (使用済み: ${data.used}/${data.limit})`);
        return;
      } else {
        setThankResult({ queued: data?.count || usernames.length, batch_id: data?.batch_id || '' });
      }
    } catch (e: unknown) {
      setWhaleError(e instanceof Error ? e.message : 'エラーが発生しました');
    }
    setThankSending(false);
  };

  // === お礼DM v2 送信 (personalized per-user messages) ===
  const handleThankV2Send = async () => {
    const selected = thankCandidates.filter(c => thankCandidateChecked.has(c.user_name));
    if (selected.length === 0) return;
    if (!selectedAccount) return;

    // Validate: all selected must have a message
    const emptyMsg = selected.find(c => !(thankCandidateMessages[c.user_name] || '').trim());
    if (emptyMsg) {
      setWhaleError(`${emptyMsg.user_name} のメッセージが空です`);
      setThankConfirmOpen(false);
      return;
    }

    setThankConfirmOpen(false);
    setThankSending(true);
    setWhaleError(null);
    setThankResult(null);

    try {
      const bid = `thank_v2_${Date.now()}`;
      const rows = selected.map(c => ({
        account_id: selectedAccount,
        user_name: c.user_name,
        profile_url: `https://stripchat.com/user/${c.user_name}`,
        message: thankCandidateMessages[c.user_name] || '',
        status: 'queued',
        campaign: bid,
        template_name: 'thank_dm',
        queued_at: new Date().toISOString(),
      }));
      const { error: insertErr } = await sb.from('dm_send_log').insert(rows);
      if (insertErr) throw insertErr;
      setThankResult({ queued: rows.length, batch_id: bid });
    } catch (e: unknown) {
      setWhaleError(e instanceof Error ? e.message : 'エラーが発生しました');
    }
    setThankSending(false);
  };

  if (!user) return null;

  // Determine if we should show the new API-based UI or the legacy UI for the thank tab
  const useNewThankUI = thankApiAvailable === true;

  return (
    <div className="max-w-[1400px] space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">DM</h1>
          <span className="badge-info text-[10px]">V7.0</span>
          <span className="badge-info text-[10px] flex items-center gap-1">
            Chrome拡張で実行
          </span>
        </div>
        {accounts.length > 0 && (
          <select className="input-glass text-xs px-3 py-2 w-48"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
          </select>
        )}
      </div>

      {/* Tab Switch */}
      <div className="flex gap-1">
        {([
          { key: 'bulk' as const, label: '一斉送信' },
          { key: 'thank' as const, label: 'お礼ＤＭ' },
          { key: 'auto' as const, label: `自動DM${autoDMs.length > 0 ? ` (${autoDMs.length})` : ''}` },
          { key: 'scenario' as const, label: 'シナリオ' },
        ]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-all ${
              tab === t.key ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:text-slate-200'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* API offline warning */}
      {apiOffline && (
        <div className="glass-card p-3 flex items-center gap-2" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)' }}>
          <span>&#9888;&#65039;</span>
          <span className="text-xs">API接続不可 — 手動モードで動作中</span>
        </div>
      )}

      {/* ============ 一斉送信タブ ============ */}
      {tab === 'bulk' && (
        <div className="space-y-4 anim-fade-up">
          <div className="grid grid-cols-12 gap-4">
            {/* Left: Targets */}
            <div className="col-span-3 glass-card p-5">
              <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                Target
              </h3>
              <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>URLまたはユーザー名（1行1件、{targets.length}件）</p>
              <textarea
                className="input-glass font-mono text-[11px] leading-relaxed h-48 resize-none"
                value={targetsText}
                onChange={e => setTargetsText(e.target.value)}
                placeholder="https://ja.stripchat.com/user/username&#10;またはユーザー名を1行ずつ"
              />
              <div className="mt-4">
                <div className="flex items-center justify-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>確定ターゲット</span>
                  <span className="text-2xl font-bold">{targets.length}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>名</span>
                </div>
              </div>
            </div>

            {/* Center: Message + Image */}
            <div className="col-span-5 space-y-4">
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-3 flex items-center gap-2">Message</h3>
                <textarea className="input-glass h-28 resize-none text-sm"
                  value={message} onChange={(e) => setMessage(e.target.value)}
                  placeholder="メッセージを入力..." />
              </div>
            </div>

            {/* Right: Settings */}
            <div className="col-span-4 glass-card p-5">
              <h3 className="text-sm font-bold mb-4 flex items-center gap-2">Settings</h3>
              <div className="mb-5">
                <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>順番送信</p>
                <div className="space-y-2">
                  {([
                    { key: 'text-image' as const, label: 'テキスト → 画像' },
                    { key: 'image-text' as const, label: '画像 → テキスト' },
                    { key: 'text-only' as const, label: 'テキストのみ' },
                  ]).map(o => (
                    <button key={o.key} onClick={() => setSendOrder(o.key)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                        sendOrder === o.key ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:bg-white/[0.03]'
                      }`}>
                      <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${sendOrder === o.key ? 'bg-sky-400 border-sky-400' : 'border-slate-600'}`}></span>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-5">
                <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>アクセス画像</p>
                <div className="flex gap-2">
                  <button onClick={() => setAccessImage('free')}
                    className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${accessImage === 'free' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'btn-ghost'}`}>無料</button>
                  <button onClick={() => setAccessImage('paid')}
                    className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${accessImage === 'paid' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'btn-ghost'}`}>有料設定</button>
                </div>
              </div>
              <div className="mb-5">
                <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>送信モード</p>
                <div className="space-y-2">
                  <button onClick={() => setSendMode('sequential')}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${sendMode === 'sequential' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:bg-white/[0.03]'}`}>
                    <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${sendMode === 'sequential' ? 'bg-sky-400 border-sky-400' : 'border-slate-600'}`}></span>
                    順次 (安全)
                  </button>
                  <button onClick={() => setSendMode('pipeline')}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${sendMode === 'pipeline' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:bg-white/[0.03]'}`}>
                    <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${sendMode === 'pipeline' ? 'bg-sky-400 border-sky-400' : 'border-slate-600'}`}></span>
                    パイプライン (高速)
                  </button>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>同時タブ</p>
                  <span className="text-2xl font-bold text-sky-400">{tabs}</span>
                </div>
                <input type="range" min="1" max="5" value={tabs}
                  onChange={(e) => setTabs(Number(e.target.value))} className="w-full accent-sky-400" />
              </div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-4 py-3 rounded-xl text-sm border"
              style={{ background: 'rgba(244,63,94,0.08)', borderColor: 'rgba(244,63,94,0.2)', color: 'var(--accent-pink)' }}>
              {error}
            </div>
          )}

          {/* API送信ステータス */}
          <div className="flex items-center gap-2 text-[10px] mb-2">
            <span className={`w-2 h-2 rounded-full ${apiSessionValid ? 'bg-emerald-500 anim-live' : 'bg-amber-500'}`} />
            <span style={{ color: apiSessionValid ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
              {apiSessionValid ? 'API送信可能' : 'Chrome拡張モード'}
            </span>
            {apiSessionExportedAt && (
              <span style={{ color: 'var(--text-muted)' }}>
                (同期: {new Date(apiSessionExportedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })})
              </span>
            )}
          </div>

          {/* Send Button */}
          <button onClick={handleSend} disabled={sending}
            className="w-full py-4 rounded-2xl text-lg font-bold text-white transition-all duration-300 flex items-center justify-center gap-3 disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, var(--accent-pink), #e11d48)', boxShadow: '0 6px 30px rgba(244,63,94,0.3)' }}>
            {sending ? 'キュー登録中...' : `送信開始（${targets.length}件）`}
          </button>

          {/* Batch Status */}
          {batchId && (
            <div className="glass-card p-5 anim-fade-up">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold">送信ステータス</h3>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{batchId}</span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-800 mb-4 overflow-hidden">
                {statusCounts.total > 0 && (
                  <div className="h-full rounded-full transition-all duration-500 flex">
                    <div className="h-full bg-emerald-500" style={{ width: `${(statusCounts.success / statusCounts.total) * 100}%` }} />
                    <div className="h-full bg-sky-500" style={{ width: `${(statusCounts.sending / statusCounts.total) * 100}%` }} />
                    <div className="h-full bg-rose-500" style={{ width: `${(statusCounts.error / statusCounts.total) * 100}%` }} />
                  </div>
                )}
              </div>
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>待機</p>
                  <p className="text-lg font-bold">{statusCounts.queued}</p>
                </div>
                <div className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--accent-primary)' }}>送信中</p>
                  <p className="text-lg font-bold text-sky-400">{statusCounts.sending}</p>
                </div>
                <div className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--accent-green)' }}>成功</p>
                  <p className="text-lg font-bold text-emerald-400">{statusCounts.success}</p>
                </div>
                <div className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--accent-pink)' }}>失敗</p>
                  <p className="text-lg font-bold text-rose-400">{statusCounts.error}</p>
                </div>
              </div>
              {recentLogs.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-auto">
                  {recentLogs.map(log => (
                    <div key={log.id} className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs"
                      style={{ background: 'rgba(15,23,42,0.3)' }}>
                      <span className={
                        log.status === 'success' ? 'text-emerald-400' :
                        log.status === 'error' ? 'text-rose-400' :
                        log.status === 'sending' ? 'text-sky-400' : 'text-slate-500'
                      }>
                        {log.status === 'success' ? '✓' : log.status === 'error' ? '✕' : log.status === 'sending' ? '↻' : '○'}
                      </span>
                      <span className="font-medium flex-1 truncate">{log.user_name}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{log.status}</span>
                      {log.sent_via === 'api' && (
                        <span className="text-[8px] px-1.5 py-0.5 rounded ml-1"
                          style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                          API
                        </span>
                      )}
                      {log.error && <span className="text-rose-400 truncate max-w-[200px]">{log.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Campaign Effectiveness Panel */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-bold mb-4">キャンペーン効果</h3>
            {campaignStatsLoading && (
              <div className="h-20 animate-pulse rounded" style={{ background: 'var(--bg-card)' }} />
            )}
            {!campaignStatsLoading && campaignStats.length === 0 && (
              <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>キャンペーンデータなし</p>
            )}
            {!campaignStatsLoading && campaignStats.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                      <th className="pb-3 font-medium text-xs">キャンペーン名</th>
                      <th className="pb-3 font-medium text-xs text-right">送信数</th>
                      <th className="pb-3 font-medium text-xs text-right">成功</th>
                      <th className="pb-3 font-medium text-xs text-right">エラー</th>
                      <th className="pb-3 font-medium text-xs text-right">成功率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaignStats.map((cs, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                        <td className="py-3">
                          <span className="text-xs font-mono px-2 py-1 rounded bg-white/[0.03] truncate max-w-[200px] inline-block">
                            {cs.campaign}
                          </span>
                        </td>
                        <td className="py-3 text-right tabular-nums">{cs.total}</td>
                        <td className="py-3 text-right tabular-nums text-emerald-400">{cs.success}</td>
                        <td className="py-3 text-right tabular-nums text-rose-400">{cs.error}</td>
                        <td className="py-3 text-right tabular-nums font-semibold">
                          <span className={
                            cs.rate >= 80 ? 'text-emerald-400' :
                            cs.rate >= 50 ? 'text-amber-400' : 'text-slate-300'
                          }>
                            {cs.rate.toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* DMファネル分析 */}
          {funnelData.length > 0 && (
            <div className="glass-card p-4">
              <h3 className="text-sm font-medium text-sky-300 mb-3">DMファネル分析</h3>
              <div className="space-y-2">
                {funnelData.map((f) => (
                  <div key={f.campaign} className="glass-panel p-3">
                    <div className="text-xs text-slate-400 mb-2">{f.campaign || '(キャンペーン名なし)'}</div>
                    <div className="flex items-center gap-2 text-sm">
                      {/* DM送信 */}
                      <div className="text-center">
                        <div className="text-lg font-bold text-slate-200">{f.dm_sent_count}</div>
                        <div className="text-[10px] text-slate-500">DM送信</div>
                      </div>
                      <div className="text-slate-600">&rarr;</div>
                      {/* 来訪 */}
                      <div className="text-center">
                        <div className="text-lg font-bold text-sky-400">{f.visited_count}</div>
                        <div className="text-[10px] text-slate-500">来訪 ({f.visit_rate}%)</div>
                      </div>
                      <div className="text-slate-600">&rarr;</div>
                      {/* 課金 */}
                      <div className="text-center">
                        <div className="text-lg font-bold text-green-400">{f.paid_count}</div>
                        <div className="text-[10px] text-slate-500">課金 ({f.conversion_rate}%)</div>
                      </div>
                      <div className="text-slate-600">&rarr;</div>
                      {/* トークン */}
                      <div className="text-center">
                        <div className="text-lg font-bold text-amber-400">{f.total_tokens.toLocaleString()}</div>
                        <div className="text-[10px] text-slate-500">tk</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============ お礼DMタブ ============ */}
      {tab === 'thank' && (
        <div className="space-y-4 anim-fade-up">
          {/* Error */}
          {whaleError && (
            <div className="px-4 py-3 rounded-xl text-sm border"
              style={{ background: 'rgba(244,63,94,0.08)', borderColor: 'rgba(244,63,94,0.2)', color: 'var(--accent-pink)' }}>
              {whaleError}
            </div>
          )}

          {/* Success Toast */}
          {thankResult && (
            <div className="px-4 py-3 rounded-xl text-sm border"
              style={{ background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.2)', color: '#22c55e' }}>
              {thankResult.queued}件のお礼EDMをキューに追加しました（{thankResult.batch_id}）
            </div>
          )}

          {/* ===== NEW API-based UI ===== */}
          {useNewThankUI && (
            <>
              {/* Loading skeleton */}
              {thankCandidateLoading && (
                <div className="glass-card p-5 space-y-3">
                  <div className="h-4 w-48 rounded animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  {[1, 2, 3].map(i => (
                    <div key={i} className="flex items-center gap-4">
                      <div className="w-4 h-4 rounded animate-pulse" style={{ background: 'var(--bg-card)' }} />
                      <div className="h-4 w-32 rounded animate-pulse" style={{ background: 'var(--bg-card)' }} />
                      <div className="h-4 w-20 rounded animate-pulse ml-auto" style={{ background: 'var(--bg-card)' }} />
                    </div>
                  ))}
                </div>
              )}

              {/* No candidates */}
              {!thankCandidateLoading && thankCandidates.length === 0 && (
                <div className="glass-card p-10 text-center">
                  <p className="text-4xl mb-4 opacity-30">✔</p>
                  <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                    お礼EDM候補なし
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    現在お礼EDMを送る候補が見つかりませんでした。
                  </p>
                  <button
                    onClick={loadThankCandidates}
                    className="btn-ghost text-xs mt-4 px-4 py-2">
                    再検出
                  </button>
                </div>
              )}

              {/* Candidate table */}
              {!thankCandidateLoading && thankCandidates.length > 0 && (
                <>
                  <div className="glass-card p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-bold">
                        お礼EDM候補（{thankCandidates.length}名）
                      </h3>
                      <div className="flex gap-2">
                        <button onClick={selectAllCandidates} className="btn-ghost text-[10px] px-3 py-1">全選択</button>
                        <button onClick={deselectAllCandidates} className="btn-ghost text-[10px] px-3 py-1">全解除</button>
                        <button onClick={loadThankCandidates} className="btn-ghost text-[10px] px-3 py-1">再検出</button>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {thankCandidates.map(c => {
                        const isS1 = c.segment === 'S1';
                        const isChecked = thankCandidateChecked.has(c.user_name);
                        return (
                          <div key={c.user_name}
                            className="rounded-xl p-4 transition-all"
                            style={{
                              background: isChecked ? 'rgba(14,165,233,0.04)' : 'rgba(15,23,42,0.3)',
                              border: isS1 ? '1px solid rgba(245,158,11,0.3)' : '1px solid var(--border-glass)',
                            }}>
                            <div className="flex items-center gap-4 mb-2">
                              {/* Checkbox */}
                              <div
                                className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all cursor-pointer ${
                                  isChecked ? 'bg-sky-500 border-sky-500' : 'border-slate-600'
                                }`}
                                onClick={() => toggleCandidate(c.user_name)}>
                                {isChecked && (
                                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                    <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                  </svg>
                                )}
                              </div>

                              {/* Username */}
                              <span className="text-sm font-medium flex-1">{c.user_name}</span>

                              {/* Tokens */}
                              <span className="text-emerald-400 font-semibold text-sm">
                                {c.tokens_in_session.toLocaleString()} tk
                              </span>
                              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                ({tokensToJPY(c.tokens_in_session)})
                              </span>

                              {/* Segment badge */}
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${getSegmentBadgeClasses(c.segment)}`}>
                                {c.segment}
                              </span>

                              {/* S1 manual label */}
                              {isS1 && (
                                <span className="text-[10px] text-amber-400 flex items-center gap-1">
                                  ⚠️ 手動入力
                                </span>
                              )}
                            </div>

                            {/* Message textarea */}
                            <textarea
                              className={`input-glass text-xs resize-none w-full ${
                                isS1 ? 'border-amber-500/30' : ''
                              }`}
                              style={{ minHeight: '60px' }}
                              value={thankCandidateMessages[c.user_name] || ''}
                              onChange={e => updateCandidateMessage(c.user_name, e.target.value)}
                              placeholder={isS1 ? '手動でメッセージを入力してください...' : 'メッセージ'}
                            />
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {thankCandidateChecked.size}名 選択中
                    </div>
                  </div>

                  {/* Send button */}
                  <button
                    onClick={() => setThankConfirmOpen(true)}
                    disabled={thankSending || thankCandidateChecked.size === 0}
                    className="w-full py-3 rounded-xl text-sm font-bold text-white transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-50"
                    style={{
                      background: thankCandidateChecked.size > 0
                        ? 'linear-gradient(135deg, #22c55e, #16a34a)'
                        : 'linear-gradient(135deg, #475569, #334155)',
                      boxShadow: thankCandidateChecked.size > 0 ? '0 6px 30px rgba(34,197,94,0.3)' : 'none',
                    }}>
                    {thankSending
                      ? 'キュー登録中...'
                      : `確認して送信（${thankCandidateChecked.size}件）`
                    }
                  </button>

                  {/* Confirmation Dialog */}
                  {thankConfirmOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
                      <div className="glass-card p-6 max-w-md w-full mx-4 anim-fade-up">
                        <h3 className="text-base font-bold mb-4">お礼EDM送信確認</h3>
                        <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
                          {thankCandidateChecked.size}名にお礼EDMを送信します。
                        </p>
                        {/* Segment breakdown */}
                        <div className="space-y-1 mb-4">
                          {Object.entries(getSegmentBreakdown())
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([seg, count]) => (
                              <div key={seg} className="flex items-center gap-2 text-xs">
                                <span className={`px-2 py-0.5 rounded-full font-medium ${getSegmentBadgeClasses(seg)}`}>
                                  {seg}
                                </span>
                                <span style={{ color: 'var(--text-secondary)' }}>{count}名</span>
                              </div>
                            ))}
                        </div>
                        <div className="flex gap-3">
                          <button
                            onClick={() => setThankConfirmOpen(false)}
                            className="btn-ghost text-xs flex-1 py-2.5">
                            キャンセル
                          </button>
                          <button
                            onClick={handleThankV2Send}
                            disabled={thankSending}
                            className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white disabled:opacity-50"
                            style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}>
                            {thankSending ? '送信中...' : '送信実行'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ===== LEGACY / FALLBACK UI (when API is not available) ===== */}
          {!useNewThankUI && (
            <>
              {/* Controls */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-4">新規太客を検出</h3>
                <div className="flex items-end gap-4 flex-wrap">
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>期間</label>
                    <select className="input-glass text-xs px-3 py-2 w-32"
                      value={thankPeriod} onChange={e => setThankPeriod(e.target.value as '1' | '3' | '7')}>
                      <option value="1">昨日</option>
                      <option value="3">直近3日</option>
                      <option value="7">直近7日</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>最低コイン数</label>
                    <input type="number" className="input-glass text-xs px-3 py-2 w-28"
                      value={thankMinCoins} onChange={e => setThankMinCoins(Number(e.target.value))} min={1} />
                  </div>
                  <button onClick={detectWhales} disabled={whaleLoading}
                    className="btn-primary text-xs px-5 py-2.5 disabled:opacity-50">
                    {whaleLoading ? '検出中...' : '検出する'}
                  </button>
                </div>
              </div>

              {/* Whale Results */}
              {whales.length > 0 && (
                <>
                  {/* Whale Table */}
                  <div className="glass-card p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-bold">
                        検出結果（{whales.length}名）
                      </h3>
                      <div className="flex gap-2">
                        <button onClick={selectAll} className="btn-ghost text-[10px] px-3 py-1">全選択</button>
                        <button onClick={deselectAll} className="btn-ghost text-[10px] px-3 py-1">全解除</button>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                            <th className="pb-3 font-medium text-xs w-10"></th>
                            <th className="pb-3 font-medium text-xs">ユーザー名</th>
                            <th className="pb-3 font-medium text-xs text-right">課金額</th>
                            <th className="pb-3 font-medium text-xs text-right">初課金日</th>
                            <th className="pb-3 font-medium text-xs text-center">DM状況</th>
                          </tr>
                        </thead>
                        <tbody>
                          {whales.map(w => (
                            <tr key={w.user_name} className="border-t cursor-pointer hover:bg-white/[0.02] transition-colors"
                              style={{ borderColor: 'var(--border-glass)' }}
                              onClick={() => toggleWhale(w.user_name)}>
                              <td className="py-3">
                                <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                                  whaleChecked.has(w.user_name)
                                    ? 'bg-sky-500 border-sky-500' : 'border-slate-600'
                                }`}>
                                  {whaleChecked.has(w.user_name) && (
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                      <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </div>
                              </td>
                              <td className="py-3 font-medium">{w.user_name}</td>
                              <td className="py-3 text-right">
                                <span className="text-emerald-400 font-semibold">{w.total_tokens.toLocaleString()} tk</span>
                                <span className="text-[10px] ml-1" style={{ color: 'var(--text-muted)' }}>
                                  ({tokensToJPY(w.total_tokens)})
                                </span>
                              </td>
                              <td className="py-3 text-right text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {w.first_paid.slice(0, 10)}
                              </td>
                              <td className="py-3 text-center">
                                {w.already_dm_sent ? (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">送信済み</span>
                                ) : (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-400">未送信</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {whaleChecked.size}名 選択中
                    </div>
                  </div>

                  {/* Message + Send */}
                  <div className="glass-card p-5">
                    <h3 className="text-sm font-bold mb-3">お礼メッセージ</h3>
                    <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                      {'{username}'} はユーザー名に自動置換されます
                    </p>
                    <textarea
                      className="input-glass h-24 resize-none text-sm"
                      value={thankMessage}
                      onChange={e => setThankMessage(e.target.value)}
                      placeholder="お礼メッセージを入力..."
                    />

                    <button onClick={handleThankSend} disabled={thankSending || whaleChecked.size === 0}
                      className="w-full mt-4 py-3 rounded-xl text-sm font-bold text-white transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-50"
                      style={{
                        background: whaleChecked.size > 0
                          ? 'linear-gradient(135deg, #22c55e, #16a34a)'
                          : 'linear-gradient(135deg, #475569, #334155)',
                        boxShadow: whaleChecked.size > 0 ? '0 6px 30px rgba(34,197,94,0.3)' : 'none',
                      }}>
                      {thankSending
                        ? 'キュー登録中...'
                        : `お礼EDMを送信（${whaleChecked.size}件）`
                      }
                    </button>
                  </div>
                </>
              )}

              {/* Empty state */}
              {!whaleLoading && whales.length === 0 && !whaleError && (
                <div className="glass-card p-10 text-center">
                  <p className="text-4xl mb-4 opacity-30">+</p>
                  <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                    「検出する」をクリックして新規太客を検索
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    期間中に初めて課金し、閾値以上のコインを使ったユーザーが表示されます。
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ============ 自動DMタブ ============ */}
      {tab === 'auto' && (
        <div className="space-y-4 anim-fade-up">
          {/* Header */}
          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-bold">自動生成DM</h3>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  配信終了時のお礼DM・離脱ユーザーへのリカバリーDMが自動で候補に追加されます。
                  承認するとChrome拡張で送信されます。
                </p>
              </div>
              <button onClick={loadAutoDMs} disabled={autoLoading}
                className="btn-ghost text-[10px] px-3 py-1.5">
                {autoLoading ? '読込中...' : '再読み込み'}
              </button>
            </div>
          </div>

          {/* Loading */}
          {autoLoading && (
            <div className="glass-card p-5 space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-4">
                  <div className="w-4 h-4 rounded animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  <div className="h-4 w-32 rounded animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  <div className="h-4 w-20 rounded animate-pulse ml-auto" style={{ background: 'var(--bg-card)' }} />
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!autoLoading && autoDMs.length === 0 && (
            <div className="glass-card p-10 text-center">
              <p className="text-4xl mb-4 opacity-30">&#10003;</p>
              <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                承認待ちの自動DMはありません
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                配信終了時やコイン同期後に、お礼DM・離脱DMの候補が自動追加されます。
              </p>
            </div>
          )}

          {/* Auto DM list */}
          {!autoLoading && autoDMs.length > 0 && (
            <>
              {/* Bulk actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setAutoChecked(new Set(autoDMs.map(d => d.id)))}
                  className="btn-ghost text-[10px] px-3 py-1">全選択</button>
                <button
                  onClick={() => setAutoChecked(new Set())}
                  className="btn-ghost text-[10px] px-3 py-1">全解除</button>
                {autoChecked.size > 0 && (
                  <>
                    <button
                      onClick={() => handleApproveAutoDMs(Array.from(autoChecked))}
                      disabled={autoApproving}
                      className="px-4 py-1.5 rounded-lg text-[10px] font-medium text-white disabled:opacity-50"
                      style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}>
                      {autoApproving ? '処理中...' : `承認して送信 (${autoChecked.size}件)`}
                    </button>
                    <button
                      onClick={() => handleDismissAutoDMs(Array.from(autoChecked))}
                      className="px-4 py-1.5 rounded-lg text-[10px] font-medium text-rose-400 border border-rose-500/20 hover:bg-rose-500/10">
                      破棄 ({autoChecked.size}件)
                    </button>
                  </>
                )}
              </div>

              {/* Group by campaign */}
              {(() => {
                const groups = new Map<string, AutoDMItem[]>();
                autoDMs.forEach(d => {
                  const key = d.campaign;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(d);
                });
                return Array.from(groups.entries()).map(([campaign, items]) => {
                  const isThankYou = campaign.startsWith('auto_thankyou');
                  const isScenario = items.some(d => d.template_name?.startsWith('scenario_'));
                  const label = isScenario ? 'シナリオDM' : isThankYou ? 'お礼DM' : '離脱リカバリーDM';
                  const labelColor = isScenario ? 'text-sky-400' : isThankYou ? 'text-emerald-400' : 'text-amber-400';
                  const bgColor = isScenario ? 'rgba(56,189,248,0.04)' : isThankYou ? 'rgba(34,197,94,0.04)' : 'rgba(245,158,11,0.04)';
                  const borderColor = isScenario ? 'rgba(56,189,248,0.15)' : isThankYou ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)';
                  const castName = items[0]?.cast_name || '';
                  const queuedAt = items[0]?.queued_at ? new Date(items[0].queued_at).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                  const hasAI = items.some(d => d.ai_generated);
                  const shouldCollapseGroup = items.length > 10;
                  const isGroupExpanded = autoGroupExpanded.has(campaign);
                  const visibleItems = shouldCollapseGroup && !isGroupExpanded ? items.slice(0, 10) : items;

                  return (
                    <div key={campaign} className="glass-card p-5" style={{ background: bgColor, borderColor }}>
                      <div className="flex items-center gap-3 mb-4">
                        {shouldCollapseGroup && (
                          <button onClick={() => setAutoGroupExpanded(prev => {
                            const next = new Set(prev);
                            if (next.has(campaign)) next.delete(campaign); else next.add(campaign);
                            return next;
                          })}>
                            <span className="text-xs">{isGroupExpanded ? '▼' : '▶'}</span>
                          </button>
                        )}
                        <span className={`text-xs font-bold ${labelColor}`}>{label}</span>
                        {hasAI && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">AI</span>
                        )}
                        {castName && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-400">
                            {castName}
                          </span>
                        )}
                        <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                          {queuedAt} ・ {items.length}件
                        </span>
                      </div>
                      <div className="space-y-2">
                        {visibleItems.map(dm => (
                          <div key={dm.id} className="glass-panel p-3 rounded-xl space-y-2">
                            <div className="flex items-center gap-2">
                              <input type="checkbox" className="accent-sky-400"
                                checked={autoChecked.has(dm.id)}
                                onChange={() => {
                                  setAutoChecked(prev => {
                                    const next = new Set(prev);
                                    if (next.has(dm.id)) next.delete(dm.id); else next.add(dm.id);
                                    return next;
                                  });
                                }} />
                              <span className="font-medium text-xs">{dm.user_name}</span>
                              {dm.cast_name && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400">{dm.cast_name}</span>
                              )}
                              {dm.ai_generated && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">AI生成</span>
                              )}
                              {dm.template_name?.startsWith('scenario_') && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                                  {dm.template_name.replace('scenario_', '').replace(/_step\d+$/, '')}
                                </span>
                              )}
                              <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                                {new Date(dm.queued_at).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>

                            {editingDMId === dm.id ? (
                              <div className="space-y-2">
                                <textarea className="input-glass text-xs h-20 resize-none"
                                  value={editingDMMessage}
                                  onChange={e => setEditingDMMessage(e.target.value)} />
                                <div className="flex gap-2">
                                  <button onClick={() => handleSaveEdit(dm.id)} className="btn-primary text-[10px] px-3 py-1">保存</button>
                                  <button onClick={handleCancelEdit} className="btn-ghost text-[10px] px-3 py-1">キャンセル</button>
                                </div>
                              </div>
                            ) : (
                              <div>
                                <p className="text-xs px-2 py-1.5 rounded whitespace-pre-wrap" style={{ background: 'rgba(15,23,42,0.4)', color: 'var(--text-secondary)' }}>
                                  {dm.message || '(空)'}
                                </p>
                                {dm.ai_reasoning && (
                                  <p className="text-[10px] mt-1 px-2" style={{ color: 'var(--text-muted)' }}>
                                    理由: {dm.ai_reasoning}
                                  </p>
                                )}
                              </div>
                            )}

                            <div className="flex gap-2">
                              <button onClick={() => handleEditDM(dm)} className="btn-ghost text-[10px] px-2 py-1">編集</button>
                              <button onClick={() => handleApproveAutoDMs([dm.id])} className="btn-primary text-[10px] px-2 py-1">承認</button>
                              <button onClick={() => handleDismissAutoDMs([dm.id])} className="text-[10px] px-2 py-1 text-rose-400 hover:text-rose-300">削除</button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {shouldCollapseGroup && !isGroupExpanded && (
                        <button
                          onClick={() => setAutoGroupExpanded(prev => { const next = new Set(prev); next.add(campaign); return next; })}
                          className="w-full text-center py-2 mt-2 text-[10px] hover:bg-white/[0.02] rounded-lg"
                          style={{ color: 'var(--accent-primary)' }}
                        >
                          残り {items.length - 10}件を表示...
                        </button>
                      )}
                    </div>
                  );
                });
              })()}
            </>
          )}
        </div>
      )}

      {/* ============ シナリオタブ ============ */}
      {tab === 'scenario' && (
        <div className="space-y-4 anim-fade-up">
          {/* Scenario explanation */}
          <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
            シナリオは、ユーザーの行動（チップ、入室など）に応じて自動的にDMを送信するワークフローです。
          </p>

          {/* Header */}
          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-bold">DMシナリオ</h3>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  セグメント別の連続DMシナリオ。ゴール（来訪/返信）検出で自動停止します。
                </p>
              </div>
              <button onClick={loadScenarios} disabled={scenarioLoading}
                className="btn-ghost text-[10px] px-3 py-1.5">
                {scenarioLoading ? '読込中...' : '再読み込み'}
              </button>
            </div>
          </div>

          {/* Loading */}
          {scenarioLoading && (
            <div className="glass-card p-5 space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-4">
                  <div className="w-4 h-4 rounded animate-pulse" style={{ background: 'var(--bg-card)' }} />
                  <div className="h-4 w-48 rounded animate-pulse" style={{ background: 'var(--bg-card)' }} />
                </div>
              ))}
            </div>
          )}

          {/* KPI Summary */}
          {!scenarioLoading && enrollments.length > 0 && (
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: 'Active', count: enrollments.filter(e => e.status === 'active').length, color: 'text-sky-400' },
                { label: 'ゴール到達', count: enrollments.filter(e => e.status === 'goal_reached').length, color: 'text-emerald-400' },
                { label: '完了', count: enrollments.filter(e => e.status === 'completed').length, color: 'text-slate-400' },
                { label: 'キャンセル', count: enrollments.filter(e => e.status === 'cancelled').length, color: 'text-amber-400' },
              ].map(kpi => (
                <div key={kpi.label} className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>{kpi.label}</p>
                  <p className={`text-lg font-bold ${kpi.color}`}>{kpi.count}</p>
                </div>
              ))}
            </div>
          )}

          {/* Scenario List */}
          {!scenarioLoading && scenarios.length > 0 && (
            <div className="space-y-3">
              {scenarios.map(sc => {
                const triggerLabels: Record<string, string> = {
                  thankyou_vip: 'VIPお礼',
                  thankyou_regular: '常連お礼',
                  thankyou_first: '初回お礼',
                  churn_recovery: '離脱防止',
                };
                const triggerColors: Record<string, string> = {
                  thankyou_vip: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
                  thankyou_regular: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
                  thankyou_first: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
                  churn_recovery: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
                };
                const scEnrollments = enrollments.filter(e => e.scenario_id === sc.id);
                const activeCount = scEnrollments.filter(e => e.status === 'active').length;
                const goalCount = scEnrollments.filter(e => e.status === 'goal_reached').length;
                const totalCount = scEnrollments.length;
                const goalRate = totalCount > 0 ? Math.round((goalCount / totalCount) * 100) : 0;

                return (
                  <div key={sc.id} className="glass-card p-5">
                    <div className="flex items-center gap-3 mb-3">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${triggerColors[sc.trigger_type] || 'text-slate-400'}`}>
                        {triggerLabels[sc.trigger_type] || sc.trigger_type}
                      </span>
                      <h4 className="text-sm font-bold flex-1">{sc.scenario_name}</h4>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${sc.is_active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-500/10 text-slate-500'}`}>
                        {sc.is_active ? 'ON' : 'OFF'}
                      </span>
                    </div>

                    {/* Steps */}
                    <div className="flex items-center gap-1 mb-3">
                      {sc.steps.map((step, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <div className="glass-panel px-2 py-1 rounded text-[10px]"
                            title={step.template}>
                            Step{step.step}: {step.template}
                            {step.delay_hours > 0 && <span className="ml-1" style={{ color: 'var(--text-muted)' }}>({step.delay_hours}h)</span>}
                          </div>
                          {i < sc.steps.length - 1 && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>→</span>}
                        </div>
                      ))}
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-4 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                      <span>対象: {sc.segment_targets.join(', ')}</span>
                      <span>登録: {totalCount}名</span>
                      <span className="text-sky-400">Active: {activeCount}</span>
                      <span className="text-emerald-400">ゴール: {goalCount} ({goalRate}%)</span>
                      <span>上限: {sc.daily_send_limit}/日</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Empty state */}
          {!scenarioLoading && scenarios.length === 0 && (
            <div className="glass-card p-10 text-center">
              <p className="text-4xl mb-4 opacity-30">&#9881;</p>
              <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                シナリオ未登録
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                マイグレーション041を実行して初期シナリオを登録してください。
              </p>
            </div>
          )}

          {/* Enrollment List */}
          {!scenarioLoading && enrollments.length > 0 && (() => {
            const filteredEnrollments = enrollments.filter(e => scenarioFilter === 'all' || e.status === scenarioFilter);
            const shouldCollapse = filteredEnrollments.length > 10;
            const visibleEnrollments = shouldCollapse && !enrollmentListExpanded ? filteredEnrollments.slice(0, 10) : filteredEnrollments;
            return (
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <button
                  onClick={() => shouldCollapse && setEnrollmentListExpanded(prev => !prev)}
                  className="flex items-center gap-2"
                  style={{ cursor: shouldCollapse ? 'pointer' : 'default' }}
                >
                  {shouldCollapse && <span className="text-xs">{enrollmentListExpanded ? '▼' : '▶'}</span>}
                  <h3 className="text-sm font-bold">エンロールメント ({filteredEnrollments.length}件)</h3>
                </button>
                <div className="flex gap-1">
                  {(['all', 'active', 'goal_reached', 'completed', 'cancelled'] as const).map(f => (
                    <button key={f} onClick={() => { setScenarioFilter(f); setEnrollmentListExpanded(false); }}
                      className={`px-3 py-1 rounded-lg text-[10px] transition-all ${
                        scenarioFilter === f ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-500 hover:text-slate-300'
                      }`}>
                      {f === 'all' ? '全て' : f === 'active' ? 'Active' : f === 'goal_reached' ? 'ゴール' : f === 'completed' ? '完了' : 'キャンセル'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1 max-h-96 overflow-auto">
                {visibleEnrollments.map(e => {
                    const sc = scenarios.find(s => s.id === e.scenario_id);
                    const statusColors: Record<string, string> = {
                      active: 'text-sky-400',
                      goal_reached: 'text-emerald-400',
                      completed: 'text-slate-400',
                      cancelled: 'text-amber-400',
                    };
                    return (
                      <div key={e.id} className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs hover:bg-white/[0.02]"
                        style={{ background: 'rgba(15,23,42,0.3)' }}>
                        <span className={statusColors[e.status] || 'text-slate-500'}>
                          {e.status === 'active' ? '●' : e.status === 'goal_reached' ? '✓' : e.status === 'completed' ? '◎' : '○'}
                        </span>
                        <span className="font-medium w-32 truncate">{e.username}</span>
                        {e.cast_name && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400 truncate max-w-[100px]">
                            {e.cast_name}
                          </span>
                        )}
                        <span className="text-[10px] flex-1 truncate" style={{ color: 'var(--text-muted)' }}>
                          {sc?.scenario_name || ''}
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Step {e.current_step}/{sc?.steps.length || '?'}
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {new Date(e.enrolled_at).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}
                        </span>
                        {e.status === 'goal_reached' && e.goal_reached_at && (
                          <span className="text-[10px] text-emerald-400">
                            到達: {new Date(e.goal_reached_at).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </div>
                    );
                  })}
              </div>
              {shouldCollapse && !enrollmentListExpanded && (
                <button
                  onClick={() => setEnrollmentListExpanded(true)}
                  className="w-full text-center py-2 mt-2 text-[10px] hover:bg-white/[0.02] rounded-lg"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  残り {filteredEnrollments.length - 10}件を表示...
                </button>
              )}
            </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
