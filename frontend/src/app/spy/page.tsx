'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { ChatMessage } from '@/components/chat-message';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, timeAgo } from '@/lib/utils';
import Link from 'next/link';
import type { SpyMessage, SpyCast } from '@/types';

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
type SpyTab = 'realtime' | 'list' | 'format';

/* ============================================================
   Main Page
   ============================================================ */
export default function SpyPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<SpyTab>('realtime');

  if (!user) return null;

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-3 overflow-hidden">
      {/* Tab Navigation */}
      <div className="glass-card px-5 py-2 flex-shrink-0 flex items-center gap-1">
        {([
          { key: 'realtime', label: 'リアルタイム監視', icon: '📡' },
          { key: 'list',     label: 'スパイ一覧',       icon: '📋' },
          { key: 'format',   label: 'フォーマット分析', icon: '📊' },
        ] as { key: SpyTab; label: string; icon: string }[]).map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className="px-4 py-2 rounded-lg text-xs font-semibold transition-all"
            style={{
              background: activeTab === t.key ? 'rgba(56,189,248,0.12)' : 'transparent',
              color: activeTab === t.key ? 'var(--accent-primary)' : 'var(--text-muted)',
              border: activeTab === t.key ? '1px solid rgba(56,189,248,0.2)' : '1px solid transparent',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'realtime' && <RealtimeTab />}
      {activeTab === 'list' && <SpyListTab />}
      {activeTab === 'format' && <FormatAnalysisTab />}
    </div>
  );
}

/* ============================================================
   Realtime Tab (既存SPYページのロジックを移植)
   ============================================================ */
