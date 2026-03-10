'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { ChatMessage } from '@/components/chat-message';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, timeAgo } from '@/lib/utils';
import Link from 'next/link';
import type { ViewerStat, FilterKey } from '@/types/spy';
import { MSG_TYPE_FILTERS } from '@/types/spy';

export default function SpyRealtimeTab({ castFilter }: { castFilter: 'own' | 'competitor' }) {
  const { user } = useAuth();
  const [selectedCast, setSelectedCast] = useState<string | undefined>(undefined);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('spy_msg_filters');
        if (saved) {
          const parsed = JSON.parse(saved) as FilterKey[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            return new Set(parsed);
          }
        }
      } catch { /* ignored */ }
    }
    return new Set(MSG_TYPE_FILTERS.map(f => f.key));
  });
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
  const [castNamesLoaded, setCastNamesLoaded] = useState(false);
  const [castMonitorStatus, setCastMonitorStatus] = useState<Map<string, Date>>(new Map());
  const [castTagsMap, setCastTagsMap] = useState<Record<string, { genre?: string | null; benchmark?: string | null; category?: string | null }>>({});
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
        const p1 = whisperSbRef.current
          .from('registered_casts')
          .select('cast_name, genre, benchmark, category')
          .eq('account_id', data.id)
          .eq('is_active', true)
          .limit(100);
        const p2 = whisperSbRef.current
          .from('spy_casts')
          .select('cast_name, genre, benchmark, category')
          .eq('account_id', data.id)
          .eq('is_active', true)
          .limit(100);

        // 両方のキャスト名ロード完了後に、spy_castsから自社キャストを除外してセット
        Promise.all([p1, p2]).then(([regRes, spyRes]) => {
          const regCasts = regRes.data || [];
          const ownNames = new Set(regCasts.map(c => c.cast_name));
          setRegisteredCastNames(ownNames);
          const tagsMap1: Record<string, { genre?: string | null; benchmark?: string | null; category?: string | null }> = {};
          regCasts.forEach(c => { tagsMap1[c.cast_name] = { genre: c.genre, benchmark: c.benchmark, category: c.category }; });

          const spyCasts = (spyRes.data || []).filter(c => !ownNames.has(c.cast_name));
          setSpyCastNames(new Set(spyCasts.map(c => c.cast_name)));
          const tagsMap2: Record<string, { genre?: string | null; benchmark?: string | null; category?: string | null }> = {};
          spyCasts.forEach(c => { tagsMap2[c.cast_name] = { genre: c.genre, benchmark: c.benchmark, category: c.category }; });

          setCastTagsMap(prev => ({ ...prev, ...tagsMap1, ...tagsMap2 }));
          setCastNamesLoaded(true);
        });

        // Cast monitoring status: latest message per cast
        whisperSbRef.current
          .from('chat_logs')
          .select('cast_name, created_at')
          .eq('account_id', data.id)
          .order('created_at', { ascending: false })
          .limit(10000)
          .then(({ data: monitorData }) => {
            const statusMap = new Map<string, Date>();
            (monitorData || []).forEach((m: { cast_name: string; created_at: string }) => {
              if (m.cast_name && !statusMap.has(m.cast_name)) {
                statusMap.set(m.cast_name, new Date(m.created_at));
              }
            });
            setCastMonitorStatus(statusMap);
          });
      }
    });
  }, [user]);

  // Filter cast list based on castFilter prop
  const filteredCastNames = useMemo(() => {
    if (castFilter === 'own') {
      return castNames.filter(n => registeredCastNames.has(n));
    }
    return castNames.filter(n => spyCastNames.has(n));
  }, [castNames, registeredCastNames, spyCastNames, castFilter]);

  // Filter messages to only show casts from the relevant table
  // castNamesLoaded前は空配列を返す（全件フォールバックによるキャスト間混在を防止）
  const scopedAllMessages = useMemo(() => {
    if (!castNamesLoaded) return [];
    const relevantNames = castFilter === 'own' ? registeredCastNames : spyCastNames;
    return allMessages.filter(m => relevantNames.has(m.cast_name));
  }, [allMessages, registeredCastNames, spyCastNames, castFilter, castNamesLoaded]);

  const scopedMessages = useMemo(() => {
    if (selectedCast) return scopedAllMessages.filter(m => m.cast_name === selectedCast);
    return scopedAllMessages;
  }, [scopedAllMessages, selectedCast]);


  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [scopedMessages, autoScroll]);

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
      if (scopedMessages.length > 0) {
        setLastMsgAgo(timeAgo(scopedMessages[scopedMessages.length - 1].message_time));
      } else {
        setLastMsgAgo('--');
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [scopedMessages]);

  // Viewer stats (only for own casts, cast_nameフィルタ付き)
  useEffect(() => {
    if (!user || castFilter !== 'own') return;
    const supabase = createClient();
    const loadViewer = () => {
      if (!accountId) return;
      let query = supabase.from('viewer_stats')
        .select('total, coin_users, others, recorded_at, cast_name')
        .eq('account_id', accountId);
      // 特定キャスト選択時はフィルタ、未選択時は自社キャスト全体の最新
      if (selectedCast) {
        query = query.eq('cast_name', selectedCast);
      } else if (registeredCastNames.size > 0) {
        query = query.in('cast_name', Array.from(registeredCastNames));
      }
      query
        .order('recorded_at', { ascending: false })
        .limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) setLatestViewer(data[0] as ViewerStat);
        });
    };
    loadViewer();
    const interval = setInterval(loadViewer, 30000);
    return () => clearInterval(interval);
  }, [user, castFilter, selectedCast, registeredCastNames, accountId]);

  // Filtered messages
  const allFilterTypes = useMemo(() => {
    const types = new Set<string>();
    for (const f of MSG_TYPE_FILTERS) {
      if (activeFilters.has(f.key)) f.types.forEach(t => types.add(t));
    }
    return types;
  }, [activeFilters]);

  const filteredMessages = useMemo(() => {
    let filtered = scopedMessages;
    if (hiddenCasts.size > 0) filtered = filtered.filter(m => !hiddenCasts.has(m.cast_name));
    if (activeFilters.size < MSG_TYPE_FILTERS.length) filtered = filtered.filter(m => allFilterTypes.has(m.msg_type));
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(m =>
        (m.user_name?.toLowerCase().includes(q)) || (m.message?.toLowerCase().includes(q))
      );
    }
    return filtered;
  }, [scopedMessages, searchQuery, hiddenCasts, activeFilters, allFilterTypes]);

  // Today stats (scoped)
  const todayStats = useMemo(() => {
    const totalMessages = scopedAllMessages.length;
    const totalTips = scopedAllMessages.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift').reduce((s, m) => s + (m.tokens || 0), 0);
    const uniqueUsers = new Set(scopedAllMessages.filter(m => m.user_name).map(m => m.user_name)).size;
    return { totalMessages, totalTips, uniqueUsers };
  }, [scopedAllMessages]);

  // Realtime stats (scoped)
  const realtimeStats = useMemo(() => {
    const now = Date.now();
    const tipMap = new Map<string, number>();
    scopedAllMessages.forEach(m => {
      if (m.tokens > 0 && m.user_name && (m.msg_type === 'tip' || m.msg_type === 'gift')) {
        tipMap.set(m.user_name, (tipMap.get(m.user_name) || 0) + m.tokens);
      }
    });
    const topTippers = Array.from(tipMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, tokens]) => ({ name, tokens }));
    const fiveMinAgo = now - 300000;
    const activeUsers = new Set(scopedAllMessages.filter(m => m.user_name && new Date(m.message_time).getTime() > fiveMinAgo).map(m => m.user_name)).size;
    const oneMinAgo = now - 60000;
    const recentMsgCount = scopedAllMessages.filter(m => new Date(m.message_time).getTime() > oneMinAgo).length;
    const totalMinutes = scopedAllMessages.length > 1
      ? (new Date(scopedAllMessages[scopedAllMessages.length - 1].message_time).getTime() - new Date(scopedAllMessages[0].message_time).getTime()) / 60000
      : 1;
    const avgSpeed = totalMinutes > 0 ? scopedAllMessages.length / totalMinutes : 0;
    const isHype = recentMsgCount > avgSpeed * 1.5 && recentMsgCount > 3;
    return { topTippers, activeUsers, chatSpeed: recentMsgCount, avgSpeed, isHype };
  }, [scopedAllMessages]);

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

  // Persist filter state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('spy_msg_filters', JSON.stringify(Array.from(activeFilters)));
    } catch { /* ignored */ }
  }, [activeFilters]);

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
      const cn = selectedCast || filteredCastNames[0] || null;
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
  }, [whisperText, whisperTemplate, accountId, selectedCast, filteredCastNames]);

  const connectionStatus = useMemo(() => {
    if (isConnected && scopedAllMessages.length > 0) {
      const lastMsg = scopedAllMessages[scopedAllMessages.length - 1];
      const lastTime = lastMsg?.message_time ? new Date(lastMsg.message_time).getTime() : 0;
      if (Date.now() - lastTime > 120000) return 'paused';
      return 'active';
    }
    if (isConnected) return 'active';
    return 'stopped';
  }, [isConnected, scopedAllMessages]);

  const statusConfig = {
    active:  { dot: 'bg-emerald-400', text: '監視中',   color: '#22c55e' },
    paused:  { dot: 'bg-amber-400',   text: '一時停止', color: '#f59e0b' },
    stopped: { dot: 'bg-red-400',     text: '停止',     color: '#f43f5e' },
  };
  const status = statusConfig[connectionStatus];

  const isOwn = castFilter === 'own';
  const accentColor = isOwn ? '#f59e0b' : '#06b6d4';
  const accentBg = isOwn ? 'rgba(245,158,11,0.08)' : 'rgba(6,182,212,0.08)';
  const accentBorder = isOwn ? 'rgba(245,158,11,0.2)' : 'rgba(6,182,212,0.2)';

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
          {castFilter === 'own' && latestViewer && latestViewer.total != null && (
            <>
              <div className="h-4 w-px bg-slate-700" />
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                視聴者 <span className="font-semibold text-sky-400">{latestViewer.total}</span>
                <span className="ml-1 text-[10px]">(コイン {latestViewer.coin_users ?? 0} / その他 {latestViewer.others ?? 0})</span>
              </div>
            </>
          )}
          <div className="ml-auto">
            <span className="text-[9px] px-2 py-0.5 rounded-full font-bold" style={{ background: `${accentColor}15`, color: accentColor }}>
              {isOwn ? '自社' : '他社'}
            </span>
          </div>
        </div>
      </div>

      {/* Cast Monitoring Status */}
      {castMonitorStatus.size > 0 && (
        <div className="flex flex-wrap gap-2 flex-shrink-0">
          {Array.from(castMonitorStatus.entries()).map(([name, lastTime]) => {
            const minutesAgo = (Date.now() - lastTime.getTime()) / 60000;
            const statusKey = minutesAgo < 5 ? 'live' : minutesAgo < 30 ? 'idle' : 'offline';
            const colors = {
              live: { bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.2)', text: '#22c55e', dot: 'bg-emerald-400 anim-live' },
              idle: { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.2)', text: '#f59e0b', dot: 'bg-amber-400' },
              offline: { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.2)', text: '#ef4444', dot: 'bg-red-400' },
            }[statusKey];
            return (
              <div key={name} className="px-3 py-1.5 rounded-lg text-xs flex items-center gap-2"
                style={{ background: colors.bg, border: `1px solid ${colors.border}` }}>
                <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                <span style={{ color: colors.text }}>{name}</span>
                <span style={{ color: 'var(--text-muted)' }} className="text-[10px]">
                  {minutesAgo < 1 ? 'たった今' : `${Math.floor(minutesAgo)}分前`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
        {/* Left: Cast List */}
        <div className="w-56 flex-shrink-0 glass-card p-3 flex flex-col hidden lg:flex">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold" style={{ color: accentColor }}>
              {isOwn ? '🏠 自社キャスト' : '🔍 他社キャスト'}
            </h3>
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 anim-live' : 'bg-slate-600'}`}
              title={isConnected ? 'Realtime接続中' : '未接続'} />
          </div>

          <button
            onClick={() => setSelectedCast(undefined)}
            className={`w-full text-left p-2.5 rounded-xl transition-all duration-200 mb-1 text-xs ${!selectedCast ? 'border' : 'hover:bg-white/[0.03]'}`}
            style={!selectedCast ? { background: accentBg, borderColor: accentBorder } : {}}
          >
            <span className="font-semibold">📡 全キャスト</span>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{scopedAllMessages.length} 件のログ</p>
          </button>

          <div className="flex-1 space-y-1 overflow-auto">
            {filteredCastNames.map(name => {
              const isActive = selectedCast === name;
              const isHidden = hiddenCasts.has(name);
              const count = scopedAllMessages.filter(m => m.cast_name === name).length;
              return (
                <div key={name} className="flex items-center gap-1">
                  <button
                    onClick={() => setSelectedCast(name)}
                    className={`flex-1 text-left p-2.5 rounded-xl transition-all duration-200 text-xs ${isActive ? 'border' : 'hover:bg-white/[0.03]'} ${isHidden ? 'opacity-40' : ''}`}
                    style={isActive ? { background: accentBg, borderColor: accentBorder } : {}}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold truncate">{name}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-[8px] py-0.5 px-1 rounded" style={{ background: `${accentColor}20`, color: accentColor }}>
                          {isOwn ? '自社' : 'SPY'}
                        </span>
                        <span className="badge-live text-[8px] py-0.5 px-1">LIVE</span>
                      </div>
                    </div>
                    {castTagsMap[name] && (castTagsMap[name].benchmark || castTagsMap[name].category) && (
                      <div className="flex flex-wrap gap-0.5 mt-0.5">
                        {castTagsMap[name].benchmark && (
                          <span className="text-[7px] px-1 py-0 rounded font-semibold" style={{ color: '#22c55e', background: 'rgba(34,197,94,0.12)' }}>{castTagsMap[name].benchmark}</span>
                        )}
                        {castTagsMap[name].category && (
                          <span className="text-[7px] px-1 py-0 rounded font-semibold" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>{castTagsMap[name].category}</span>
                        )}
                      </div>
                    )}
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{count > 0 ? `${count} 件` : 'ログなし'}</p>
                  </button>
                  <button onClick={() => toggleCastVisibility(name)} className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-[11px]"
                    title={isHidden ? 'ログ表示' : 'ログ非表示'} style={{ color: isHidden ? 'var(--text-muted)' : accentColor }}>
                    {isHidden ? '👁‍🗨' : '👁'}
                  </button>
                  {!isOwn && spyCastNames.has(name) && (
                    <Link href={`/spy/${encodeURIComponent(name)}`} className="p-1.5 text-[10px] hover:opacity-70" style={{ color: accentColor }} title="スパイ詳細">🔍</Link>
                  )}
                  <button onClick={() => handleDeleteCast(name)} disabled={deletingCast === name}
                    className="p-1.5 rounded-lg hover:bg-rose-500/10 transition-all text-[11px] disabled:opacity-30" title="本日のログ削除" style={{ color: 'var(--accent-pink)' }}>
                    🗑
                  </button>
                </div>
              );
            })}
            {filteredCastNames.length === 0 && (
              <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>
                {isOwn ? '自社キャストのログがありません' : '他社キャストのログがありません'}
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

        {/* Center: Chat Log */}
        <div className="flex-1 glass-card p-4 flex flex-col min-w-0">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <div>
              <h2 className="text-sm font-bold flex items-center gap-2">
                {isOwn ? '🏠' : '🔍'} {isOwn ? '自社ログ' : 'スパイログ'} {realtimeStats.isHype && <span className="text-xs" title="盛り上がり検出">🔥</span>}
              </h2>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {selectedCast ? `Target: ${selectedCast}` : `全${isOwn ? '自社' : '他社'}キャスト`}
                {isConnected && <span className="ml-2 text-emerald-400">● LIVE</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-2 py-1 rounded-lg" style={{ background: accentBg, color: accentColor }}>
                {filteredMessages.length} 件
              </span>
              {isOwn && <button onClick={() => setSidePanelOpen(!sidePanelOpen)} className="xl:hidden text-xs px-2 py-1 rounded-lg hover:bg-white/5" style={{ color: 'var(--text-muted)' }}>📊</button>}
            </div>
          </div>

          {/* Message type filter */}
          <div className="flex-shrink-0 flex gap-1.5 mb-2 flex-wrap">
            <button onClick={toggleAllFilters} className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
              style={{ background: activeFilters.size === MSG_TYPE_FILTERS.length ? `${accentColor}15` : 'rgba(100,116,139,0.1)',
                color: activeFilters.size === MSG_TYPE_FILTERS.length ? accentColor : 'var(--text-muted)',
                border: `1px solid ${activeFilters.size === MSG_TYPE_FILTERS.length ? `${accentColor}40` : 'rgba(100,116,139,0.15)'}` }}>
              全部
            </button>
            {MSG_TYPE_FILTERS.map(f => {
              const isOn = activeFilters.has(f.key);
              return (
                <button key={f.key} onClick={() => toggleMsgFilter(f.key)} className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                  style={{ background: isOn ? `${accentColor}12` : 'rgba(100,116,139,0.06)',
                    color: isOn ? '#e2e8f0' : 'var(--text-muted)',
                    border: `1px solid ${isOn ? `${accentColor}30` : 'rgba(100,116,139,0.1)'}`, opacity: isOn ? 1 : 0.5 }}>
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
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{searchQuery ? '検索結果なし' : 'SPYログがありません'}</p>
                {!searchQuery && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>SPY対象のキャストが配信中になるとメッセージが表示されます</p>}
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

          {/* Whisper — only for own casts */}
          {castFilter === 'own' && (
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
          )}
        </div>

        {/* Right: Stats Sidebar — 自社ビューのみ表示 */}
        {isOwn && (
          <div className={`w-64 flex-shrink-0 space-y-3 overflow-auto ${sidePanelOpen ? 'block' : 'hidden'} xl:block`}>
            <div className="glass-card p-4">
              <h3 className="text-xs font-bold mb-3">💰 トップチッパー</h3>
              {realtimeStats.topTippers.length === 0 ? (
                <p className="text-[10px] text-center py-2" style={{ color: 'var(--text-muted)' }}>まだチップがありません</p>
              ) : (
                <div className="space-y-2">
                  {realtimeStats.topTippers.map((t, i) => (
                    <div key={t.name} className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-bold w-4 text-center" style={{
                          color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)' }}>{i + 1}</span>
                        <Link href={`/spy/users/${encodeURIComponent(t.name)}`} className="truncate font-medium hover:text-sky-400 transition-colors">{t.name}</Link>
                      </div>
                      <span className="flex-shrink-0 font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>{formatTokens(t.tokens)}</span>
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
                  <span className="font-bold" style={{ color: realtimeStats.isHype ? '#f59e0b' : accentColor }}>{realtimeStats.chatSpeed} msg/min</span>
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
                        background: realtimeStats.isHype ? 'linear-gradient(90deg, #f59e0b, #ef4444)' : `linear-gradient(90deg, ${accentColor}99, ${accentColor}4D)` }} />
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
        )}
      </div>
    </>
  );
}
