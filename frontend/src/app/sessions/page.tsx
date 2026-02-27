'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, msgTypeLabel, getUserLeagueColor, COIN_RATE } from '@/lib/utils';
import type { SpyMessage, Account } from '@/types';

interface AIReport {
  id: string;
  session_id: string;
  output_text: string;
  created_at: string;
  tokens_used?: number;
  cost_usd?: number;
}

// ============================================================
// Types
// ============================================================

/** spy_messages から動的算出したセッション */
interface ComputedSession {
  id: string;
  session_id: string;
  account_id: string;
  cast_name: string;
  title: string | null;
  broadcast_title: string | null;
  started_at: string;
  ended_at: string;
  total_messages: number;
  total_tips: number;
  total_coins: number;
  unique_users: number;
}

/** sessions テーブルから取得した配信タイトル */
interface SessionRecord {
  session_id: string;
  cast_name: string | null;
  broadcast_title: string | null;
  started_at: string;
}

interface UserStat {
  user_name: string;
  msg_count: number;
  tip_total: number;
  user_level: number | null;
}

type MsgFilter = 'all' | 'chat' | 'tip';

/** メッセージ群からセッションサマリーを構築 */
function buildComputedSession(
  accountId: string,
  castName: string,
  msgs: { message_time: string; msg_type: string; user_name: string | null; tokens: number }[],
  broadcastTitle?: string | null,
): ComputedSession {
  const started_at = msgs[0].message_time;
  const ended_at = msgs[msgs.length - 1].message_time;
  const sessionId = `${castName}_${new Date(started_at).getTime()}`;
  return {
    id: sessionId,
    session_id: sessionId,
    account_id: accountId,
    cast_name: castName,
    title: null,
    broadcast_title: broadcastTitle ?? null,
    started_at,
    ended_at,
    total_messages: msgs.length,
    total_tips: msgs.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift').length,
    total_coins: msgs.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift').reduce((s, m) => s + (m.tokens || 0), 0),
    unique_users: new Set(msgs.filter(m => m.user_name).map(m => m.user_name)).size,
  };
}

// ============================================================
// Main Page
// ============================================================

