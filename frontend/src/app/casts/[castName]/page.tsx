'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { ChatMessage } from '@/components/chat-message';
import { formatTokens, tokensToJPY, timeAgo, formatJST } from '@/lib/utils';
import type { RegisteredCast } from '@/types';

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

interface SessionGroup {
  date: string;
  messages: number;
  tips: number;
  coins: number;
  users: Set<string>;
  firstMsg: string;
  lastMsg: string;
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

const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: 'overview',  icon: '📊', label: '概要' },
  { key: 'sessions',  icon: '📺', label: '配信' },
  { key: 'dm',        icon: '💬', label: 'DM' },
  { key: 'analytics', icon: '📈', label: '分析' },
  { key: 'sales',     icon: '💰', label: '売上' },
  { key: 'realtime',  icon: '👁', label: 'リアルタイム' },
];

/* ============================================================
   Inner Component (uses useSearchParams)
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

  // State
  const [castInfo, setCastInfo] = useState<RegisteredCast | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [stats, setStats] = useState<CastStatsData | null>(null);
  const [fans, setFans] = useState<FanItem[]>([]);
  const [sessions, setSessions] = useState<SessionGroup[]>([]);
  const [loading, setLoading] = useState(true);

  // DM state
  const [dmLogs, setDmLogs] = useState<DMLogItem[]>([]);
  const [dmTargets, setDmTargets] = useState<Set<string>>(new Set());
  const [dmMessage, setDmMessage] = useState('');
  const [dmCampaign, setDmCampaign] = useState('');
  const [dmSending, setDmSending] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  const [dmResult, setDmResult] = useState<{ count: number; batch_id: string } | null>(null);

  // Realtime (only active on realtime tab)
  const { messages: realtimeMessages, isConnected } = useRealtimeSpy({
    castName,
    enabled: !!user && activeTab === 'realtime',
  });

  // Tab switch
  const setTab = useCallback((tab: TabKey) => {
    router.push(`/casts/${encodeURIComponent(castName)}?tab=${tab}`, { scroll: false });
  }, [router, castName]);

  // ============================================================
  // Load cast info + account
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
      .then(({ data }) => {
        setCastInfo(data as RegisteredCast | null);
      });
  }, [accountId, castName, sb]);

  // ============================================================
  // Load stats via RPC
  // ============================================================
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);

    Promise.all([
      sb.rpc('get_cast_stats', {
        p_account_id: accountId,
        p_cast_names: [castName],
      }),
      sb.rpc('get_cast_fans', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_limit: 10,
      }),
    ]).then(([statsRes, fansRes]) => {
      const statsData = statsRes.data as CastStatsData[] | null;
      if (statsData && statsData.length > 0) {
        setStats(statsData[0]);
      }
      setFans((fansRes.data || []) as FanItem[]);
      setLoading(false);
    });
  }, [accountId, castName, sb]);

  // ============================================================
  // Load sessions (spy_messages grouped by date)
  // ============================================================
  useEffect(() => {
    if (!accountId || (activeTab !== 'overview' && activeTab !== 'sessions')) return;

    sb.from('spy_messages')
      .select('message_time, msg_type, tokens, user_name')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('message_time', { ascending: false })
      .limit(5000)
      .then(({ data }) => {
        if (!data) { setSessions([]); return; }

        // 日別グルーピング (JST)
        const dayMap = new Map<string, SessionGroup>();
        for (const msg of data) {
          const d = new Date(msg.message_time);
          const jstDate = new Date(d.getTime() + 9 * 60 * 60 * 1000);
          const dateKey = jstDate.toISOString().split('T')[0];

          if (!dayMap.has(dateKey)) {
            dayMap.set(dateKey, {
              date: dateKey,
              messages: 0,
              tips: 0,
              coins: 0,
              users: new Set(),
              firstMsg: msg.message_time,
              lastMsg: msg.message_time,
            });
          }
          const g = dayMap.get(dateKey)!;
          g.messages++;
          if (msg.msg_type === 'tip' || msg.msg_type === 'gift') {
            g.tips++;
            g.coins += msg.tokens || 0;
          }
          if (msg.user_name) g.users.add(msg.user_name);
          if (msg.message_time < g.firstMsg) g.firstMsg = msg.message_time;
          if (msg.message_time > g.lastMsg) g.lastMsg = msg.message_time;
        }

        setSessions(
          Array.from(dayMap.values()).sort((a, b) => b.date.localeCompare(a.date))
        );
      });
  }, [accountId, castName, activeTab, sb]);

  // ============================================================
  // Load DM logs
  // ============================================================
  useEffect(() => {
    if (!accountId || activeTab !== 'dm') return;

    sb.from('dm_send_log')
      .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        setDmLogs((data || []) as DMLogItem[]);
      });
  }, [accountId, activeTab, sb]);

  // ============================================================
  // DM send handler
  // ============================================================
  const handleDmSend = useCallback(async () => {
    if (dmTargets.size === 0 || !dmMessage.trim() || !accountId) return;
    setDmSending(true);
    setDmError(null);
    setDmResult(null);

    try {
      const usernames = Array.from(dmTargets);
      const { data, error: rpcErr } = await sb.rpc('create_dm_batch', {
        p_account_id: accountId,
        p_targets: usernames,
        p_message: dmMessage,
        p_template_name: null,
      });

      if (rpcErr) throw rpcErr;
      if (data?.error) { setDmError(data.error); setDmSending(false); return; }

      const bid = dmCampaign.trim()
        ? `${dmCampaign.trim()}_${data.batch_id}`
        : data.batch_id;

      // campaignタグを更新
      if (dmCampaign.trim()) {
        await sb.from('dm_send_log')
          .update({ campaign: bid })
          .eq('campaign', data.batch_id);
      }

      setDmResult({ count: data.count || usernames.length, batch_id: bid });
      setDmTargets(new Set());
      setDmMessage('');
      setDmCampaign('');

      // ログ再取得
      const { data: logs } = await sb.from('dm_send_log')
        .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(200);
      setDmLogs((logs || []) as DMLogItem[]);
    } catch (e: unknown) {
      setDmError(e instanceof Error ? e.message : String(e));
    }
    setDmSending(false);
  }, [dmTargets, dmMessage, dmCampaign, accountId, sb]);

  // Toggle DM target
  const toggleTarget = useCallback((username: string) => {
    setDmTargets(prev => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  }, []);

  const selectAllFans = useCallback(() => {
    setDmTargets(new Set(fans.map(f => f.user_name)));
  }, [fans]);

  if (!user) return null;

  return (
    <div className="space-y-4 anim-fade-up">
      {/* Header */}
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

        {/* Tab navigation */}
        <div className="flex gap-1 mt-4 flex-wrap">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className="text-[11px] px-3 py-1.5 rounded-lg font-medium transition-all"
              style={{
                background: activeTab === t.key ? 'rgba(56,189,248,0.15)' : 'transparent',
                color: activeTab === t.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                border: activeTab === t.key ? '1px solid rgba(56,189,248,0.25)' : '1px solid transparent',
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {loading && activeTab !== 'realtime' ? (
        <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>
          読み込み中...
        </div>
      ) : (
        <>
          {/* ============ OVERVIEW TAB ============ */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Stats cards */}
              <div className="lg:col-span-2 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      {stats?.total_messages.toLocaleString() || 0}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>総メッセージ</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--accent-amber)' }}>
                      {formatTokens(stats?.total_coins || 0)}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>総チップ</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>
                      {tokensToJPY(stats?.total_coins || 0, coinRate)}
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>推定売上</p>
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
                        <div key={s.date} className="glass-panel p-3 flex items-center justify-between">
                          <div>
                            <p className="text-xs font-semibold">{s.date}</p>
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {s.messages} msg / {s.users.size} users
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-bold" style={{ color: 'var(--accent-amber)' }}>
                              {formatTokens(s.coins)}
                            </p>
                            <p className="text-[10px]" style={{ color: 'var(--accent-green)' }}>
                              {tokensToJPY(s.coins, coinRate)}
                            </p>
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
                          <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                            {f.total_tokens.toLocaleString()} tk
                          </span>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            {f.msg_count} msg
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============ SESSIONS TAB ============ */}
          {activeTab === 'sessions' && (
            <div className="glass-card overflow-hidden">
              {sessions.length === 0 ? (
                <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
                  配信セッションデータなし
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}>
                      <th className="text-left px-5 py-3 font-semibold">日付</th>
                      <th className="text-right px-4 py-3 font-semibold">メッセージ</th>
                      <th className="text-right px-4 py-3 font-semibold">チップ数</th>
                      <th className="text-right px-4 py-3 font-semibold">コイン</th>
                      <th className="text-right px-4 py-3 font-semibold">売上</th>
                      <th className="text-right px-4 py-3 font-semibold">ユーザー</th>
                      <th className="text-right px-5 py-3 font-semibold">時間帯</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map(s => (
                      <tr key={s.date} className="text-xs hover:bg-white/[0.02] transition-colors"
                        style={{ borderBottom: '1px solid var(--border-glass)' }}>
                        <td className="px-5 py-3 font-semibold">{s.date}</td>
                        <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                          {s.messages.toLocaleString()}
                        </td>
                        <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                          {s.tips}
                        </td>
                        <td className="text-right px-4 py-3 font-semibold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                          {formatTokens(s.coins)}
                        </td>
                        <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--accent-green)' }}>
                          {tokensToJPY(s.coins, coinRate)}
                        </td>
                        <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--accent-purple, #a855f7)' }}>
                          {s.users.size}
                        </td>
                        <td className="text-right px-5 py-3" style={{ color: 'var(--text-muted)' }}>
                          {formatJST(s.firstMsg).split(' ')[1]?.slice(0, 5)} - {formatJST(s.lastMsg).split(' ')[1]?.slice(0, 5)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ============ DM TAB ============ */}
          {activeTab === 'dm' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* DM Send Form */}
              <div className="lg:col-span-2 space-y-4">
                <div className="glass-card p-5">
                  <h3 className="text-sm font-bold mb-4">💬 DM送信</h3>

                  {/* Campaign tag */}
                  <div className="mb-3">
                    <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                      style={{ color: 'var(--text-muted)' }}>キャンペーンタグ</label>
                    <input type="text" value={dmCampaign} onChange={e => setDmCampaign(e.target.value)}
                      className="input-glass text-xs w-full" placeholder="例: 2月バレンタイン復帰DM" />
                  </div>

                  {/* Message */}
                  <div className="mb-3">
                    <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                      style={{ color: 'var(--text-muted)' }}>
                      メッセージ <span style={{ color: 'var(--accent-pink)' }}>*</span>
                    </label>
                    <textarea value={dmMessage} onChange={e => setDmMessage(e.target.value)}
                      className="input-glass text-xs w-full h-24 resize-none"
                      placeholder="メッセージを入力... {username}でユーザー名置換" />
                  </div>

                  {/* Target count + send */}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      選択中: <span className="font-bold text-white">{dmTargets.size}</span> 名
                    </span>
                    <div className="flex gap-2">
                      <button onClick={selectAllFans} className="btn-ghost text-[10px] py-1 px-3">
                        全選択
                      </button>
                      <button onClick={handleDmSend}
                        disabled={dmSending || dmTargets.size === 0 || !dmMessage.trim()}
                        className="btn-primary text-xs py-1.5 px-5 disabled:opacity-50">
                        {dmSending ? '送信中...' : '送信'}
                      </button>
                    </div>
                  </div>

                  {dmError && (
                    <p className="mt-2 text-xs" style={{ color: 'var(--accent-pink)' }}>{dmError}</p>
                  )}
                  {dmResult && (
                    <p className="mt-2 text-xs" style={{ color: 'var(--accent-green)' }}>
                      {dmResult.count}件をキューに登録しました (batch: {dmResult.batch_id})
                    </p>
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
                            <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                              {log.message}
                            </p>
                          </div>
                          <div className="flex-shrink-0 ml-2 text-right">
                            <span className={`text-[10px] font-bold ${
                              log.status === 'success' ? 'text-emerald-400' :
                              log.status === 'error' ? 'text-rose-400' :
                              log.status === 'sending' ? 'text-amber-400' : 'text-slate-400'
                            }`}>
                              {log.status}
                            </span>
                            <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                              {timeAgo(log.queued_at)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Fan list for targeting */}
              <div className="glass-card p-4">
                <h3 className="text-sm font-bold mb-3">ターゲット選択</h3>
                <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
                  {castName}のファン（チップ額順）
                </p>
                {fans.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>ファンデータなし</p>
                ) : (
                  <div className="space-y-1">
                    {fans.map(f => {
                      const checked = dmTargets.has(f.user_name);
                      return (
                        <button key={f.user_name} onClick={() => toggleTarget(f.user_name)}
                          className={`w-full text-left p-2 rounded-lg text-[11px] transition-all ${
                            checked ? 'border' : 'hover:bg-white/[0.03]'
                          }`}
                          style={checked ? {
                            background: 'rgba(56,189,248,0.08)',
                            borderColor: 'rgba(56,189,248,0.2)',
                          } : {}}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className={`w-3 h-3 rounded-sm border ${
                                checked ? 'bg-sky-500 border-sky-500' : 'border-slate-600'
                              }`} />
                              <span className="font-medium">{f.user_name}</span>
                            </div>
                            <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                              {f.total_tokens.toLocaleString()} tk
                            </span>
                          </div>
                          <p className="text-[9px] ml-5" style={{ color: 'var(--text-muted)' }}>
                            {f.msg_count} msg / 最終 {timeAgo(f.last_seen)}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============ ANALYTICS TAB (placeholder) ============ */}
          {activeTab === 'analytics' && (
            <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>
              <p className="text-sm">分析機能は準備中です</p>
              <p className="text-xs mt-2">ファン分析、チャット分析、スコアリングなどを実装予定</p>
            </div>
          )}

          {/* ============ SALES TAB (placeholder) ============ */}
          {activeTab === 'sales' && (
            <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>
              <p className="text-sm">売上機能は準備中です</p>
              <p className="text-xs mt-2">コイン履歴、有料ユーザー一覧、売上推移グラフを実装予定</p>
            </div>
          )}

          {/* ============ REALTIME TAB ============ */}
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
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                      リアルタイムメッセージを待機中...
                    </p>
                  </div>
                ) : (
                  realtimeMessages.map(msg => (
                    <ChatMessage key={msg.id} message={msg} />
                  ))
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ============================================================
   Page Component (Suspense wrapper for useSearchParams)
   ============================================================ */
export default function CastDetailPage() {
  return (
    <Suspense fallback={
      <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>
        読み込み中...
      </div>
    }>
      <CastDetailInner />
    </Suspense>
  );
}
