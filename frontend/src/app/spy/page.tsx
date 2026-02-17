'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { ChatMessage } from '@/components/chat-message';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, timeAgo } from '@/lib/utils';
import type { SpyMessage } from '@/types';

/* ============================================================
   Types
   ============================================================ */
interface ViewerStat {
  total: number | null;
  coin_users: number | null;
  others: number | null;
  recorded_at: string;
}

// メッセージタイプフィルタ定義
const MSG_TYPE_FILTERS = [
  { key: 'chat',    label: '💬 チャット', types: ['chat'] },
  { key: 'tip',     label: '🪙 チップ',   types: ['tip', 'gift'] },
  { key: 'speech',  label: '🎤 音声',     types: ['speech'] },
  { key: 'enter',   label: '🚪 入退室',   types: ['enter', 'leave'] },
  { key: 'system',  label: '⚙️ システム', types: ['goal', 'viewer_count', 'system'] },
] as const;

type FilterKey = typeof MSG_TYPE_FILTERS[number]['key'];

/* ============================================================
   Main Page
   ============================================================ */
export default function SpyPage() {
  const { user } = useAuth();
  const [selectedCast, setSelectedCast] = useState<string | undefined>(undefined);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll toggle
  const [autoScroll, setAutoScroll] = useState(true);

  // Search filter
  const [searchQuery, setSearchQuery] = useState('');

  // Message type filter (all ON by default)
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(
    () => new Set(MSG_TYPE_FILTERS.map(f => f.key))
  );

  // Status panel
  const [sessionStart] = useState(() => new Date());
  const [elapsedStr, setElapsedStr] = useState('00:00:00');
  const [lastMsgAgo, setLastMsgAgo] = useState('--');

  // Viewer stats
  const [latestViewer, setLatestViewer] = useState<ViewerStat | null>(null);

  // Side panel collapse (mobile)
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  // Whisper: accountId for sending
  const [accountId, setAccountId] = useState<string | null>(null);
  const [whisperText, setWhisperText] = useState('');
  const [whisperTemplate, setWhisperTemplate] = useState<string | null>(null);
  const [whisperSending, setWhisperSending] = useState(false);
  const whisperSbRef = useRef(createClient());

  // Cast visibility toggle (hidden casts)
  const [hiddenCasts, setHiddenCasts] = useState<Set<string>>(new Set());
  const [deletingCast, setDeletingCast] = useState<string | null>(null);

  // Cast registration (registered_casts)
  const [registeredCastNames, setRegisteredCastNames] = useState<Set<string>>(new Set());
  const [registeringCast, setRegisteringCast] = useState<string | null>(null);

  const { messages, allMessages, castNames, isConnected, insertDemoData, deleteCastMessages } = useRealtimeSpy({
    castName: selectedCast,
    enabled: !!user,
  });

  // Whisper: accountId取得 + registered_casts取得
  useEffect(() => {
    if (!user) return;
    whisperSbRef.current.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) {
        setAccountId(data.id);
        // 登録済みキャスト名を取得
        whisperSbRef.current
          .from('registered_casts')
          .select('cast_name')
          .eq('account_id', data.id)
          .eq('is_active', true)
          .then(({ data: casts }) => {
            if (casts) {
              setRegisteredCastNames(new Set(casts.map(c => c.cast_name)));
            }
          });
      }
    });
  }, [user]);

  // ============================================================
  // Auto-scroll on new messages
  // ============================================================
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, autoScroll]);

  // ============================================================
  // Elapsed time counter
  // ============================================================
  useEffect(() => {
    const timer = setInterval(() => {
      const diff = Date.now() - sessionStart.getTime();
      const h = String(Math.floor(diff / 3600000)).padStart(2, '0');
      const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
      const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
      setElapsedStr(`${h}:${m}:${s}`);
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStart]);

  // ============================================================
  // Last message relative time updater
  // ============================================================
  useEffect(() => {
    const timer = setInterval(() => {
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        setLastMsgAgo(timeAgo(last.message_time));
      } else {
        setLastMsgAgo('--');
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [messages]);

  // ============================================================
  // Load latest viewer stats
  // ============================================================
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('viewer_stats')
      .select('total, coin_users, others, recorded_at')
      .order('recorded_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) setLatestViewer(data[0] as ViewerStat);
      });

    const interval = setInterval(() => {
      supabase.from('viewer_stats')
        .select('total, coin_users, others, recorded_at')
        .order('recorded_at', { ascending: false })
        .limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) setLatestViewer(data[0] as ViewerStat);
        });
    }, 30000);
    return () => clearInterval(interval);
  }, [user]);

  // ============================================================
  // Filtered messages (hidden casts + msg_type filter + search)
  // ============================================================
  const allFilterTypes = useMemo(() => {
    const types = new Set<string>();
    for (const f of MSG_TYPE_FILTERS) {
      if (activeFilters.has(f.key)) {
        f.types.forEach(t => types.add(t));
      }
    }
    return types;
  }, [activeFilters]);

  const filteredMessages = useMemo(() => {
    let filtered = messages;
    // 非表示キャストのメッセージを除外
    if (hiddenCasts.size > 0) {
      filtered = filtered.filter(m => !hiddenCasts.has(m.cast_name));
    }
    // msg_typeフィルタ
    if (activeFilters.size < MSG_TYPE_FILTERS.length) {
      filtered = filtered.filter(m => allFilterTypes.has(m.msg_type));
    }
    // テキスト検索
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(m =>
        (m.user_name?.toLowerCase().includes(q)) ||
        (m.message?.toLowerCase().includes(q))
      );
    }
    return filtered;
  }, [messages, searchQuery, hiddenCasts, activeFilters, allFilterTypes]);

  // ============================================================
  // Today's cumulative stats (uses allMessages for accurate totals)
  // ============================================================
  const todayStats = useMemo(() => {
    const totalMessages = allMessages.length;
    const totalTips = allMessages.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift').reduce((s, m) => s + (m.tokens || 0), 0);
    const uniqueUsers = new Set(allMessages.filter(m => m.user_name).map(m => m.user_name)).size;
    return { totalMessages, totalTips, uniqueUsers };
  }, [allMessages]);

  // ============================================================
  // Real-time stats
  // ============================================================
  const realtimeStats = useMemo(() => {
    const now = Date.now();

    // Top tippers (from all messages)
    const tipMap = new Map<string, number>();
    allMessages.forEach(m => {
      if (m.tokens > 0 && m.user_name && (m.msg_type === 'tip' || m.msg_type === 'gift')) {
        tipMap.set(m.user_name, (tipMap.get(m.user_name) || 0) + m.tokens);
      }
    });
    const topTippers = Array.from(tipMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, tokens]) => ({ name, tokens }));

    // Active users (last 5 min)
    const fiveMinAgo = now - 300000;
    const activeUsers = new Set(
      allMessages.filter(m => m.user_name && new Date(m.message_time).getTime() > fiveMinAgo)
        .map(m => m.user_name)
    ).size;

    // Chat speed (messages in last 1 min)
    const oneMinAgo = now - 60000;
    const recentMsgCount = allMessages.filter(m =>
      new Date(m.message_time).getTime() > oneMinAgo
    ).length;

    // Average speed (overall)
    const totalMinutes = allMessages.length > 1
      ? (new Date(allMessages[allMessages.length - 1].message_time).getTime() -
         new Date(allMessages[0].message_time).getTime()) / 60000
      : 1;
    const avgSpeed = totalMinutes > 0 ? allMessages.length / totalMinutes : 0;

    // Hype indicator
    const isHype = recentMsgCount > avgSpeed * 1.5 && recentMsgCount > 3;

    return { topTippers, activeUsers, chatSpeed: recentMsgCount, avgSpeed, isHype };
  }, [allMessages]);

  // ============================================================
  // Cast visibility toggle
  // ============================================================
  const toggleCastVisibility = useCallback((cn: string) => {
    setHiddenCasts(prev => {
      const next = new Set(prev);
      if (next.has(cn)) {
        next.delete(cn);
      } else {
        next.add(cn);
      }
      return next;
    });
  }, []);

  // ============================================================
  // Message type filter toggle
  // ============================================================
  const toggleMsgFilter = useCallback((key: FilterKey) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleAllFilters = useCallback(() => {
    setActiveFilters(prev => {
      if (prev.size === MSG_TYPE_FILTERS.length) {
        return new Set<FilterKey>();
      }
      return new Set(MSG_TYPE_FILTERS.map(f => f.key));
    });
  }, []);

  // ============================================================
  // Cast delete (today's messages)
  // ============================================================
  const handleDeleteCast = useCallback(async (cn: string) => {
    if (!confirm(`${cn} の本日のログを削除しますか？`)) return;
    setDeletingCast(cn);
    const err = await deleteCastMessages(cn);
    setDeletingCast(null);
    if (err) {
      setDemoError(`削除失敗: ${err}`);
    } else {
      // 削除したキャストが選択中なら選択解除
      if (selectedCast === cn) setSelectedCast(undefined);
    }
  }, [deleteCastMessages, selectedCast]);

  // ============================================================
  // Quick register cast to registered_casts
  // ============================================================
  const handleQuickRegister = useCallback(async (cn: string) => {
    if (!accountId) return;
    setRegisteringCast(cn);
    const supabase = createClient();
    const { error } = await supabase
      .from('registered_casts')
      .insert({
        account_id: accountId,
        cast_name: cn,
        stripchat_url: `https://stripchat.com/${cn}`,
      });

    if (!error || error.code === '23505') {
      // 成功 or 既に登録済み
      setRegisteredCastNames(prev => { const next = new Set(prev); next.add(cn); return next; });
    }
    setRegisteringCast(null);
  }, [accountId]);

  // ============================================================
  // Demo data insertion
  // ============================================================
  const handleInsertDemo = async () => {
    setDemoLoading(true);
    setDemoError(null);
    try {
      const supabase = createClient();
      const { data: existing } = await supabase.from('accounts').select('id').limit(1).single();
      let acctId = existing?.id;
      if (!acctId) {
        const { data: created, error: createErr } = await supabase
          .from('accounts')
          .insert({ user_id: user!.id, account_name: 'デモ事務所' })
          .select('id').single();
        if (createErr) { setDemoError(`accounts作成失敗: ${createErr.message}`); setDemoLoading(false); return; }
        acctId = created!.id;
      }
      const err = await insertDemoData(acctId);
      if (err) setDemoError(err);
    } catch (e: unknown) {
      setDemoError(e instanceof Error ? e.message : String(e));
    }
    setDemoLoading(false);
  };

  // ============================================================
  // Whisper send
  // ============================================================
  const handleWhisperSend = useCallback(async () => {
    const text = whisperText.trim();
    if (!text || !accountId) return;
    setWhisperSending(true);
    try {
      const cn = selectedCast || castNames[0] || null;
      const { error } = await whisperSbRef.current.from('whispers').insert({
        account_id: accountId,
        cast_name: cn,
        message: text,
        template_name: whisperTemplate,
      });
      if (error) throw error;
      setWhisperText('');
      setWhisperTemplate(null);
    } catch (e: unknown) {
      console.error('[Whisper] send failed:', e);
    } finally {
      setWhisperSending(false);
    }
  }, [whisperText, whisperTemplate, accountId, selectedCast, castNames]);

  // ============================================================
  // Connection status
  // ============================================================
  const connectionStatus = useMemo(() => {
    if (isConnected && allMessages.length > 0) {
      const lastTime = new Date(allMessages[allMessages.length - 1].message_time).getTime();
      if (Date.now() - lastTime > 120000) return 'paused'; // 2分以上無通信
      return 'active';
    }
    if (isConnected) return 'active';
    return 'stopped';
  }, [isConnected, allMessages]);

  const statusConfig = {
    active:  { dot: 'bg-emerald-400', text: '監視中',   color: '#22c55e' },
    paused:  { dot: 'bg-amber-400',   text: '一時停止', color: '#f59e0b' },
    stopped: { dot: 'bg-red-400',     text: '停止',     color: '#f43f5e' },
  };
  const status = statusConfig[connectionStatus];

  if (!user) return null;

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-3 overflow-hidden">
      {/* ============ Status Panel ============ */}
      <div className="glass-card px-5 py-3 flex-shrink-0">
        <div className="flex items-center gap-6 flex-wrap">
          {/* Connection status */}
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${status.dot} ${connectionStatus === 'active' ? 'anim-live' : ''}`} />
            <span className="text-xs font-semibold" style={{ color: status.color }}>{status.text}</span>
          </div>

          {/* Last message */}
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            最終受信: <span className="font-medium text-slate-300">{lastMsgAgo}</span>
          </div>

          {/* Session elapsed */}
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            経過: <span className="font-mono font-medium text-slate-300">{elapsedStr}</span>
          </div>

          {/* Divider */}
          <div className="h-4 w-px bg-slate-700" />

          {/* Today cumulative */}
          <div className="flex items-center gap-4 text-[11px]">
            <span style={{ color: 'var(--text-muted)' }}>
              MSG <span className="font-semibold text-slate-300">{todayStats.totalMessages.toLocaleString()}</span>
            </span>
            <span style={{ color: 'var(--accent-amber)' }}>
              TIP <span className="font-semibold">{formatTokens(todayStats.totalTips)}</span>
            </span>
            <span style={{ color: 'var(--accent-purple, #a855f7)' }}>
              USERS <span className="font-semibold">{todayStats.uniqueUsers}</span>
            </span>
          </div>

          {/* Viewer count */}
          {latestViewer && latestViewer.total != null && (
            <>
              <div className="h-4 w-px bg-slate-700" />
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                視聴者 <span className="font-semibold text-sky-400">{latestViewer.total}</span>
                <span className="ml-1 text-[10px]">
                  (コイン {latestViewer.coin_users ?? 0} / その他 {latestViewer.others ?? 0})
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ============ Main Content: Chat + Sidebar ============ */}
      <div className="flex-1 flex gap-3 overflow-hidden min-h-0">

        {/* ===== Left: Cast List ===== */}
        <div className="w-56 flex-shrink-0 glass-card p-3 flex flex-col hidden lg:flex">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold">キャスト一覧</h3>
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 anim-live' : 'bg-slate-600'}`}
              title={isConnected ? 'Realtime接続中' : '未接続'} />
          </div>

          <button
            onClick={() => setSelectedCast(undefined)}
            className={`w-full text-left p-2.5 rounded-xl transition-all duration-200 mb-1 text-xs ${
              !selectedCast ? 'border' : 'hover:bg-white/[0.03]'
            }`}
            style={!selectedCast ? {
              background: 'rgba(56,189,248,0.08)',
              borderColor: 'rgba(56,189,248,0.2)',
            } : {}}
          >
            <span className="font-semibold">📡 全キャスト</span>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {allMessages.length} 件のログ
            </p>
          </button>

          <div className="flex-1 space-y-1 overflow-auto">
            {castNames.map(name => {
              const isActive = selectedCast === name;
              const isHidden = hiddenCasts.has(name);
              // allMessagesから件数を計算（選択キャストに関係なく正確な数を表示）
              const count = allMessages.filter(m => m.cast_name === name).length;
              return (
                <div key={name} className="flex items-center gap-1">
                  <button
                    onClick={() => setSelectedCast(name)}
                    className={`flex-1 text-left p-2.5 rounded-xl transition-all duration-200 text-xs ${
                      isActive ? 'border' : 'hover:bg-white/[0.03]'
                    } ${isHidden ? 'opacity-40' : ''}`}
                    style={isActive ? {
                      background: 'rgba(56,189,248,0.08)',
                      borderColor: 'rgba(56,189,248,0.2)',
                    } : {}}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{name}</span>
                      <span className="badge-live text-[8px] py-0.5 px-1">LIVE</span>
                    </div>
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {count > 0 ? `${count} 件` : 'ログなし'}
                    </p>
                  </button>
                  {/* Visibility toggle */}
                  <button
                    onClick={() => toggleCastVisibility(name)}
                    className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-[11px]"
                    title={isHidden ? 'ログ表示' : 'ログ非表示'}
                    style={{ color: isHidden ? 'var(--text-muted)' : 'var(--accent-primary)' }}
                  >
                    {isHidden ? '👁‍🗨' : '👁'}
                  </button>
                  {/* Quick register as own cast */}
                  {registeredCastNames.has(name) ? (
                    <span className="p-1.5 text-[10px]" style={{ color: 'var(--accent-amber)' }} title="登録済み">
                      ★
                    </span>
                  ) : (
                    <button
                      onClick={() => handleQuickRegister(name)}
                      disabled={registeringCast === name}
                      className="p-1.5 rounded-lg hover:bg-amber-500/10 transition-all text-[10px] disabled:opacity-30"
                      title="自社キャストとして登録"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {registeringCast === name ? '...' : '☆'}
                    </button>
                  )}
                  {/* Delete today's logs */}
                  <button
                    onClick={() => handleDeleteCast(name)}
                    disabled={deletingCast === name}
                    className="p-1.5 rounded-lg hover:bg-rose-500/10 transition-all text-[11px] disabled:opacity-30"
                    title="本日のログ削除"
                    style={{ color: 'var(--accent-pink)' }}
                  >
                    🗑
                  </button>
                </div>
              );
            })}
            {castNames.length === 0 && (
              <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>
                キャストデータなし
              </p>
            )}
          </div>

          <button onClick={handleInsertDemo} disabled={demoLoading}
            className="btn-ghost w-full text-[10px] py-1.5 mt-2 disabled:opacity-50">
            {demoLoading ? '挿入中...' : '🧪 デモデータ挿入'}
          </button>
          {demoError && (
            <div className="mt-1.5 px-2 py-1.5 rounded-lg text-[9px] border"
              style={{ background: 'rgba(244,63,94,0.08)', borderColor: 'rgba(244,63,94,0.2)', color: 'var(--accent-pink)' }}>
              {demoError}
            </div>
          )}
        </div>

        {/* ===== Center: Chat Log ===== */}
        <div className="flex-1 glass-card p-4 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <div>
              <h2 className="text-sm font-bold flex items-center gap-2">
                🔍 スパイログ
                {realtimeStats.isHype && <span className="text-xs" title="盛り上がり検出">🔥</span>}
              </h2>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {selectedCast ? `Target: ${selectedCast}` : '全キャスト'}
                {isConnected && <span className="ml-2 text-emerald-400">● LIVE</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-2 py-1 rounded-lg"
                style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
                {filteredMessages.length} 件
              </span>
              {/* Mobile sidebar toggle */}
              <button
                onClick={() => setSidePanelOpen(!sidePanelOpen)}
                className="xl:hidden text-xs px-2 py-1 rounded-lg hover:bg-white/5"
                style={{ color: 'var(--text-muted)' }}
              >
                📊
              </button>
            </div>
          </div>

          {/* Message type filter buttons */}
          <div className="flex-shrink-0 flex gap-1.5 mb-2 flex-wrap">
            <button
              onClick={toggleAllFilters}
              className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
              style={{
                background: activeFilters.size === MSG_TYPE_FILTERS.length
                  ? 'rgba(56,189,248,0.15)' : 'rgba(100,116,139,0.1)',
                color: activeFilters.size === MSG_TYPE_FILTERS.length
                  ? 'var(--accent-primary)' : 'var(--text-muted)',
                border: `1px solid ${activeFilters.size === MSG_TYPE_FILTERS.length
                  ? 'rgba(56,189,248,0.25)' : 'rgba(100,116,139,0.15)'}`,
              }}
            >
              全部
            </button>
            {MSG_TYPE_FILTERS.map(f => {
              const isOn = activeFilters.has(f.key);
              return (
                <button
                  key={f.key}
                  onClick={() => toggleMsgFilter(f.key)}
                  className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                  style={{
                    background: isOn ? 'rgba(56,189,248,0.12)' : 'rgba(100,116,139,0.06)',
                    color: isOn ? '#e2e8f0' : 'var(--text-muted)',
                    border: `1px solid ${isOn ? 'rgba(56,189,248,0.2)' : 'rgba(100,116,139,0.1)'}`,
                    opacity: isOn ? 1 : 0.5,
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {/* Search filter */}
          <div className="flex-shrink-0 mb-2">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="input-glass text-[11px] w-full py-1.5 px-3"
              placeholder="🔍 ユーザー名 or キーワードで絞り込み..."
            />
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-auto space-y-0.5 pr-1 min-h-0">
            {filteredMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {searchQuery ? '検索結果なし' : 'メッセージがありません'}
                </p>
                {!searchQuery && (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    「デモデータ挿入」でテストデータを追加できます
                  </p>
                )}
              </div>
            ) : (
              filteredMessages.map(msg => (
                <ChatMessage key={msg.id} message={msg} />
              ))
            )}
          </div>

          {/* Auto-scroll floating button */}
          <div className="flex-shrink-0 flex justify-end mt-1">
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className="text-[10px] px-3 py-1 rounded-lg transition-all"
              style={{
                background: autoScroll ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.12)',
                color: autoScroll ? '#22c55e' : 'var(--text-muted)',
                border: `1px solid ${autoScroll ? 'rgba(34,197,94,0.2)' : 'rgba(100,116,139,0.2)'}`,
              }}
            >
              {autoScroll ? '⬇ 自動スクロール ON' : '⏸ 自動スクロール OFF'}
            </button>
          </div>

          {/* Whisper input */}
          <div className="mt-2 pt-3 border-t flex-shrink-0" style={{ borderColor: 'var(--border-glass)' }}>
            <div className="flex gap-2 mb-2 flex-wrap">
              {[
                { name: '謝罪 + 甘え', text: 'ごめんね...もうちょっと一緒にいて？お願い...' },
                { name: '嫉妬を煽る', text: 'さっきのユーザーとばかり話してた？私のこと見てないよね...' },
                { name: '延長の打診', text: 'もう少しだけいてくれたら嬉しいな...延長してくれる？' },
              ].map(t => (
                <button
                  key={t.name}
                  onClick={() => { setWhisperText(t.text); setWhisperTemplate(t.name); }}
                  disabled={whisperSending}
                  className="btn-ghost text-[10px] py-1 px-2.5 disabled:opacity-50"
                >{t.name}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className="input-glass flex-1 text-xs"
                placeholder='キャストに「ささやく」メッセージ... (Ctrl+Enter)'
                value={whisperText}
                onChange={(e) => { setWhisperText(e.target.value); setWhisperTemplate(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleWhisperSend();
                  }
                }}
                disabled={whisperSending || !accountId}
              />
              <button
                onClick={handleWhisperSend}
                disabled={whisperSending || !whisperText.trim() || !accountId}
                className="btn-primary text-[11px] whitespace-nowrap px-3 disabled:opacity-50"
              >{whisperSending ? '送信中...' : '送信'}</button>
            </div>
          </div>
        </div>

        {/* ===== Right: Stats Sidebar ===== */}
        <div className={`w-64 flex-shrink-0 space-y-3 overflow-auto ${sidePanelOpen ? 'block' : 'hidden'} xl:block`}>

          {/* Top Tippers */}
          <div className="glass-card p-4">
            <h3 className="text-xs font-bold mb-3">💰 トップチッパー</h3>
            {realtimeStats.topTippers.length === 0 ? (
              <p className="text-[10px] text-center py-2" style={{ color: 'var(--text-muted)' }}>チップなし</p>
            ) : (
              <div className="space-y-2">
                {realtimeStats.topTippers.map((t, i) => (
                  <div key={t.name} className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-bold w-4 text-center" style={{
                        color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)'
                      }}>
                        {i + 1}
                      </span>
                      <span className="truncate font-medium">{t.name}</span>
                    </div>
                    <span className="flex-shrink-0 font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                      {t.tokens.toLocaleString()} tk
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Active Stats */}
          <div className="glass-card p-4">
            <h3 className="text-xs font-bold mb-3">📊 リアルタイム統計</h3>
            <div className="space-y-3">
              {/* Active users */}
              <div className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-muted)' }}>アクティブユーザー (5分)</span>
                <span className="font-bold" style={{ color: 'var(--accent-purple, #a855f7)' }}>
                  {realtimeStats.activeUsers}
                </span>
              </div>

              {/* Chat speed */}
              <div className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-muted)' }}>
                  チャット速度 {realtimeStats.isHype && '🔥'}
                </span>
                <span className="font-bold" style={{ color: realtimeStats.isHype ? '#f59e0b' : 'var(--accent-primary)' }}>
                  {realtimeStats.chatSpeed} msg/min
                </span>
              </div>

              {/* Average speed */}
              <div className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-muted)' }}>平均速度</span>
                <span className="font-medium tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {realtimeStats.avgSpeed.toFixed(1)} msg/min
                </span>
              </div>

              {/* Hype bar */}
              <div>
                <div className="flex justify-between text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  <span>盛り上がり</span>
                  <span>{realtimeStats.isHype ? '🔥 HIGH' : 'NORMAL'}</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min((realtimeStats.chatSpeed / Math.max(realtimeStats.avgSpeed * 2, 1)) * 100, 100)}%`,
                      background: realtimeStats.isHype
                        ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
                        : 'linear-gradient(90deg, rgba(56,189,248,0.6), rgba(56,189,248,0.3))',
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Message Legend */}
          <div className="glass-card p-3">
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>凡例</p>
            <div className="space-y-1 text-[10px]">
              <div className="flex items-center gap-2"><span>💬</span><span>チャット</span></div>
              <div className="flex items-center gap-2"><span>💰</span><span style={{ color: 'var(--accent-amber)' }}>チップ</span></div>
              <div className="flex items-center gap-2"><span>🎁</span><span style={{ color: 'var(--accent-amber)' }}>ギフト</span></div>
              <div className="flex items-center gap-2"><span>🎤</span><span style={{ color: 'var(--accent-purple, #a855f7)' }}>音声(STT)</span></div>
              <div className="flex items-center gap-2"><span>👋</span><span style={{ color: 'var(--accent-green)' }}>入室</span></div>
              <div className="flex items-center gap-2"><span>🚪</span><span style={{ color: 'var(--accent-pink)' }}>退室</span></div>
              <div className="flex items-center gap-2"><span>⚙️</span><span style={{ color: 'var(--text-muted)' }}>システム</span></div>
            </div>
          </div>

          <button className="btn-ghost w-full text-[10px] py-2" onClick={handleInsertDemo} disabled={demoLoading}>
            🧪 デモデータ挿入
          </button>
        </div>
      </div>
    </div>
  );
}