export default function SessionsPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [coinRate, setCoinRate] = useState(COIN_RATE);
  const [castUsernames, setCastUsernames] = useState<string[]>([]);
  const [sessions, setSessions] = useState<ComputedSession[]>([]);
  const [loading, setLoading] = useState(false);

  // Detail panel state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailMessages, setDetailMessages] = useState<SpyMessage[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [excludeCast, setExcludeCast] = useState(true);
  const [msgFilter, setMsgFilter] = useState<MsgFilter>('all');

  // AI Report state
  const [reportMap, setReportMap] = useState<Record<string, AIReport | null>>({});
  const [reportLoading, setReportLoading] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  // Load accounts
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts')
      .select('id, account_name, is_active, cast_usernames, coin_rate, created_at')
      .order('created_at')
      .then(({ data }) => {
        const accs = (data ?? []) as Account[];
        setAccounts(accs);
        if (accs.length > 0) {
          setSelectedAccount(accs[0].id);
          setCoinRate(accs[0].coin_rate ?? 7.7);
          setCastUsernames(accs[0].cast_usernames ?? []);
        }
      });
  }, [user]);

  // Load sessions: spy_messages から5分ギャップ方式で動的算出
  // NOTE: Supabase PostgREST は1リクエスト最大1000行 → ページネーションで全件取得
  useEffect(() => {
    if (!selectedAccount) return;
    setLoading(true);
    setExpandedId(null);

    const acc = accounts.find(a => a.id === selectedAccount);
    if (acc) {
      setCoinRate(acc.coin_rate ?? 7.7);
      setCastUsernames(acc.cast_usernames ?? []);
    }

    const supabase = createClient();
    const since = new Date(Date.now() - 90 * 86400000).toISOString();

    type MsgRow = { cast_name: string; message_time: string; msg_type: string; user_name: string | null; tokens: number };
    const BATCH = 1000;
    const MAX_ROWS = 50000;

    (async () => {
      try {
        // sessions テーブルから broadcast_title を取得（並行）
        const sessionRecordsPromise = supabase.from('sessions')
          .select('session_id, cast_name, broadcast_title, started_at')
          .eq('account_id', selectedAccount)
          .gte('started_at', since)
          .order('started_at', { ascending: false })
          .limit(5000);

        const allMsgs: MsgRow[] = [];
        let offset = 0;

        // ページネーションで全件取得
        while (offset < MAX_ROWS) {
          const { data, error } = await supabase.from('spy_messages')
            .select('cast_name, message_time, msg_type, user_name, tokens')
            .eq('account_id', selectedAccount)
            .gte('message_time', since)
            .order('message_time', { ascending: true })
            .range(offset, offset + BATCH - 1);

          if (error) { console.error('[Sessions] fetch error:', error.message); break; }
          if (!data || data.length === 0) break;
          allMsgs.push(...(data as MsgRow[]));
          if (data.length < BATCH) break; // 最終ページ
          offset += BATCH;
        }

        // sessions テーブルのbroadcast_titleをキャスト名+時間帯でマッチング用に準備
        const { data: sessionRecords } = await sessionRecordsPromise;
        const sessionTitles = (sessionRecords ?? []) as SessionRecord[];

        console.log('[Sessions] Total messages fetched:', allMsgs.length, 'session records:', sessionTitles.length);

        if (allMsgs.length === 0) {
          setSessions([]);
          setLoading(false);
          return;
        }

        // broadcast_title マッチング: キャスト名+時間帯で最も近いsessionsレコードを探す
        const findBroadcastTitle = (cn: string, startedAt: string): string | null => {
          const startMs = new Date(startedAt).getTime();
          let best: string | null = null;
          let bestDiff = Infinity;
          for (const sr of sessionTitles) {
            if (sr.cast_name !== cn || !sr.broadcast_title) continue;
            const diff = Math.abs(new Date(sr.started_at).getTime() - startMs);
            // 30分以内のセッションレコードをマッチ
            if (diff < 30 * 60 * 1000 && diff < bestDiff) {
              bestDiff = diff;
              best = sr.broadcast_title;
            }
          }
          return best;
        };

        // cast_name 別にグループ化
        const byCast = new Map<string, MsgRow[]>();
        for (const msg of allMsgs) {
          const arr = byCast.get(msg.cast_name) || [];
          arr.push(msg);
          byCast.set(msg.cast_name, arr);
        }

        // 5分ギャップでセッション分割
        const computed: ComputedSession[] = [];
        Array.from(byCast.entries()).forEach(([cast, msgs]) => {
          let group: MsgRow[] = [];
          for (let i = 0; i < msgs.length; i++) {
            if (i > 0) {
              const gap = new Date(msgs[i].message_time).getTime()
                        - new Date(msgs[i - 1].message_time).getTime();
              if (gap > 5 * 60 * 1000) {
                if (group.length > 0) {
                  const bt = findBroadcastTitle(cast, group[0].message_time);
                  computed.push(buildComputedSession(selectedAccount, cast, group, bt));
                }
                group = [];
              }
            }
            group.push(msgs[i]);
          }
          if (group.length > 0) {
            const bt = findBroadcastTitle(cast, group[0].message_time);
            computed.push(buildComputedSession(selectedAccount, cast, group, bt));
          }
        });

        computed.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

        console.log('[Sessions] Sessions computed:', computed.length);
        computed.forEach((s, i) => console.log(
          `  [${i}] ${s.cast_name} | ${s.started_at} → ${s.ended_at} | ${s.total_messages} msgs, ${s.total_coins} tk`
        ));

        setSessions(computed);
      } catch (e) {
        console.error('[Sessions] unexpected error:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedAccount, accounts]);

  // Load detail messages when session expanded (cast_name + 時間範囲で取得)
  useEffect(() => {
    if (!expandedId) return;
    setDetailLoading(true);
    setDetailMessages([]);

    const session = sessions.find(s => s.session_id === expandedId);
    if (!session) { setDetailLoading(false); return; }

    const supabase = createClient();
    supabase.from('spy_messages')
      .select('*')
      .eq('account_id', session.account_id)
      .eq('cast_name', session.cast_name)
      .gte('message_time', session.started_at)
      .lte('message_time', session.ended_at)
      .order('message_time', { ascending: true })
      .limit(2000)
      .then(({ data }) => {
        setDetailMessages((data ?? []) as SpyMessage[]);
        setDetailLoading(false);
      });
  }, [expandedId, sessions]);

  // Helper: is this message from the cast?
  const isCastMsg = (m: SpyMessage): boolean => {
    // Check metadata.is_cast flag (set by import script)
    if ((m.metadata as Record<string, unknown>)?.is_cast === true) return true;
    // Check cast_usernames from account settings
    if (castUsernames.length > 0 && m.user_name && castUsernames.includes(m.user_name)) return true;
    // Check cast_name match (the cast's own username often matches cast_name)
    if (m.user_name && m.cast_name && m.user_name === m.cast_name) return true;
    return false;
  };

  // Client-side cast exclusion + msg_type filtering
  const filteredMessages = useMemo(() => {
    let msgs = detailMessages;

    // Cast exclusion
    if (excludeCast) {
      msgs = msgs.filter(m => !isCastMsg(m));
    }

    // msg_type filter
    if (msgFilter === 'tip') return msgs.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift');
    if (msgFilter === 'chat') return msgs.filter(m => m.msg_type === 'chat');
    return msgs;
  }, [detailMessages, excludeCast, castUsernames, msgFilter]);

  // User rankings (respect excludeCast toggle)
  const userStats = useMemo((): UserStat[] => {
    const map = new Map<string, UserStat>();
    for (const m of detailMessages) {
      if (!m.user_name) continue;
      if (excludeCast && isCastMsg(m)) continue;
      const isTipOrGift = m.msg_type === 'tip' || m.msg_type === 'gift';
      const tipTokens = isTipOrGift ? m.tokens : 0;
      const existing = map.get(m.user_name);
      if (existing) {
        existing.msg_count++;
        existing.tip_total += tipTokens;
      } else {
        map.set(m.user_name, {
          user_name: m.user_name,
          msg_count: 1,
          tip_total: tipTokens,
          user_level: (m as unknown as Record<string, unknown>).user_level as number | null ?? null,
        });
      }
    }
    return Array.from(map.values());
  }, [detailMessages, castUsernames, excludeCast]);

  const topByMessages = useMemo(() =>
    [...userStats].sort((a, b) => b.msg_count - a.msg_count).slice(0, 10),
    [userStats]
  );

  const topByCoins = useMemo(() =>
    [...userStats].filter(u => u.tip_total > 0).sort((a, b) => b.tip_total - a.tip_total).slice(0, 10),
    [userStats]
  );

  // AI Report: check for existing report when session expanded
  useEffect(() => {
    if (!expandedId) return;
    // Only fetch once per session_id (check if key exists, not value)
    if (Object.prototype.hasOwnProperty.call(reportMap, expandedId)) return;
    const supabase = createClient();
    supabase.from('ai_reports')
      .select('id, session_id, output_text, created_at, tokens_used, cost_usd')
      .eq('session_id', expandedId)
      .eq('report_type', 'session_analysis')
      .in('account_id', accounts.map(a => a.id))
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        setReportMap(prev => ({
          ...prev,
          [expandedId]: data && data.length > 0 ? data[0] as AIReport : null,
        }));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId]);

  // AI Report: generate (direct Claude API call, no backend needed)
  const generateReport = useCallback(async (sessionId: string, accountId: string) => {
    setReportLoading(sessionId);
    setReportError(null);

    try {
      // Use already-loaded detailMessages (cast excluded)
      const msgs = detailMessages.filter(m => !isCastMsg(m));
      if (msgs.length === 0) throw new Error('セッションにメッセージがありません');

      // Find session info
      const sess = sessions.find(s => s.session_id === sessionId);
      if (!sess) throw new Error('セッション情報が見つかりません');

      // --- Compute stats ---
      const uniqueUsers = new Set(msgs.filter(m => m.user_name).map(m => m.user_name));
      const tipMsgs = msgs.filter(m => (m.msg_type === 'tip' || m.msg_type === 'gift') && m.tokens > 0);
      const totalCoins = tipMsgs.reduce((s, m) => s + m.tokens, 0);
      const totalJPY = Math.round(totalCoins * coinRate);

      // Top tippers
      const tipperMap: Record<string, number> = {};
      for (const m of tipMsgs) {
        tipperMap[m.user_name || '?'] = (tipperMap[m.user_name || '?'] || 0) + m.tokens;
      }
      const topTippers = Object.entries(tipperMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

      // Top chatters
      const chatCounter: Record<string, number> = {};
      for (const m of msgs) {
        if (m.user_name) chatCounter[m.user_name] = (chatCounter[m.user_name] || 0) + 1;
      }
      const topChatters = Object.entries(chatCounter).sort((a, b) => b[1] - a[1]).slice(0, 5);

      // msg_type breakdown
      const typeBreakdown: Record<string, number> = {};
      for (const m of msgs) typeBreakdown[m.msg_type] = (typeBreakdown[m.msg_type] || 0) + 1;

      // 15-min activity slots
      const timeSlots: Record<string, number> = {};
      for (const m of msgs) {
        try {
          const dt = new Date(m.message_time);
          const slot = `${String(dt.getHours()).padStart(2, '0')}:${String(Math.floor(dt.getMinutes() / 15) * 15).padStart(2, '0')}`;
          timeSlots[slot] = (timeSlots[slot] || 0) + 1;
        } catch { /* skip */ }
      }

      // Duration
      const startDt = new Date(sess.started_at);
      const endDt = sess.ended_at ? new Date(sess.ended_at) : new Date(msgs[msgs.length - 1].message_time);
      const durationMin = Math.max(1, Math.round((endDt.getTime() - startDt.getTime()) / 60000));

      // --- Build prompt ---
      const statsText = [
        `【配信統計】`,
        `- 配信時間: ${durationMin}分`,
        `- 総メッセージ数: ${msgs.length}`,
        `- ユニークユーザー数: ${uniqueUsers.size}`,
        `- チップ合計: ${totalCoins}コイン (約¥${totalJPY.toLocaleString()})`,
        `- チップ件数: ${tipMsgs.length}`,
        ``,
        `【トップチッパー】`,
        ...topTippers.map(([name, coins], i) => `  ${i + 1}. ${name}: ${coins}コイン`),
        ``,
        `【発言数ランキング】`,
        ...topChatters.map(([name, count], i) => `  ${i + 1}. ${name}: ${count}発言`),
        ``,
        `【メッセージ種別】`,
        ...Object.entries(typeBreakdown).map(([k, v]) => `  ${k}: ${v}件`),
        ``,
        `【15分ごとのアクティビティ】`,
        ...Object.entries(timeSlots).sort().map(([slot, count]) => `  ${slot}: ${count}件`),
      ].join('\n');

      // Tip messages (all)
      const tipLines = tipMsgs.map(m =>
        `[${m.message_time.slice(11, 16)}] ${m.user_name || '?'}: [${m.tokens}c] ${m.message || ''}`
      );

      // Chat sample: first 30 + last 30
      const chatMsgs = msgs.filter(m => m.msg_type === 'chat');
      const chatFirst = chatMsgs.slice(0, 30);
      const chatLast = chatMsgs.length > 60 ? chatMsgs.slice(-30) : [];
      const chatLines = chatFirst.map(m =>
        `[${m.message_time.slice(11, 16)}] ${m.user_name || '?'}: ${m.message || ''}`
      );
      if (chatLast.length > 0) {
        chatLines.push(`\n... (${chatMsgs.length - 60}件省略) ...\n`);
        chatLast.forEach(m => chatLines.push(
          `[${m.message_time.slice(11, 16)}] ${m.user_name || '?'}: ${m.message || ''}`
        ));
      }

      const userPrompt = [
        statsText,
        ``,
        `【チップメッセージ全件(${tipLines.length}件)】`,
        tipLines.length > 0 ? tipLines.join('\n') : '  (なし)',
        ``,
        `【チャットメッセージサンプル(${chatMsgs.length}件中)】`,
        chatLines.length > 0 ? chatLines.join('\n') : '  (なし)',
        ``,
        `以下のセクションでレポートを生成してください:`,
        ``,
        `## 📊 配信の要約`,
        `配信の概要を3行でまとめてください。`,
        ``,
        `## 🔥 盛り上がりポイント`,
        `チップが集中した時間帯や、会話が盛り上がった瞬間を分析してください。`,
        ``,
        `## 🐋 常連ファンの動向`,
        `よく発言するユーザーの特徴、太客の行動パターンを分析してください。`,
        ``,
        `## 💡 改善提案`,
        `次回の配信に向けた具体的なアドバイスを3つ提示してください。`,
        ``,
        `## 🎯 推奨アクション`,
        `DM送信候補のユーザーや、お礼すべきユーザーをリストアップしてください。理由も添えてください。`,
      ].join('\n');

      // --- Call server-side API route ---
      const supabase = createClient();
      const { data: { session: authSession } } = await supabase.auth.getSession();
      if (!authSession?.access_token) throw new Error('認証セッションが無効です');

      const apiRes = await fetch('/api/ai-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authSession.access_token}`,
        },
        body: JSON.stringify({ prompt: userPrompt }),
      });

      if (!apiRes.ok) {
        const errBody = await apiRes.json().catch(() => ({ error: `HTTP ${apiRes.status}` }));
        throw new Error(errBody.error || `API error: ${apiRes.status}`);
      }

      const apiData = await apiRes.json();
      const reportText = apiData.text;
      const tokensUsed = apiData.tokensUsed || 0;
      const costUsd = apiData.costUsd || 0;

      // --- Save to Supabase ai_reports ---
      const castName = msgs[0]?.cast_name || '';
      const { data: insertData } = await supabase.from('ai_reports').insert({
        account_id: accountId,
        session_id: sessionId,
        cast_name: castName,
        report_type: 'session_analysis',
        output_text: reportText,
        model: 'claude-sonnet',
        tokens_used: tokensUsed,
        cost_usd: costUsd,
      }).select('id, created_at').single();

      setReportMap(prev => ({
        ...prev,
        [sessionId]: {
          id: insertData?.id || '',
          session_id: sessionId,
          output_text: reportText,
          created_at: insertData?.created_at || new Date().toISOString(),
          tokens_used: tokensUsed,
          cost_usd: costUsd,
        },
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'レポート生成に失敗しました';
      setReportError(msg);
    } finally {
      setReportLoading(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailMessages, sessions, coinRate, castUsernames]);

  if (!user) return null;

  const handleToggle = (sessionId: string) => {
    setExpandedId(prev => prev === sessionId ? null : sessionId);
    setMsgFilter('all');
  };

  const duration = (s: ComputedSession) => {
    const mins = Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000);
    if (mins < 1) return '1分未満';
    if (mins < 60) return `${mins}分`;
    return `${Math.floor(mins / 60)}時間${mins % 60}分`;
  };

  const fmtTime = (d: string) =>
    new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const fmtHMS = (d: string) =>
    new Date(d).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            📺 配信セッション
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            過去の配信ログを振り返り・分析
          </p>
        </div>
        {accounts.length > 1 && (
          <select
            value={selectedAccount}
            onChange={e => setSelectedAccount(e.target.value)}
            className="input-glass text-xs py-1.5 px-3 w-48"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.account_name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto space-y-3 pr-1">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
          </div>
        )}

        {!loading && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>セッションがありません</p>
            <p className="text-xs text-center max-w-md" style={{ color: 'var(--text-muted)' }}>
              セッションはChrome拡張の自動検出で記録されます。Chrome拡張が稼働中か確認してください。
            </p>
          </div>
        )}

        {sessions.map(s => {
          const isExpanded = expandedId === s.session_id;
          return (
            <div key={s.id} className="glass-card overflow-hidden">
              {/* Session Card Header */}
              <button
                onClick={() => handleToggle(s.session_id)}
                className="w-full text-left p-5 transition-all duration-200 hover:bg-white/[0.02]"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-bold">
                      {s.title || `${s.cast_name} — ${fmtTime(s.started_at)}`}
                    </h3>
                    {s.broadcast_title && (
                      <span className="text-[11px] px-2 py-0.5 rounded-md truncate max-w-xs"
                        style={{ background: 'rgba(168,85,247,0.1)', color: 'var(--accent-purple)' }}
                        title={s.broadcast_title}>
                        {s.broadcast_title}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (!isExpanded) handleToggle(s.session_id);
                        setTimeout(() => generateReport(s.session_id, s.account_id), isExpanded ? 0 : 500);
                      }}
                      disabled={reportLoading === s.session_id}
                      className="flex-shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg font-medium transition-all hover:brightness-125 cursor-pointer"
                      style={{
                        background: reportMap[s.session_id] ? 'rgba(34,197,94,0.12)' : 'rgba(168,85,247,0.15)',
                        color: reportMap[s.session_id] ? '#22c55e' : '#a855f7',
                        border: `1px solid ${reportMap[s.session_id] ? 'rgba(34,197,94,0.2)' : 'rgba(168,85,247,0.2)'}`,
                      }}
                    >
                      {reportLoading === s.session_id ? (
                        <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : reportMap[s.session_id] ? (
                        'AIレポート済'
                      ) : (
                        'AIレポート'
                      )}
                    </button>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {isExpanded ? '▲ 閉じる' : '▼ 詳細'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                  <span>{fmtTime(s.started_at)}</span>
                  <span>→</span>
                  <span>{s.ended_at ? fmtTime(s.ended_at) : '配信中'}</span>
                  <span className="ml-1 px-2 py-0.5 rounded-md text-[10px] font-semibold"
                    style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                    {duration(s)}
                  </span>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-5 gap-3">
                  <StatCell label="メッセージ" value={s.total_messages.toLocaleString()} />
                  <StatCell label="チップ" value={s.total_tips.toLocaleString()} color="var(--accent-amber)" />
                  <StatCell label="コイン" value={formatTokens(s.total_coins)} color="var(--accent-amber)" />
                  <StatCell label="円換算" value={tokensToJPY(s.total_coins, coinRate)} color="var(--accent-green)" />
                  <StatCell label="ユーザー" value={s.unique_users.toLocaleString()} color="var(--accent-purple)" />
                </div>
              </button>

              {/* Expanded Detail */}
              {isExpanded && (
                <div className="border-t px-5 pb-5" style={{ borderColor: 'var(--border-glass)' }}>
                  {/* Controls */}
                  <div className="flex items-center gap-4 py-4 flex-wrap">
                    {/* msg_type filter */}
                    <div className="flex gap-1">
                      {(['all', 'chat', 'tip'] as MsgFilter[]).map(f => (
                        <button key={f}
                          onClick={() => setMsgFilter(f)}
                          className="text-[11px] px-3 py-1.5 rounded-lg transition-all"
                          style={msgFilter === f ? {
                            background: 'rgba(56,189,248,0.15)',
                            color: 'var(--accent-primary)',
                          } : { color: 'var(--text-muted)' }}
                        >
                          {f === 'all' ? '全部' : f === 'chat' ? '💬 チャット' : '💰 チップ'}
                        </button>
                      ))}
                    </div>

                    {/* Cast exclusion toggle */}
                    <label className="flex items-center gap-2 cursor-pointer text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <div
                        onClick={() => setExcludeCast(!excludeCast)}
                        className="w-9 h-5 rounded-full relative transition-colors cursor-pointer"
                        style={{ background: excludeCast ? 'var(--accent-primary)' : 'rgba(100,116,139,0.4)' }}
                      >
                        <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                          style={{ left: excludeCast ? '18px' : '2px' }} />
                      </div>
                      キャスト除外
                    </label>

                    <span className="text-[10px] ml-auto mr-3" style={{ color: 'var(--text-muted)' }}>
                      {filteredMessages.length} 件表示
                    </span>

                    {/* AI Report Button */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); generateReport(s.session_id, s.account_id); }}
                      disabled={reportLoading === s.session_id}
                      className="flex-shrink-0 flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg font-medium transition-all hover:brightness-125 cursor-pointer"
                      style={{
                        background: reportMap[s.session_id] ? 'rgba(34,197,94,0.12)' : 'rgba(168,85,247,0.15)',
                        color: reportMap[s.session_id] ? '#22c55e' : '#a855f7',
                        border: `1px solid ${reportMap[s.session_id] ? 'rgba(34,197,94,0.2)' : 'rgba(168,85,247,0.2)'}`,
                      }}
                    >
                      {reportLoading === s.session_id ? (
                        <>
                          <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          AI分析中...
                        </>
                      ) : reportMap[s.session_id] ? (
                        '🔄 レポート再生成'
                      ) : (
                        '🤖 AIレポート生成'
                      )}
                    </button>
                  </div>

                  {/* AI Report Error */}
                  {reportError && reportLoading === null && expandedId === s.session_id && (
                    <div className="mb-3 glass-panel p-3 rounded-xl text-xs text-rose-400 border border-rose-500/20">
                      {reportError}
                    </div>
                  )}

                  {/* AI Report Display */}
                  {reportMap[s.session_id] && (
                    <div className="mb-4 glass-panel p-5 rounded-xl" style={{ borderLeft: '3px solid #a855f7' }}>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-xs font-bold flex items-center gap-2" style={{ color: '#a855f7' }}>
                          🤖 AIセッションレポート
                        </h4>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {new Date(reportMap[s.session_id]!.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                        </span>
                      </div>
                      <div className="text-xs leading-relaxed space-y-3" style={{ color: 'var(--text-secondary)' }}>
                        {reportMap[s.session_id]!.output_text.split('\n').map((line, li) => {
                          if (line.startsWith('## ')) {
                            return (
                              <h5 key={li} className="text-sm font-bold mt-4 mb-1" style={{ color: 'var(--text-primary)' }}>
                                {line.replace('## ', '')}
                              </h5>
                            );
                          }
                          if (line.startsWith('- ')) {
                            return (
                              <p key={li} className="pl-3" style={{ borderLeft: '2px solid rgba(168,85,247,0.3)' }}>
                                {line.replace('- ', '')}
                              </p>
                            );
                          }
                          if (line.trim() === '') return <div key={li} className="h-1" />;
                          return <p key={li}>{line}</p>;
                        })}
                      </div>
                      {reportMap[s.session_id]!.tokens_used && (
                        <p className="text-[10px] mt-3 pt-2 border-t" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-glass)' }}>
                          Tokens: {reportMap[s.session_id]!.tokens_used?.toLocaleString()} / Cost: ${reportMap[s.session_id]!.cost_usd?.toFixed(4)}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Viewer Stats Chart */}
                  <ViewerChart session={s} />

                  {/* Two column: Messages + Rankings */}
                  <div className="flex gap-4">
                    {/* Messages list */}
                    <div className="flex-1 overflow-auto max-h-[500px] space-y-0.5 pr-2">
                      {detailLoading ? (
                        <p className="text-xs py-8 text-center" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
                      ) : filteredMessages.length === 0 ? (
                        <p className="text-xs py-8 text-center" style={{ color: 'var(--text-muted)' }}>メッセージなし</p>
                      ) : (
                        filteredMessages.map(m => (
                          <div key={m.id} className="flex items-start gap-2 py-1.5 px-2 rounded-lg hover:bg-white/[0.02] text-xs">
                            <span className="flex-shrink-0 w-14 text-right font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {fmtHMS(m.message_time)}
                            </span>
                            <span className="flex-shrink-0 w-4 text-center">{msgTypeLabel(m.msg_type)}</span>
                            <span className="flex-shrink-0 w-28 truncate font-semibold"
                              style={{ color: m.user_name ? getUserLeagueColor((m as unknown as Record<string, unknown>).user_level as number | null) : 'var(--text-muted)' }}>
                              {m.user_name || 'SYSTEM'}
                            </span>
                            <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                              {m.tokens > 0 && (
                                <span className="font-semibold mr-1.5" style={{ color: 'var(--accent-amber)' }}>
                                  {m.tokens}c
                                </span>
                              )}
                              {m.message || ''}
                            </span>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Rankings sidebar */}
                    <div className="w-60 flex-shrink-0 space-y-4">
                      {/* By messages */}
                      <div className="glass-panel p-3 rounded-xl">
                        <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                          発言数ランキング
                        </p>
                        <div className="space-y-1.5">
                          {topByMessages.map((u, i) => (
                            <div key={u.user_name} className="flex items-center gap-2 text-[11px]">
                              <span className="w-4 text-right font-mono" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                              <span className="flex-1 truncate font-medium" style={{ color: getUserLeagueColor(u.user_level) }}>{u.user_name}</span>
                              <span style={{ color: 'var(--accent-primary)' }}>{u.msg_count}</span>
                            </div>
                          ))}
                          {topByMessages.length === 0 && (
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>メッセージランキングデータがありません</p>
                          )}
                        </div>
                      </div>

                      {/* By coins */}
                      <div className="glass-panel p-3 rounded-xl">
                        <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                          チップ額ランキング
                        </p>
                        <div className="space-y-1.5">
                          {topByCoins.map((u, i) => (
                            <div key={u.user_name} className="flex items-center gap-2 text-[11px]">
                              <span className="w-4 text-right font-mono" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                              <span className="flex-1 truncate font-medium" style={{ color: getUserLeagueColor(u.user_level) }}>{u.user_name}</span>
                              <span style={{ color: 'var(--accent-amber)' }}>{u.tip_total}c</span>
                            </div>
                          ))}
                          {topByCoins.length === 0 && (
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>コインランキングデータがありません</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="glass-panel p-2.5 rounded-xl text-center">
      <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-sm font-bold" style={{ color: color || 'var(--text-primary)' }}>{value}</p>
    </div>
  );
}

// ============================================================
// Viewer Chart
// ============================================================

interface ViewerStat {
  total: number | null;
  coin_users: number | null;
  others: number | null;
  recorded_at: string;
}

function ViewerChart({ session }: { session: ComputedSession }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<ViewerStat[]>([]);
  const [summary, setSummary] = useState({ max: 0, min: 0, avg: 0, count: 0 });
  const [loading, setLoading] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; stat: ViewerStat } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const supabase = createClient();

    let query = supabase.from('viewer_stats')
      .select('total, coin_users, others, recorded_at')
      .eq('account_id', session.account_id)
      .eq('cast_name', session.cast_name)
      .gte('recorded_at', session.started_at)
      .order('recorded_at');

    if (session.ended_at) {
      query = query.lte('recorded_at', session.ended_at);
    }

    query.limit(500).then(({ data }) => {
      const d = (data ?? []) as ViewerStat[];
      setStats(d);
      const totals = d.map(s => s.total).filter((v): v is number => v != null);
      setSummary({
        count: d.length,
        max: totals.length ? Math.max(...totals) : 0,
        min: totals.length ? Math.min(...totals) : 0,
        avg: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
      });
      setLoading(false);
    });
  }, [open, session]);

  const fmtT = (d: string) =>
    new Date(d).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-semibold py-2 transition-colors hover:text-white"
        style={{ color: 'var(--text-muted)' }}
      >
        <span>{open ? '▼' : '▶'}</span>
        <span>👥 視聴者数推移</span>
      </button>

      {open && (
        <div className="mt-2">
          {loading ? (
            <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
          ) : stats.length === 0 ? (
            <div className="glass-panel p-4 rounded-xl text-center">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                視聴者数データなし — Chrome拡張でリアルタイム取得できます
              </p>
            </div>
          ) : (
            <>
              {/* Summary stats */}
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div className="glass-panel p-2.5 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>最大</p>
                  <p className="text-sm font-bold">{summary.max}</p>
                </div>
                <div className="glass-panel p-2.5 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>平均</p>
                  <p className="text-sm font-bold">{summary.avg}</p>
                </div>
                <div className="glass-panel p-2.5 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>最小</p>
                  <p className="text-sm font-bold">{summary.min}</p>
                </div>
                <div className="glass-panel p-2.5 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>記録数</p>
                  <p className="text-sm font-bold">{summary.count}</p>
                </div>
              </div>

              {/* SVG Chart */}
              <div className="glass-panel p-4 rounded-xl mb-4 relative"
                onMouseLeave={() => setTooltip(null)}>
                <ViewerSVG stats={stats} onHover={setTooltip} />
                {tooltip && (
                  <div className="absolute z-10 px-3 py-2 rounded-lg text-[10px] pointer-events-none"
                    style={{
                      left: Math.min(tooltip.x, 400),
                      top: tooltip.y - 60,
                      background: 'rgba(0,0,0,0.9)',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}>
                    <p className="font-semibold mb-1">{fmtT(tooltip.stat.recorded_at)}</p>
                    <p>合計: <span className="font-bold text-white">{tooltip.stat.total ?? '-'}</span></p>
                    <p>コイン有: <span className="font-bold" style={{ color: '#FFD700' }}>{tooltip.stat.coin_users ?? '-'}</span></p>
                    <p>その他: <span className="font-bold" style={{ color: '#9CA3AF' }}>{tooltip.stat.others ?? '-'}</span></p>
                  </div>
                )}
                {/* Legend */}
                <div className="flex gap-4 mt-3 justify-center text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  <span><span className="inline-block w-3 h-0.5 mr-1" style={{ background: '#fff' }} />合計</span>
                  <span><span className="inline-block w-3 h-0.5 mr-1" style={{ background: '#FFD700' }} />コイン有り</span>
                  <span><span className="inline-block w-3 h-0.5 mr-1" style={{ background: '#9CA3AF' }} />その他</span>
                </div>
              </div>

              {/* Data table (collapsible) */}
              <button
                onClick={() => setTableOpen(!tableOpen)}
                className="text-[10px] mb-2 transition-colors hover:text-white"
                style={{ color: 'var(--text-muted)' }}
              >
                {tableOpen ? '▼ データテーブルを閉じる' : '▶ データテーブルを表示'}
              </button>
              {tableOpen && (
                <div className="glass-panel rounded-xl overflow-auto max-h-48">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                        <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>時刻</th>
                        <th className="text-right px-3 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>合計</th>
                        <th className="text-right px-3 py-2 font-medium" style={{ color: '#FFD700' }}>コイン有</th>
                        <th className="text-right px-3 py-2 font-medium" style={{ color: '#9CA3AF' }}>その他</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((s, i) => (
                        <tr key={i} className="border-b last:border-0" style={{ borderColor: 'var(--border-glass)' }}>
                          <td className="px-3 py-1.5 font-mono">{fmtT(s.recorded_at)}</td>
                          <td className="px-3 py-1.5 text-right font-semibold">{s.total ?? '-'}</td>
                          <td className="px-3 py-1.5 text-right" style={{ color: '#FFD700' }}>{s.coin_users ?? '-'}</td>
                          <td className="px-3 py-1.5 text-right" style={{ color: '#9CA3AF' }}>{s.others ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// SVG Line Chart
// ============================================================

function ViewerSVG({ stats, onHover }: {
  stats: ViewerStat[];
  onHover: (t: { x: number; y: number; stat: ViewerStat } | null) => void;
}) {
  const W = 600;
  const H = 180;
  const PAD = { top: 10, right: 10, bottom: 25, left: 40 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const allVals = stats.flatMap(s => [s.total, s.coin_users, s.others].filter((v): v is number => v != null));
  const maxY = Math.max(...allVals, 1) * 1.1;

  const xOf = (i: number) => PAD.left + (stats.length > 1 ? (i / (stats.length - 1)) * cw : cw / 2);
  const yOf = (v: number | null) => v != null ? PAD.top + ch - (v / maxY) * ch : null;

  const makeLine = (key: 'total' | 'coin_users' | 'others') => {
    const points: string[] = [];
    stats.forEach((s, i) => {
      const y = yOf(s[key]);
      if (y != null) points.push(`${xOf(i)},${y}`);
    });
    return points.join(' ');
  };

  // Y-axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(p => ({
    y: PAD.top + ch - p * ch,
    label: Math.round(maxY * p).toString(),
  }));

  // X-axis ticks (show ~6 labels)
  const step = Math.max(1, Math.floor(stats.length / 6));
  const xTicks = stats.filter((_, i) => i % step === 0 || i === stats.length - 1).map((s, _, arr) => ({
    x: xOf(stats.indexOf(s)),
    label: new Date(s.recorded_at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }),
  }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: '200px' }}>
      {/* Grid lines */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y}
            stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
          <text x={PAD.left - 5} y={t.y + 3} textAnchor="end"
            fill="rgba(255,255,255,0.3)" fontSize={9}>{t.label}</text>
        </g>
      ))}

      {/* X labels */}
      {xTicks.map((t, i) => (
        <text key={i} x={t.x} y={H - 5} textAnchor="middle"
          fill="rgba(255,255,255,0.3)" fontSize={9}>{t.label}</text>
      ))}

      {/* Lines */}
      <polyline points={makeLine('others')} fill="none" stroke="#9CA3AF" strokeWidth={1.5} strokeOpacity={0.6} />
      <polyline points={makeLine('coin_users')} fill="none" stroke="#FFD700" strokeWidth={1.5} strokeOpacity={0.8} />
      <polyline points={makeLine('total')} fill="none" stroke="#ffffff" strokeWidth={2} />

      {/* Hover dots */}
      {stats.map((s, i) => {
        const y = yOf(s.total);
        if (y == null) return null;
        return (
          <circle key={i} cx={xOf(i)} cy={y} r={3}
            fill="transparent" stroke="transparent" strokeWidth={12}
            style={{ cursor: 'pointer' }}
            onMouseEnter={(e) => {
              const rect = (e.target as SVGElement).closest('svg')?.getBoundingClientRect();
              if (rect) onHover({ x: xOf(i), y: y, stat: s });
            }}
          />
        );
      })}
    </svg>
  );
}