function RealtimeTab() {
  const { user } = useAuth();
  const [selectedCast, setSelectedCast] = useState<string | undefined>(undefined);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(
    () => new Set(MSG_TYPE_FILTERS.map(f => f.key))
  );
  const [sessionStart] = useState(() => new Date());
  const [elapsedStr, setElapsedStr] = useState('00:00:00');
  const [lastMsgAgo, setLastMsgAgo] = useState('--');
  const [latestViewer, setLatestViewer] = useState<ViewerStat | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [whisperText, setWhisperText] = useState('');
  const [whisperTemplate, setWhisperTemplate] = useState<string | null>(null);
  const [whisperSending, setWhisperSending] = useState(false);
  const whisperSbRef = useRef(createClient());
  const [hiddenCasts, setHiddenCasts] = useState<Set<string>>(new Set());
  const [deletingCast, setDeletingCast] = useState<string | null>(null);
  const [registeredCastNames, setRegisteredCastNames] = useState<Set<string>>(new Set());
  const [spyCastNames, setSpyCastNames] = useState<Set<string>>(new Set());
  const [registeringCast, setRegisteringCast] = useState<string | null>(null);

  const { messages, allMessages, castNames, isConnected, insertDemoData, deleteCastMessages } = useRealtimeSpy({
    castName: selectedCast,
    enabled: !!user,
  });

  // accountId取得 + registered_casts + spy_casts取得
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
            if (casts) setRegisteredCastNames(new Set(casts.map(c => c.cast_name)));
          });
        // スパイ登録済みキャスト名を取得
        whisperSbRef.current
          .from('spy_casts')
          .select('cast_name')
          .eq('account_id', data.id)
          .eq('is_active', true)
          .then(({ data: casts }) => {
            if (casts) setSpyCastNames(new Set(casts.map(c => c.cast_name)));
          });
      }
    });
  }, [user]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, autoScroll]);

  // Elapsed time counter
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

  // Last message relative time
  useEffect(() => {
    const timer = setInterval(() => {
      if (messages.length > 0) {
        setLastMsgAgo(timeAgo(messages[messages.length - 1].message_time));
      } else {
        setLastMsgAgo('--');
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [messages]);

  // Viewer stats
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    const loadViewer = () => {
      supabase.from('viewer_stats')
        .select('total, coin_users, others, recorded_at')
        .order('recorded_at', { ascending: false })
        .limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) setLatestViewer(data[0] as ViewerStat);
        });
    };
    loadViewer();
    const interval = setInterval(loadViewer, 30000);
    return () => clearInterval(interval);
  }, [user]);

  // Filtered messages
  const allFilterTypes = useMemo(() => {
    const types = new Set<string>();
    for (const f of MSG_TYPE_FILTERS) {
      if (activeFilters.has(f.key)) f.types.forEach(t => types.add(t));
    }
    return types;
  }, [activeFilters]);

  const filteredMessages = useMemo(() => {
    let filtered = messages;
    if (hiddenCasts.size > 0) filtered = filtered.filter(m => !hiddenCasts.has(m.cast_name));
    if (activeFilters.size < MSG_TYPE_FILTERS.length) filtered = filtered.filter(m => allFilterTypes.has(m.msg_type));
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(m =>
        (m.user_name?.toLowerCase().includes(q)) || (m.message?.toLowerCase().includes(q))
      );
    }
    return filtered;
  }, [messages, searchQuery, hiddenCasts, activeFilters, allFilterTypes]);

  // Today stats
  const todayStats = useMemo(() => {
    const totalMessages = allMessages.length;
    const totalTips = allMessages.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift').reduce((s, m) => s + (m.tokens || 0), 0);
    const uniqueUsers = new Set(allMessages.filter(m => m.user_name).map(m => m.user_name)).size;
    return { totalMessages, totalTips, uniqueUsers };
  }, [allMessages]);

  // Realtime stats
  const realtimeStats = useMemo(() => {
    const now = Date.now();
    const tipMap = new Map<string, number>();
    allMessages.forEach(m => {
      if (m.tokens > 0 && m.user_name && (m.msg_type === 'tip' || m.msg_type === 'gift')) {
        tipMap.set(m.user_name, (tipMap.get(m.user_name) || 0) + m.tokens);
      }
    });
    const topTippers = Array.from(tipMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, tokens]) => ({ name, tokens }));
    const fiveMinAgo = now - 300000;
    const activeUsers = new Set(allMessages.filter(m => m.user_name && new Date(m.message_time).getTime() > fiveMinAgo).map(m => m.user_name)).size;
    const oneMinAgo = now - 60000;
    const recentMsgCount = allMessages.filter(m => new Date(m.message_time).getTime() > oneMinAgo).length;
    const totalMinutes = allMessages.length > 1
      ? (new Date(allMessages[allMessages.length - 1].message_time).getTime() - new Date(allMessages[0].message_time).getTime()) / 60000
      : 1;
    const avgSpeed = totalMinutes > 0 ? allMessages.length / totalMinutes : 0;
    const isHype = recentMsgCount > avgSpeed * 1.5 && recentMsgCount > 3;
    return { topTippers, activeUsers, chatSpeed: recentMsgCount, avgSpeed, isHype };
  }, [allMessages]);

  // Unregistered casts (not in registered_casts or spy_casts)
  const unregisteredCasts = useMemo(() => {
    return castNames.filter(n => !registeredCastNames.has(n) && !spyCastNames.has(n));
  }, [castNames, registeredCastNames, spyCastNames]);

  const toggleCastVisibility = useCallback((cn: string) => {
    setHiddenCasts(prev => {
      const next = new Set(prev);
      if (next.has(cn)) next.delete(cn); else next.add(cn);
      return next;
    });
  }, []);

  const toggleMsgFilter = useCallback((key: FilterKey) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleAllFilters = useCallback(() => {
    setActiveFilters(prev => {
      if (prev.size === MSG_TYPE_FILTERS.length) return new Set<FilterKey>();
      return new Set(MSG_TYPE_FILTERS.map(f => f.key));
    });
  }, []);

  const handleDeleteCast = useCallback(async (cn: string) => {
    if (!confirm(`${cn} の本日のログを削除しますか？`)) return;
    setDeletingCast(cn);
    const err = await deleteCastMessages(cn);
    setDeletingCast(null);
    if (err) setDemoError(`削除失敗: ${err}`);
    else if (selectedCast === cn) setSelectedCast(undefined);
  }, [deleteCastMessages, selectedCast]);

  // Quick register as 自社キャスト
  const handleQuickRegister = useCallback(async (cn: string) => {
    if (!accountId) return;
    setRegisteringCast(cn);
    const supabase = createClient();
    const { error } = await supabase.from('registered_casts').insert({
      account_id: accountId, cast_name: cn, stripchat_url: `https://stripchat.com/${cn}`,
    });
    if (!error || error.code === '23505') {
      setRegisteredCastNames(prev => { const next = new Set(prev); next.add(cn); return next; });
    }
    setRegisteringCast(null);
  }, [accountId]);

  // Quick register as スパイキャスト
  const handleSpyRegister = useCallback(async (cn: string) => {
    if (!accountId) return;
    setRegisteringCast(cn);
    const supabase = createClient();
    const { error } = await supabase.from('spy_casts').insert({
      account_id: accountId, cast_name: cn, stripchat_url: `https://stripchat.com/${cn}`,
    });
    if (!error || error.code === '23505') {
      setSpyCastNames(prev => { const next = new Set(prev); next.add(cn); return next; });
    }
    setRegisteringCast(null);
  }, [accountId]);

  const handleInsertDemo = async () => {
    setDemoLoading(true);
    setDemoError(null);
    try {
      const supabase = createClient();
      const { data: existing } = await supabase.from('accounts').select('id').limit(1).single();
      let acctId = existing?.id;
      if (!acctId) {
        const { data: created, error: createErr } = await supabase
          .from('accounts').insert({ user_id: user!.id, account_name: 'デモ事務所' }).select('id').single();
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

  const handleWhisperSend = useCallback(async () => {
    const text = whisperText.trim();
    if (!text || !accountId) return;
    setWhisperSending(true);
    try {
      const cn = selectedCast || castNames[0] || null;
      const { error } = await whisperSbRef.current.from('whispers').insert({
        account_id: accountId, cast_name: cn, message: text, template_name: whisperTemplate,
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

  const connectionStatus = useMemo(() => {
    if (isConnected && allMessages.length > 0) {
      const lastTime = new Date(allMessages[allMessages.length - 1].message_time).getTime();
      if (Date.now() - lastTime > 120000) return 'paused';
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

  // キャスト分類: 自社 / スパイ / 未登録
  const getCastBadge = (cn: string) => {
    if (registeredCastNames.has(cn)) return { label: '自社', color: '#f59e0b' };
    if (spyCastNames.has(cn)) return { label: 'SPY', color: '#38bdf8' };
    return null;
  };

  return (
    <>
      {/* Status Panel */}
      <div className="glass-card px-5 py-3 flex-shrink-0">
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${status.dot} ${connectionStatus === 'active' ? 'anim-live' : ''}`} />
            <span className="text-xs font-semibold" style={{ color: status.color }}>{status.text}</span>
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            最終受信: <span className="font-medium text-slate-300">{lastMsgAgo}</span>
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            経過: <span className="font-mono font-medium text-slate-300">{elapsedStr}</span>
          </div>
          <div className="h-4 w-px bg-slate-700" />
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
          {latestViewer && latestViewer.total != null && (
            <>
              <div className="h-4 w-px bg-slate-700" />
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                視聴者 <span className="font-semibold text-sky-400">{latestViewer.total}</span>
                <span className="ml-1 text-[10px]">(コイン {latestViewer.coin_users ?? 0} / その他 {latestViewer.others ?? 0})</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
        {/* Left: Cast List */}
        <div className="w-56 flex-shrink-0 glass-card p-3 flex flex-col hidden lg:flex">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold">キャスト一覧</h3>
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 anim-live' : 'bg-slate-600'}`}
              title={isConnected ? 'Realtime接続中' : '未接続'} />
          </div>

          <button
            onClick={() => setSelectedCast(undefined)}
            className={`w-full text-left p-2.5 rounded-xl transition-all duration-200 mb-1 text-xs ${!selectedCast ? 'border' : 'hover:bg-white/[0.03]'}`}
            style={!selectedCast ? { background: 'rgba(56,189,248,0.08)', borderColor: 'rgba(56,189,248,0.2)' } : {}}
          >
            <span className="font-semibold">📡 全キャスト</span>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{allMessages.length} 件のログ</p>
          </button>

          <div className="flex-1 space-y-1 overflow-auto">
            {castNames.map(name => {
              const isActive = selectedCast === name;
              const isHidden = hiddenCasts.has(name);
              const count = allMessages.filter(m => m.cast_name === name).length;
              const badge = getCastBadge(name);
              return (
                <div key={name} className="flex items-center gap-1">
                  <button
                    onClick={() => setSelectedCast(name)}
                    className={`flex-1 text-left p-2.5 rounded-xl transition-all duration-200 text-xs ${isActive ? 'border' : 'hover:bg-white/[0.03]'} ${isHidden ? 'opacity-40' : ''}`}
                    style={isActive ? { background: 'rgba(56,189,248,0.08)', borderColor: 'rgba(56,189,248,0.2)' } : {}}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold truncate">{name}</span>
                      <div className="flex items-center gap-1">
                        {badge && (
                          <span className="text-[8px] py-0.5 px-1 rounded" style={{ background: `${badge.color}20`, color: badge.color }}>{badge.label}</span>
                        )}
                        <span className="badge-live text-[8px] py-0.5 px-1">LIVE</span>
                      </div>
                    </div>
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{count > 0 ? `${count} 件` : 'ログなし'}</p>
                  </button>
                  <button onClick={() => toggleCastVisibility(name)} className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-[11px]"
                    title={isHidden ? 'ログ表示' : 'ログ非表示'} style={{ color: isHidden ? 'var(--text-muted)' : 'var(--accent-primary)' }}>
                    {isHidden ? '👁‍🗨' : '👁'}
                  </button>
                  {/* Register buttons */}
                  {registeredCastNames.has(name) ? (
                    <span className="p-1.5 text-[10px]" style={{ color: 'var(--accent-amber)' }} title="自社登録済み">★</span>
                  ) : spyCastNames.has(name) ? (
                    <Link href={`/spy/${encodeURIComponent(name)}`} className="p-1.5 text-[10px] hover:opacity-70" style={{ color: 'var(--accent-primary)' }} title="スパイ詳細">🔍</Link>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <button onClick={() => handleQuickRegister(name)} disabled={registeringCast === name}
                        className="p-1 rounded hover:bg-amber-500/10 text-[9px] disabled:opacity-30" title="自社登録" style={{ color: 'var(--text-muted)' }}>
                        {registeringCast === name ? '..' : '★'}
                      </button>
                      <button onClick={() => handleSpyRegister(name)} disabled={registeringCast === name}
                        className="p-1 rounded hover:bg-sky-500/10 text-[9px] disabled:opacity-30" title="スパイ登録" style={{ color: 'var(--text-muted)' }}>
                        {registeringCast === name ? '..' : '🔍'}
                      </button>
                    </div>
                  )}
                  <button onClick={() => handleDeleteCast(name)} disabled={deletingCast === name}
                    className="p-1.5 rounded-lg hover:bg-rose-500/10 transition-all text-[11px] disabled:opacity-30" title="本日のログ削除" style={{ color: 'var(--accent-pink)' }}>
                    🗑
                  </button>
                </div>
              );
            })}
            {castNames.length === 0 && (
              <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>キャストデータなし</p>
            )}
          </div>

          {/* Unregistered cast auto-list */}
          {unregisteredCasts.length > 0 && (
            <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--border-glass)' }}>
              <p className="text-[9px] font-bold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>未登録キャスト ({unregisteredCasts.length})</p>
              <div className="space-y-0.5 max-h-20 overflow-auto">
                {unregisteredCasts.map(cn => (
                  <div key={cn} className="flex items-center justify-between text-[10px] px-1">
                    <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{cn}</span>
                    <div className="flex gap-1">
                      <button onClick={() => handleQuickRegister(cn)} className="hover:text-amber-400 transition-colors" title="自社登録">★</button>
                      <button onClick={() => handleSpyRegister(cn)} className="hover:text-sky-400 transition-colors" title="スパイ登録">🔍</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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

        {/* Center: Chat Log */}
        <div className="flex-1 glass-card p-4 flex flex-col min-w-0">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <div>
              <h2 className="text-sm font-bold flex items-center gap-2">
                🔍 スパイログ {realtimeStats.isHype && <span className="text-xs" title="盛り上がり検出">🔥</span>}
              </h2>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {selectedCast ? `Target: ${selectedCast}` : '全キャスト'}
                {isConnected && <span className="ml-2 text-emerald-400">● LIVE</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-2 py-1 rounded-lg" style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
                {filteredMessages.length} 件
              </span>
              <button onClick={() => setSidePanelOpen(!sidePanelOpen)} className="xl:hidden text-xs px-2 py-1 rounded-lg hover:bg-white/5" style={{ color: 'var(--text-muted)' }}>📊</button>
            </div>
          </div>

          {/* Message type filter */}
          <div className="flex-shrink-0 flex gap-1.5 mb-2 flex-wrap">
            <button onClick={toggleAllFilters} className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
              style={{ background: activeFilters.size === MSG_TYPE_FILTERS.length ? 'rgba(56,189,248,0.15)' : 'rgba(100,116,139,0.1)',
                color: activeFilters.size === MSG_TYPE_FILTERS.length ? 'var(--accent-primary)' : 'var(--text-muted)',
                border: `1px solid ${activeFilters.size === MSG_TYPE_FILTERS.length ? 'rgba(56,189,248,0.25)' : 'rgba(100,116,139,0.15)'}` }}>
              全部
            </button>
            {MSG_TYPE_FILTERS.map(f => {
              const isOn = activeFilters.has(f.key);
              return (
                <button key={f.key} onClick={() => toggleMsgFilter(f.key)} className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                  style={{ background: isOn ? 'rgba(56,189,248,0.12)' : 'rgba(100,116,139,0.06)',
                    color: isOn ? '#e2e8f0' : 'var(--text-muted)',
                    border: `1px solid ${isOn ? 'rgba(56,189,248,0.2)' : 'rgba(100,116,139,0.1)'}`, opacity: isOn ? 1 : 0.5 }}>
                  {f.label}
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="flex-shrink-0 mb-2">
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              className="input-glass text-[11px] w-full py-1.5 px-3" placeholder="🔍 ユーザー名 or キーワードで絞り込み..." />
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-auto space-y-0.5 pr-1 min-h-0">
            {filteredMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{searchQuery ? '検索結果なし' : 'メッセージがありません'}</p>
                {!searchQuery && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>「デモデータ挿入」でテストデータを追加できます</p>}
              </div>
            ) : filteredMessages.map(msg => <ChatMessage key={msg.id} message={msg} />)}
          </div>

          {/* Auto-scroll */}
          <div className="flex-shrink-0 flex justify-end mt-1">
            <button onClick={() => setAutoScroll(!autoScroll)} className="text-[10px] px-3 py-1 rounded-lg transition-all"
              style={{ background: autoScroll ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.12)',
                color: autoScroll ? '#22c55e' : 'var(--text-muted)',
                border: `1px solid ${autoScroll ? 'rgba(34,197,94,0.2)' : 'rgba(100,116,139,0.2)'}` }}>
              {autoScroll ? '⬇ 自動スクロール ON' : '⏸ 自動スクロール OFF'}
            </button>
          </div>

          {/* Whisper */}
          <div className="mt-2 pt-3 border-t flex-shrink-0" style={{ borderColor: 'var(--border-glass)' }}>
            <div className="flex gap-2 mb-2 flex-wrap">
              {[
                { name: '謝罪 + 甘え', text: 'ごめんね...もうちょっと一緒にいて？お願い...' },
                { name: '嫉妬を煽る', text: 'さっきのユーザーとばかり話してた？私のこと見てないよね...' },
                { name: '延長の打診', text: 'もう少しだけいてくれたら嬉しいな...延長してくれる？' },
              ].map(t => (
                <button key={t.name} onClick={() => { setWhisperText(t.text); setWhisperTemplate(t.name); }}
                  disabled={whisperSending} className="btn-ghost text-[10px] py-1 px-2.5 disabled:opacity-50">{t.name}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <input className="input-glass flex-1 text-xs" placeholder='キャストに「ささやく」メッセージ... (Ctrl+Enter)'
                value={whisperText} onChange={e => { setWhisperText(e.target.value); setWhisperTemplate(null); }}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleWhisperSend(); } }}
                disabled={whisperSending || !accountId} />
              <button onClick={handleWhisperSend} disabled={whisperSending || !whisperText.trim() || !accountId}
                className="btn-primary text-[11px] whitespace-nowrap px-3 disabled:opacity-50">
                {whisperSending ? '送信中...' : '送信'}
              </button>
            </div>
          </div>
        </div>

        {/* Right: Stats Sidebar */}
        <div className={`w-64 flex-shrink-0 space-y-3 overflow-auto ${sidePanelOpen ? 'block' : 'hidden'} xl:block`}>
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
                        color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)' }}>{i + 1}</span>
                      <Link href={`/spy/users/${encodeURIComponent(t.name)}`} className="truncate font-medium hover:text-sky-400 transition-colors">{t.name}</Link>
                    </div>
                    <span className="flex-shrink-0 font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>{t.tokens.toLocaleString()} tk</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="glass-card p-4">
            <h3 className="text-xs font-bold mb-3">📊 リアルタイム統計</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-muted)' }}>アクティブユーザー (5分)</span>
                <span className="font-bold" style={{ color: 'var(--accent-purple, #a855f7)' }}>{realtimeStats.activeUsers}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-muted)' }}>チャット速度 {realtimeStats.isHype && '🔥'}</span>
                <span className="font-bold" style={{ color: realtimeStats.isHype ? '#f59e0b' : 'var(--accent-primary)' }}>{realtimeStats.chatSpeed} msg/min</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--text-muted)' }}>平均速度</span>
                <span className="font-medium tabular-nums" style={{ color: 'var(--text-secondary)' }}>{realtimeStats.avgSpeed.toFixed(1)} msg/min</span>
              </div>
              <div>
                <div className="flex justify-between text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  <span>盛り上がり</span>
                  <span>{realtimeStats.isHype ? '🔥 HIGH' : 'NORMAL'}</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-slate-800">
                  <div className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min((realtimeStats.chatSpeed / Math.max(realtimeStats.avgSpeed * 2, 1)) * 100, 100)}%`,
                      background: realtimeStats.isHype ? 'linear-gradient(90deg, #f59e0b, #ef4444)' : 'linear-gradient(90deg, rgba(56,189,248,0.6), rgba(56,189,248,0.3))' }} />
                </div>
              </div>
            </div>
          </div>

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
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Spy List Tab — spy_casts 一覧テーブル
   ============================================================ */
function SpyListTab() {
  const { user } = useAuth();
  const [spyCasts, setSpyCasts] = useState<SpyCast[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, { total_messages: number; total_coins: number; unique_users: number; last_activity: string | null }>>({});
  const [newCastName, setNewCastName] = useState('');
  const [addingCast, setAddingCast] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFields, setEditFields] = useState<{ category: string; format_tag: string; notes: string }>({ category: '', format_tag: '', notes: '' });

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }
      setAccountId(data.id);

      const { data: casts } = await supabase
        .from('spy_casts')
        .select('*')
        .eq('account_id', data.id)
        .order('created_at', { ascending: false });

      if (casts) {
        setSpyCasts(casts as SpyCast[]);
        // Get stats via RPC
        const castNames = casts.map(c => c.cast_name);
        if (castNames.length > 0) {
          const { data: statsData } = await supabase.rpc('get_spy_cast_stats', {
            p_account_id: data.id,
            p_cast_names: castNames,
          });
          if (statsData) {
            const statsMap: Record<string, typeof stats[string]> = {};
            for (const s of statsData) {
              statsMap[s.cast_name] = {
                total_messages: s.total_messages,
                total_coins: s.total_coins,
                unique_users: s.unique_users,
                last_activity: s.last_activity,
              };
            }
            setStats(statsMap);
          }
        }
      }
      setLoading(false);
    });
  }, [user]);

  const handleAddCast = useCallback(async () => {
    const name = newCastName.trim();
    if (!name || !accountId) return;
    setAddingCast(true);
    const supabase = createClient();
    const { data, error } = await supabase.from('spy_casts').insert({
      account_id: accountId,
      cast_name: name,
      stripchat_url: `https://stripchat.com/${name}`,
    }).select('*').single();

    if (!error && data) {
      setSpyCasts(prev => [data as SpyCast, ...prev]);
      setNewCastName('');
    }
    setAddingCast(false);
  }, [newCastName, accountId]);

  const handleDelete = useCallback(async (id: number) => {
    if (!confirm('このスパイキャストを削除しますか？')) return;
    const supabase = createClient();
    await supabase.from('spy_casts').delete().eq('id', id);
    setSpyCasts(prev => prev.filter(c => c.id !== id));
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (editingId === null) return;
    const supabase = createClient();
    await supabase.from('spy_casts')
      .update({ category: editFields.category || null, format_tag: editFields.format_tag || null, notes: editFields.notes || null, updated_at: new Date().toISOString() })
      .eq('id', editingId);
    setSpyCasts(prev => prev.map(c => c.id === editingId ? { ...c, ...editFields, updated_at: new Date().toISOString() } : c));
    setEditingId(null);
  }, [editingId, editFields]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  return (
    <div className="flex-1 overflow-auto">
      {/* Add new spy cast */}
      <div className="glass-card p-4 mb-3">
        <h3 className="text-xs font-bold mb-3">スパイキャスト追加</h3>
        <div className="flex gap-2">
          <input type="text" value={newCastName} onChange={e => setNewCastName(e.target.value)}
            className="input-glass flex-1 text-xs" placeholder="キャスト名（Stripchat username）"
            onKeyDown={e => { if (e.key === 'Enter') handleAddCast(); }} />
          <button onClick={handleAddCast} disabled={addingCast || !newCastName.trim()}
            className="btn-primary text-[11px] px-4 disabled:opacity-50">
            {addingCast ? '追加中...' : '追加'}
          </button>
        </div>
      </div>

      {/* Spy casts table */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">📋 スパイキャスト一覧 ({spyCasts.length})</h3>
        {spyCasts.length === 0 ? (
          <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>スパイキャストが登録されていません</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>キャスト</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>MSG</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>COINS</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>USERS</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>カテゴリ</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>最終</th>
                  <th className="text-right py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {spyCasts.map(cast => {
                  const s = stats[cast.cast_name];
                  const isEditing = editingId === cast.id;
                  return (
                    <tr key={cast.id} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'rgba(56,189,248,0.05)' }}>
                      <td className="py-2.5 px-2">
                        <Link href={`/spy/${encodeURIComponent(cast.cast_name)}`} className="font-semibold hover:text-sky-400 transition-colors">
                          {cast.cast_name}
                        </Link>
                        {cast.display_name && <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{cast.display_name}</p>}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">{s ? s.total_messages.toLocaleString() : '-'}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>
                        {s ? formatTokens(s.total_coins) : '-'}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">{s ? s.unique_users : '-'}</td>
                      <td className="py-2.5 px-2">
                        {isEditing ? (
                          <input type="text" value={editFields.category} onChange={e => setEditFields(f => ({ ...f, category: e.target.value }))}
                            className="input-glass text-[10px] w-24 py-0.5 px-1" placeholder="カテゴリ" />
                        ) : (
                          <span style={{ color: 'var(--text-secondary)' }}>{cast.category || '-'}</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {s?.last_activity ? timeAgo(s.last_activity) : '-'}
                      </td>
                      <td className="py-2.5 px-2 text-right">
                        <div className="flex items-center gap-1 justify-end">
                          {isEditing ? (
                            <>
                              <button onClick={handleSaveEdit} className="text-[10px] px-2 py-0.5 rounded hover:bg-emerald-500/10" style={{ color: 'var(--accent-green)' }}>保存</button>
                              <button onClick={() => setEditingId(null)} className="text-[10px] px-2 py-0.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}>取消</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => { setEditingId(cast.id); setEditFields({ category: cast.category || '', format_tag: cast.format_tag || '', notes: cast.notes || '' }); }}
                                className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }} title="編集">✏️</button>
                              <button onClick={() => handleDelete(cast.id)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-rose-500/10" style={{ color: 'var(--accent-pink)' }} title="削除">🗑</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Format Analysis Tab (placeholder)
   ============================================================ */
function FormatAnalysisTab() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="glass-card p-12 text-center max-w-md">
        <p className="text-3xl mb-4">📊</p>
        <h3 className="text-sm font-bold mb-2">フォーマット分析</h3>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          他社キャストの配信フォーマット（カテゴリ、タグ、セッション構成）を分析する機能を準備中です。
          スパイ一覧からキャストを登録し、カテゴリとフォーマットタグを設定してください。
        </p>
      </div>
    </div>
  );
}
