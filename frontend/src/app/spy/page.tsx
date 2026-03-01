'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { useRealtimeSpy } from '@/hooks/use-realtime-spy';
import { ChatMessage } from '@/components/chat-message';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, timeAgo, tokensToJPY } from '@/lib/utils';
import { detectTicketShows } from '@/lib/ticket-show-detector';
import { calculateCVR } from '@/lib/cvr-calculator';
import type { TicketShow } from '@/lib/ticket-show-detector';
import type { TicketShowCVR, ViewerSnapshot } from '@/lib/cvr-calculator';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { SpyCast, RegisteredCast, CastType } from '@/types';

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
  { key: 'tip',     label: '🪙 チップ',   types: ['tip', 'gift', 'group_join', 'group_end'] },
  { key: 'speech',  label: '🎤 音声',     types: ['speech'] },
  { key: 'enter',   label: '🚪 入退室',   types: ['enter', 'leave'] },
  { key: 'system',  label: '⚙️ システム', types: ['goal', 'viewer_count', 'system'] },
] as const;

type FilterKey = typeof MSG_TYPE_FILTERS[number]['key'];
type MainView = 'own' | 'competitor';
type OwnSubTab = 'realtime' | 'cast-list' | 'reports';
type CompetitorSubTab = 'realtime' | 'cast-list' | 'type-catalog' | 'market';

/* ============================================================
   Main Page
   ============================================================ */
export default function SpyPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [openResult, setOpenResult] = useState<string | null>(null);

  const viewParam = searchParams.get('view') as MainView | null;
  const [mainView, setMainView] = useState<MainView>(viewParam === 'own' || viewParam === 'competitor' ? viewParam : 'own');
  const [ownSubTab, setOwnSubTab] = useState<OwnSubTab>('realtime');
  const [competitorSubTab, setCompetitorSubTab] = useState<CompetitorSubTab>('realtime');

  const handleMainViewChange = useCallback((view: MainView) => {
    setMainView(view);
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    router.replace(url.pathname + url.search, { scroll: false });
  }, [router]);

  // Sync from URL on mount
  useEffect(() => {
    if (viewParam === 'own' || viewParam === 'competitor') {
      setMainView(viewParam);
    }
  }, [viewParam]);

  const handleOpenAllTabs = useCallback(() => {
    setOpenResult('Chrome拡張のポップアップ → 「全タブオープン」ボタンを押してください');
    setTimeout(() => setOpenResult(null), 5000);
  }, []);

  if (!user) return null;

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-2 overflow-hidden">
      {/* Main Tab Navigation */}
      <div className="glass-card px-5 py-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          {/* Own Casts Tab */}
          <button
            onClick={() => handleMainViewChange('own')}
            className="px-5 py-2.5 rounded-xl text-xs font-bold transition-all"
            style={{
              background: mainView === 'own'
                ? 'linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05))'
                : 'transparent',
              color: mainView === 'own' ? '#f59e0b' : 'var(--text-muted)',
              border: mainView === 'own'
                ? '1px solid rgba(245,158,11,0.3)'
                : '1px solid transparent',
              boxShadow: mainView === 'own' ? '0 0 12px rgba(245,158,11,0.1)' : 'none',
            }}
          >
            🏠 自社キャスト
          </button>

          {/* Competitor Casts Tab */}
          <button
            onClick={() => handleMainViewChange('competitor')}
            className="px-5 py-2.5 rounded-xl text-xs font-bold transition-all"
            style={{
              background: mainView === 'competitor'
                ? 'linear-gradient(135deg, rgba(6,182,212,0.15), rgba(6,182,212,0.05))'
                : 'transparent',
              color: mainView === 'competitor' ? '#06b6d4' : 'var(--text-muted)',
              border: mainView === 'competitor'
                ? '1px solid rgba(6,182,212,0.3)'
                : '1px solid transparent',
              boxShadow: mainView === 'competitor' ? '0 0 12px rgba(6,182,212,0.1)' : 'none',
            }}
          >
            🔍 他社キャスト
          </button>

          {/* 全タブ一斉オープン */}
          <button
            onClick={handleOpenAllTabs}
            className="ml-auto px-3 py-2 rounded-xl text-[11px] font-bold transition-all flex items-center gap-1.5"
            style={{
              background: 'linear-gradient(135deg, rgba(34,197,94,0.12), rgba(34,197,94,0.04))',
              color: '#22c55e',
              border: '1px solid rgba(34,197,94,0.2)',
            }}
          >
            🖥️ 全タブオープン
          </button>
          {openResult && (
            <span className="text-[10px] font-semibold" style={{ color: 'var(--accent-amber)' }}>{openResult}</span>
          )}
        </div>

        {/* Sub-tab Navigation */}
        <div className="flex items-center gap-1 mt-2">
          {mainView === 'own' ? (
            <>
              {([
                { key: 'realtime' as OwnSubTab,  label: 'リアルタイム', icon: '📡' },
                { key: 'cast-list' as OwnSubTab,  label: 'キャスト一覧', icon: '📋' },
                { key: 'reports' as OwnSubTab,    label: 'FBレポート',  icon: '🤖' },
              ]).map(t => (
                <button
                  key={t.key}
                  onClick={() => setOwnSubTab(t.key)}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
                  style={{
                    background: ownSubTab === t.key ? 'rgba(245,158,11,0.10)' : 'transparent',
                    color: ownSubTab === t.key ? '#f59e0b' : 'var(--text-muted)',
                    border: ownSubTab === t.key ? '1px solid rgba(245,158,11,0.2)' : '1px solid transparent',
                  }}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </>
          ) : (
            <>
              {([
                { key: 'realtime' as CompetitorSubTab,          label: 'リアルタイム', icon: '📡' },
                { key: 'cast-list' as CompetitorSubTab,         label: 'キャスト一覧', icon: '📋' },
                { key: 'market' as CompetitorSubTab,            label: 'マーケット分析', icon: '📊' },
                { key: 'type-catalog' as CompetitorSubTab,      label: '型カタログ', icon: '📦' },
              ]).map(t => (
                <button
                  key={t.key}
                  onClick={() => setCompetitorSubTab(t.key)}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
                  style={{
                    background: competitorSubTab === t.key ? 'rgba(6,182,212,0.10)' : 'transparent',
                    color: competitorSubTab === t.key ? '#06b6d4' : 'var(--text-muted)',
                    border: competitorSubTab === t.key ? '1px solid rgba(6,182,212,0.2)' : '1px solid transparent',
                  }}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Tab Content */}
      {mainView === 'own' && ownSubTab === 'realtime' && <RealtimeTab castFilter="own" />}
      {mainView === 'own' && ownSubTab === 'cast-list' && <OwnCastListTab />}
      {mainView === 'own' && ownSubTab === 'reports' && <FBReportsTab />}
      {mainView === 'competitor' && competitorSubTab === 'realtime' && <RealtimeTab castFilter="competitor" />}
      {mainView === 'competitor' && competitorSubTab === 'cast-list' && <SpyListTab />}
      {mainView === 'competitor' && competitorSubTab === 'market' && <MarketAnalysisTab />}
      {mainView === 'competitor' && competitorSubTab === 'type-catalog' && <TypeCatalogTab />}
    </div>
  );
}

/* ============================================================
   Realtime Tab — shared for both own & competitor
   ============================================================ */
function RealtimeTab({ castFilter }: { castFilter: 'own' | 'competitor' }) {
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
        whisperSbRef.current
          .from('registered_casts')
          .select('cast_name, genre, benchmark, category')
          .eq('account_id', data.id)
          .eq('is_active', true)
          .limit(100)
          .then(({ data: casts }) => {
            if (casts) {
              setRegisteredCastNames(new Set(casts.map(c => c.cast_name)));
              const tagsMap: Record<string, { genre?: string | null; benchmark?: string | null; category?: string | null }> = {};
              casts.forEach(c => { tagsMap[c.cast_name] = { genre: c.genre, benchmark: c.benchmark, category: c.category }; });
              setCastTagsMap(prev => ({ ...prev, ...tagsMap }));
            }
          });
        whisperSbRef.current
          .from('spy_casts')
          .select('cast_name, genre, benchmark, category')
          .eq('account_id', data.id)
          .eq('is_active', true)
          .limit(100)
          .then(({ data: casts }) => {
            if (casts) {
              setSpyCastNames(new Set(casts.map(c => c.cast_name)));
              const tagsMap: Record<string, { genre?: string | null; benchmark?: string | null; category?: string | null }> = {};
              casts.forEach(c => { tagsMap[c.cast_name] = { genre: c.genre, benchmark: c.benchmark, category: c.category }; });
              setCastTagsMap(prev => ({ ...prev, ...tagsMap }));
            }
          });

        // Cast monitoring status: latest message per cast
        whisperSbRef.current
          .from('spy_messages')
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
  const scopedAllMessages = useMemo(() => {
    const relevantNames = castFilter === 'own' ? registeredCastNames : spyCastNames;
    if (relevantNames.size === 0) return allMessages;
    return allMessages.filter(m => relevantNames.has(m.cast_name));
  }, [allMessages, registeredCastNames, spyCastNames, castFilter]);

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
      let query = supabase.from('viewer_stats')
        .select('total, coin_users, others, recorded_at, cast_name');
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
  }, [user, castFilter, selectedCast, registeredCastNames]);

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

/* ============================================================
   Own Cast List Tab — registered_casts 一覧
   ============================================================ */
function OwnCastListTab() {
  const { user } = useAuth();
  const [casts, setCasts] = useState<RegisteredCast[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [newCastName, setNewCastName] = useState('');
  const [addingCast, setAddingCast] = useState(false);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }
      setAccountId(data.id);

      const { data: castData } = await supabase
        .from('registered_casts')
        .select('*')
        .eq('account_id', data.id)
        .order('created_at', { ascending: false })
        .limit(100);

      if (castData) setCasts(castData as RegisteredCast[]);
      setLoading(false);
    });
  }, [user]);

  const handleAddCast = useCallback(async () => {
    const name = newCastName.trim();
    if (!name || !accountId) return;
    setAddingCast(true);
    const supabase = createClient();
    const { data, error } = await supabase.from('registered_casts').insert({
      account_id: accountId,
      cast_name: name,
      stripchat_url: `https://stripchat.com/${name}`,
    }).select('*').single();

    if (!error && data) {
      setCasts(prev => [data as RegisteredCast, ...prev]);
      setNewCastName('');
    }
    setAddingCast(false);
  }, [newCastName, accountId]);

  const handleDelete = useCallback(async (id: number) => {
    if (!confirm('このキャストを削除しますか？')) return;
    const supabase = createClient();
    await supabase.from('registered_casts').delete().eq('id', id);
    setCasts(prev => prev.filter(c => c.id !== id));
  }, []);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  return (
    <div className="flex-1 overflow-auto">
      {/* Add new cast */}
      <div className="glass-card p-4 mb-3">
        <h3 className="text-xs font-bold mb-3" style={{ color: '#f59e0b' }}>自社キャスト追加</h3>
        <div className="flex gap-2">
          <input type="text" value={newCastName} onChange={e => setNewCastName(e.target.value)}
            className="input-glass flex-1 text-xs" placeholder="キャスト名（Stripchat username）"
            onKeyDown={e => { if (e.key === 'Enter') handleAddCast(); }} />
          <button onClick={handleAddCast} disabled={addingCast || !newCastName.trim()}
            className="text-[11px] px-4 py-2 rounded-lg font-semibold transition-all disabled:opacity-50"
            style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' }}>
            {addingCast ? '追加中...' : '追加'}
          </button>
        </div>
      </div>

      {/* Casts table */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3" style={{ color: '#f59e0b' }}>🏠 自社キャスト一覧 ({casts.length})</h3>
        {casts.length === 0 ? (
          <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>自社キャストが登録されていません</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                  <th className="w-16 py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}></th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>キャスト名</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>表示名</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>Stripchat URL</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>ステータス</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>最終配信</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>登録日</th>
                  <th className="text-right py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {casts.map(cast => (
                  <tr key={cast.id} className="border-b hover:bg-white/[0.02] transition-colors" style={{
                    borderColor: 'rgba(245,158,11,0.05)',
                    opacity: cast.is_extinct ? 0.5 : 1,
                  }}>
                    <td className="py-1 px-2 w-16">
                      {cast.stripchat_model_id ? (
                        <img
                          src={`/api/screenshot?model_id=${cast.stripchat_model_id}`}
                          alt={cast.cast_name}
                          className="w-14 h-10 object-cover rounded"
                          style={{ border: '1px solid rgba(245,158,11,0.15)' }}
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-14 h-10 rounded flex items-center justify-center text-[9px]"
                          style={{ background: 'rgba(245,158,11,0.05)', color: 'var(--text-muted)', border: '1px solid rgba(245,158,11,0.1)' }}>
                          No ID
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 px-2">
                      <Link href={`/casts/${encodeURIComponent(cast.cast_name)}`}
                        className="font-semibold hover:text-amber-400 transition-colors"
                        style={{ color: cast.is_extinct ? 'var(--text-muted)' : undefined }}>
                        {cast.is_extinct && <span title="消滅キャスト">&#x1FAA6; </span>}{cast.cast_name}
                      </Link>
                    </td>
                    <td className="py-2.5 px-2" style={{ color: 'var(--text-secondary)' }}>{cast.display_name || '-'}</td>
                    <td className="py-2.5 px-2">
                      {cast.stripchat_url ? (
                        <a href={cast.stripchat_url} target="_blank" rel="noopener noreferrer" className="text-[10px] hover:text-amber-400 transition-colors truncate block max-w-[200px]" style={{ color: 'var(--text-muted)' }}>
                          {cast.stripchat_url}
                        </a>
                      ) : '-'}
                    </td>
                    <td className="py-2.5 px-2">
                      {cast.is_extinct ? (
                        <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                          background: 'rgba(107,114,128,0.12)',
                          color: '#6b7280',
                        }}>消滅</span>
                      ) : (
                        <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                          background: cast.is_active ? 'rgba(34,197,94,0.12)' : 'rgba(244,63,94,0.12)',
                          color: cast.is_active ? 'var(--accent-green)' : 'var(--accent-pink)',
                        }}>
                          {cast.is_active ? 'アクティブ' : '無効'}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {cast.last_seen_online ? timeAgo(cast.last_seen_online) : '-'}
                    </td>
                    <td className="py-2.5 px-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {new Date(cast.created_at).toLocaleDateString('ja-JP')}
                    </td>
                    <td className="py-2.5 px-2 text-right">
                      <button onClick={() => handleDelete(cast.id)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-rose-500/10" style={{ color: 'var(--accent-pink)' }} title="削除">&#x1F5D1;</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   FB Reports Tab — AI reports for own casts
   ============================================================ */
function FBReportsTab() {
  const { user } = useAuth();
  const [reports, setReports] = useState<{
    id: string; account_id: string; session_id: string | null; cast_name: string | null;
    report_type: string; output_text: string; model: string; tokens_used: number; cost_usd: number; created_at: string;
  }[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }

      const { data: reportData } = await supabase.from('ai_reports')
        .select('*')
        .eq('account_id', data.id)
        .eq('report_type', 'session_analysis')
        .order('created_at', { ascending: false })
        .limit(100);

      if (reportData) setReports(reportData);
      setLoading(false);
    });
  }, [user]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  const fmtDate = (d: string) =>
    new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex-1 overflow-auto space-y-3">
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-1" style={{ color: '#f59e0b' }}>🤖 FBレポート</h3>
        <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>自社キャストの配信セッションAI分析レポート</p>
      </div>

      {reports.length === 0 ? (
        <div className="glass-card p-10 text-center">
          <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>AIレポートがありません</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            配信セッションページで「AIレポート生成」ボタンを押すと、AI分析レポートが作成されます。
          </p>
          <Link href="/reports" className="inline-block mt-4 text-[11px] px-4 py-2 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' }}>
            レポートページへ →
          </Link>
        </div>
      ) : (
        reports.map(report => {
          const isExpanded = expandedId === report.id;
          const preview = report.output_text.slice(0, 200).replace(/\n/g, ' ');

          return (
            <div key={report.id} className="glass-card overflow-hidden">
              <button
                onClick={() => setExpandedId(isExpanded ? null : report.id)}
                className="w-full text-left p-5 transition-all duration-200 hover:bg-white/[0.02]"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-base">🤖</span>
                    <h3 className="text-sm font-bold">
                      {report.cast_name || report.session_id?.slice(0, 8) || 'レポート'}
                    </h3>
                  </div>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {isExpanded ? '▲ 閉じる' : '▼ 展開'}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                  <span>生成: {fmtDate(report.created_at)}</span>
                  <span>Tokens: {report.tokens_used.toLocaleString()}</span>
                  <span>Cost: ${report.cost_usd.toFixed(4)}</span>
                </div>
                {!isExpanded && (
                  <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{preview}...</p>
                )}
              </button>
              {isExpanded && (
                <div className="px-5 pb-5 border-t" style={{ borderColor: 'var(--border-glass)' }}>
                  <div className="pt-4 text-xs leading-relaxed space-y-3" style={{ color: 'var(--text-secondary)' }}>
                    {report.output_text.split('\n').map((line, li) => {
                      if (line.startsWith('## ')) return <h5 key={li} className="text-sm font-bold mt-4 mb-1" style={{ color: 'var(--text-primary)' }}>{line.replace('## ', '')}</h5>;
                      if (line.startsWith('### ')) return <h6 key={li} className="text-xs font-bold mt-3 mb-1" style={{ color: '#f59e0b' }}>{line.replace('### ', '')}</h6>;
                      if (line.startsWith('- ')) return <p key={li} className="pl-3" style={{ borderLeft: '2px solid rgba(245,158,11,0.3)' }}>{line.replace('- ', '')}</p>;
                      if (line.startsWith('**') && line.endsWith('**')) return <p key={li} className="font-semibold" style={{ color: 'var(--text-primary)' }}>{line.replace(/\*\*/g, '')}</p>;
                      if (line.trim() === '') return <div key={li} className="h-1" />;
                      return <p key={li}>{line}</p>;
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

/* ============================================================
   Tag Presets
   ============================================================ */
const GENRE_PRESETS = ['女性単体', '絡み配信', 'カップル', 'レズ', '3P+', '男性単体'] as const;
const BENCHMARK_PRESETS = ['新人', '中堅', 'ランカー', 'ベテラン'] as const;
const CATEGORY_PRESETS = ['人妻', '女子大生', 'ギャル', 'お姉さん', '清楚系', '熟女', 'コスプレ', 'その他'] as const;

/* ============================================================
   TagBadge — small colored inline badge
   ============================================================ */
function TagBadge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap" style={{ color, background: bg }}>
      {label}
    </span>
  );
}

function CastTagBadges({ genre, benchmark, category }: { genre?: string | null; benchmark?: string | null; category?: string | null }) {
  if (!genre && !benchmark && !category) return null;
  return (
    <div className="flex flex-wrap gap-0.5 mt-0.5">
      {genre && <TagBadge label={genre} color="#38bdf8" bg="rgba(56,189,248,0.12)" />}
      {benchmark && <TagBadge label={benchmark} color="#22c55e" bg="rgba(34,197,94,0.12)" />}
      {category && <TagBadge label={category} color="#a78bfa" bg="rgba(167,139,250,0.12)" />}
    </div>
  );
}

/* ============================================================
   Spy List Tab — spy_casts 一覧テーブル (competitor)
   ============================================================ */
function SpyListTab() {
  const { user } = useAuth();
  const router = useRouter();
  const [spyCasts, setSpyCasts] = useState<SpyCast[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, { total_messages: number; total_coins: number; unique_users: number; last_activity: string | null }>>({});
  const [newCastName, setNewCastName] = useState('');
  const [addingCast, setAddingCast] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFields, setEditFields] = useState<{ genre: string; benchmark: string; category: string; format_tag: string; notes: string; screenshot_interval: number; stripchat_model_id: string }>({ genre: '', benchmark: '', category: '', format_tag: '', notes: '', screenshot_interval: 0, stripchat_model_id: '' });

  // Filter state
  const [filterGenre, setFilterGenre] = useState('');
  const [filterBenchmark, setFilterBenchmark] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [hideExtinct, setHideExtinct] = useState(false);

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
        .order('created_at', { ascending: false })
        .limit(100);

      if (casts) {
        setSpyCasts(casts as SpyCast[]);
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

  // Filtered casts
  const filteredCasts = useMemo(() => {
    return spyCasts.filter(c => {
      if (hideExtinct && c.is_extinct) return false;
      if (filterGenre && c.genre !== filterGenre) return false;
      if (filterBenchmark && c.benchmark !== filterBenchmark) return false;
      if (filterCategory && c.category !== filterCategory) return false;
      return true;
    });
  }, [spyCasts, filterGenre, filterBenchmark, filterCategory, hideExtinct]);

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
      .update({
        genre: editFields.genre || null,
        benchmark: editFields.benchmark || null,
        category: editFields.category || null,
        format_tag: editFields.format_tag || null,
        notes: editFields.notes || null,
        screenshot_interval: editFields.screenshot_interval || 0,
        stripchat_model_id: editFields.stripchat_model_id || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editingId);
    setSpyCasts(prev => prev.map(c => c.id === editingId ? {
      ...c,
      genre: editFields.genre || null,
      benchmark: editFields.benchmark || null,
      category: editFields.category || null,
      format_tag: editFields.format_tag || null,
      notes: editFields.notes || null,
      screenshot_interval: editFields.screenshot_interval || 0,
      stripchat_model_id: editFields.stripchat_model_id || null,
      updated_at: new Date().toISOString(),
    } : c));
    setEditingId(null);
  }, [editingId, editFields]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  const selectStyle = {
    background: 'rgba(15,23,42,0.6)',
    borderColor: 'var(--border-glass)',
    color: 'var(--text-primary)',
  };

  return (
    <div className="flex-1 overflow-auto">
      {/* Add new spy cast */}
      <div className="glass-card p-4 mb-3">
        <h3 className="text-xs font-bold mb-3" style={{ color: '#06b6d4' }}>スパイキャスト追加</h3>
        <div className="flex gap-2">
          <input type="text" value={newCastName} onChange={e => setNewCastName(e.target.value)}
            className="input-glass flex-1 text-xs" placeholder="キャスト名（Stripchat username）"
            onKeyDown={e => { if (e.key === 'Enter') handleAddCast(); }} />
          <button onClick={handleAddCast} disabled={addingCast || !newCastName.trim()}
            className="text-[11px] px-4 py-2 rounded-lg font-semibold transition-all disabled:opacity-50"
            style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4', border: '1px solid rgba(6,182,212,0.3)' }}>
            {addingCast ? '追加中...' : '追加'}
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="glass-card p-3 mb-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>フィルタ:</span>
          <select value={filterGenre} onChange={e => setFilterGenre(e.target.value)}
            className="text-[10px] px-2 py-1 rounded-lg border outline-none" style={selectStyle}>
            <option value="">ジャンル: 全て</option>
            {GENRE_PRESETS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={filterBenchmark} onChange={e => setFilterBenchmark(e.target.value)}
            className="text-[10px] px-2 py-1 rounded-lg border outline-none" style={selectStyle}>
            <option value="">ベンチマーク: 全て</option>
            {BENCHMARK_PRESETS.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
            className="text-[10px] px-2 py-1 rounded-lg border outline-none" style={selectStyle}>
            <option value="">カテゴリ: 全て</option>
            {CATEGORY_PRESETS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="flex items-center gap-1 text-[10px] cursor-pointer" style={{ color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={hideExtinct} onChange={e => setHideExtinct(e.target.checked)}
              className="w-3 h-3 rounded" />
            消滅キャストを非表示
          </label>
          {(filterGenre || filterBenchmark || filterCategory) && (
            <button onClick={() => { setFilterGenre(''); setFilterBenchmark(''); setFilterCategory(''); }}
              className="text-[10px] px-2 py-1 rounded-lg hover:bg-white/5 transition-all" style={{ color: 'var(--accent-pink)' }}>
              クリア
            </button>
          )}
          <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
            {filteredCasts.length} / {spyCasts.length} 件
          </span>
        </div>
      </div>

      {/* Spy casts table */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3" style={{ color: '#06b6d4' }}>スパイキャスト一覧 ({filteredCasts.length})</h3>
        {filteredCasts.length === 0 ? (
          <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>
            {spyCasts.length === 0 ? 'スパイキャストが登録されていません' : 'フィルタ条件に一致するキャストがありません'}
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                  <th className="w-16 py-2 px-1 font-semibold" style={{ color: 'var(--text-muted)' }}></th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>キャスト</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>タグ</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>MSG</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>COINS</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>USERS</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>最終配信</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>最終活動</th>
                  <th className="text-center py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>📷</th>
                  <th className="text-right py-2 px-2"></th>
                  <th className="w-6 py-2 px-1"></th>
                </tr>
              </thead>
              <tbody>
                {filteredCasts.map(cast => {
                  const s = stats[cast.cast_name];
                  const isEditing = editingId === cast.id;
                  return (
                    <tr key={cast.id} className="border-b group transition-all cursor-pointer" style={{
                      borderColor: 'rgba(6,182,212,0.05)',
                      opacity: cast.is_extinct ? 0.5 : 1,
                      borderLeft: '2px solid transparent',
                    }}
                      onClick={(e) => {
                        // Don't navigate if clicking on interactive elements (buttons, selects, inputs, links)
                        const target = e.target as HTMLElement;
                        if (target.closest('button') || target.closest('select') || target.closest('input') || target.closest('a')) return;
                        router.push(`/spy/${encodeURIComponent(cast.cast_name)}`);
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderLeftColor = '#38bdf8'; e.currentTarget.style.background = 'rgba(56,189,248,0.04)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderLeftColor = 'transparent'; e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td className="py-2.5 px-1 w-16">
                        {cast.stripchat_model_id ? (
                          <img
                            src={`/api/screenshot?model_id=${cast.stripchat_model_id}`}
                            alt={cast.cast_name}
                            className="w-14 h-10 object-cover rounded"
                            loading="lazy"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <div className="w-14 h-10 rounded flex items-center justify-center text-[10px]" style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)' }}>{'📷'}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-2">
                        <span
                          className="font-semibold group-hover:text-cyan-400 transition-colors"
                          style={{ color: cast.is_extinct ? 'var(--text-muted)' : undefined }}>
                          {cast.is_extinct && <span title="消滅キャスト">&#x1FAA6; </span>}{cast.cast_name}
                        </span>
                        {cast.display_name && <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{cast.display_name}</p>}
                        {cast.notes && !isEditing && <p className="text-[9px] mt-0.5 truncate max-w-[180px]" style={{ color: 'var(--text-muted)' }}>{cast.notes}</p>}
                      </td>
                      <td className="py-2.5 px-2">
                        {isEditing ? (
                          <div className="flex flex-col gap-1">
                            <select value={editFields.genre} onChange={e => setEditFields(f => ({ ...f, genre: e.target.value }))}
                              className="text-[10px] px-1.5 py-0.5 rounded border outline-none" style={selectStyle}>
                              <option value="">ジャンル</option>
                              {GENRE_PRESETS.map(g => <option key={g} value={g}>{g}</option>)}
                            </select>
                            <select value={editFields.benchmark} onChange={e => setEditFields(f => ({ ...f, benchmark: e.target.value }))}
                              className="text-[10px] px-1.5 py-0.5 rounded border outline-none" style={selectStyle}>
                              <option value="">ベンチマーク</option>
                              {BENCHMARK_PRESETS.map(b => <option key={b} value={b}>{b}</option>)}
                            </select>
                            <select value={editFields.category} onChange={e => setEditFields(f => ({ ...f, category: e.target.value }))}
                              className="text-[10px] px-1.5 py-0.5 rounded border outline-none" style={selectStyle}>
                              <option value="">カテゴリ</option>
                              {CATEGORY_PRESETS.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <input type="text" value={editFields.notes} onChange={e => setEditFields(f => ({ ...f, notes: e.target.value }))}
                              className="input-glass text-[10px] py-0.5 px-1.5" placeholder="メモ" />
                            <div>
                              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>スクショ間隔</label>
                              <select
                                className="input-glass text-xs px-2 py-1.5 w-28"
                                value={editFields.screenshot_interval ?? 0}
                                onChange={e => setEditFields(prev => ({ ...prev, screenshot_interval: Number(e.target.value) }))}
                              >
                                <option value={0}>OFF</option>
                                <option value={1}>1分</option>
                                <option value={3}>3分</option>
                                <option value={5}>5分</option>
                                <option value={10}>10分</option>
                                <option value={15}>15分</option>
                                <option value={30}>30分</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>モデルID</label>
                              <input type="text" value={editFields.stripchat_model_id} onChange={e => setEditFields(f => ({ ...f, stripchat_model_id: e.target.value }))}
                                className="input-glass text-[10px] py-0.5 px-1.5 w-32" placeholder="例: 178845750" />
                            </div>
                          </div>
                        ) : (
                          <CastTagBadges genre={cast.genre} benchmark={cast.benchmark} category={cast.category} />
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">{s ? s.total_messages.toLocaleString() : '-'}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>
                        {s ? formatTokens(s.total_coins) : '-'}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">{s ? s.unique_users : '-'}</td>
                      <td className="py-2.5 px-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {cast.last_seen_online ? timeAgo(cast.last_seen_online) : '-'}
                      </td>
                      <td className="py-2.5 px-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {s?.last_activity ? timeAgo(s.last_activity) : '-'}
                      </td>
                      <td className="py-2.5 px-2 text-center">
                        {cast.screenshot_interval && cast.screenshot_interval > 0 ? (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(45,212,191,0.1)', color: '#2dd4bf', border: '1px solid rgba(45,212,191,0.2)' }}>📷 {cast.screenshot_interval}分</span>
                        ) : (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(100,116,139,0.08)', color: 'var(--text-muted)' }}>📷 OFF</span>
                        )}
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
                              <button onClick={() => { setEditingId(cast.id); setEditFields({ genre: cast.genre || '', benchmark: cast.benchmark || '', category: cast.category || '', format_tag: cast.format_tag || '', notes: cast.notes || '', screenshot_interval: cast.screenshot_interval ?? 0, stripchat_model_id: cast.stripchat_model_id || '' }); }}
                                className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }} title="タグ編集">✏️</button>
                              <button onClick={() => handleDelete(cast.id)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-rose-500/10" style={{ color: 'var(--accent-pink)' }} title="削除">🗑</button>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-1">
                        <svg className="w-4 h-4 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: '#38bdf8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
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
   Simple Analysis Tab — lightweight competitor analysis
   ============================================================ */
function SimpleAnalysisTab() {
  const { user } = useAuth();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [spyCasts, setSpyCasts] = useState<{ cast_name: string }[]>([]);
  const castFromUrl = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('analysisCast') || '' : '';
  const [selectedCast, setSelectedCastState] = useState<string>(castFromUrl);
  const [loading, setLoading] = useState(true);

  const setSelectedCast = useCallback((castName: string) => {
    setSelectedCastState(castName);
    const url = new URL(window.location.href);
    url.searchParams.set('analysisCast', castName);
    window.history.replaceState({}, '', url.toString());
  }, []);

  // Session summary
  const [sessionSummary, setSessionSummary] = useState<{
    duration_min: number; total_messages: number; total_tokens: number; peak_viewers: number;
  } | null>(null);

  // Top tippers
  const [topTippers, setTopTippers] = useState<{ user_name: string; total_tokens: number }[]>([]);

  // Message type breakdown
  const [msgBreakdown, setMsgBreakdown] = useState<{ type: string; count: number }[]>([]);

  // Tip timeline
  const [tipTimeline, setTipTimeline] = useState<{ message_time: string; user_name: string; tokens: number }[]>([]);

  // Ticket show detection
  const [ticketShows, setTicketShows] = useState<TicketShow[]>([]);
  const [ticketCVRs, setTicketCVRs] = useState<TicketShowCVR[]>([]);
  const [ticketLoading, setTicketLoading] = useState(false);

  // Load spy casts
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }
      setAccountId(data.id);

      const { data: casts } = await supabase
        .from('spy_casts')
        .select('cast_name')
        .eq('account_id', data.id)
        .eq('is_active', true)
        .order('cast_name')
        .limit(100);

      if (casts && casts.length > 0) {
        setSpyCasts(casts);
        const fromUrl = new URLSearchParams(window.location.search).get('analysisCast');
        const initial = fromUrl && casts.some((c: { cast_name: string }) => c.cast_name === fromUrl) ? fromUrl : casts[0].cast_name;
        setSelectedCast(initial);
      }
      setLoading(false);
    });
  }, [user, setSelectedCast]);

  // Session selector state
  const [sessions, setSessions] = useState<{ session_id: string; cast_name: string; started_at: string; ended_at: string | null }[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('all');

  // Load sessions when cast changes
  useEffect(() => {
    if (!accountId || !selectedCast) return;
    const supabase = createClient();
    supabase.from('sessions')
      .select('session_id, cast_name, started_at, ended_at')
      .eq('account_id', accountId)
      .eq('cast_name', selectedCast)
      .order('started_at', { ascending: false })
      .limit(500)
      .then(({ data }) => {
        setSessions(data || []);
        setSelectedSessionId('all');
      });
  }, [accountId, selectedCast]);

  // Load analysis data when cast or session changes
  useEffect(() => {
    if (!accountId || !selectedCast) return;
    const supabase = createClient();

    // Determine time range based on session selection
    let since: string;
    let until: string | null = null;
    if (selectedSessionId !== 'all' && sessions.length > 0) {
      const session = sessions.find(s => s.session_id === selectedSessionId);
      if (session) {
        since = session.started_at;
        until = session.ended_at || new Date().toISOString();
      } else {
        since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      }
    } else {
      since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }

    // Session summary
    let summaryQuery = supabase.from('spy_messages')
      .select('message_time, tokens, msg_type, metadata')
      .eq('account_id', accountId)
      .eq('cast_name', selectedCast)
      .gte('message_time', since);
    if (until) summaryQuery = summaryQuery.lte('message_time', until);
    summaryQuery
      .order('message_time', { ascending: true })
      .limit(10000)
      .then(({ data }) => {
        if (data && data.length > 0) {
          const firstMsg = new Date(data[0].message_time);
          const lastMsg = new Date(data[data.length - 1].message_time);
          const durationMin = Math.round((lastMsg.getTime() - firstMsg.getTime()) / 60000);
          const totalTokens = data.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift').reduce((s, m) => s + (m.tokens || 0), 0);
          const viewerMsgs = data.filter(m => m.msg_type === 'viewer_count');
          const peakViewers = viewerMsgs.length > 0
            ? Math.max(...viewerMsgs.map(m => {
                try {
                  // viewer_count の実数値は metadata.total に格納される（tokens は常に 0）
                  const meta = m.metadata as Record<string, unknown> | null;
                  const total = meta?.total;
                  return typeof total === 'number' ? total : 0;
                } catch { return 0; }
              }))
            : 0;
          setSessionSummary({
            duration_min: durationMin,
            total_messages: data.length,
            total_tokens: totalTokens,
            peak_viewers: peakViewers,
          });

          // Message breakdown
          const typeCounts = new Map<string, number>();
          data.forEach(m => {
            typeCounts.set(m.msg_type, (typeCounts.get(m.msg_type) || 0) + 1);
          });
          setMsgBreakdown(Array.from(typeCounts.entries()).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count));
        } else {
          setSessionSummary(null);
          setMsgBreakdown([]);
        }
      });

    // Top tippers
    let tippersQuery = supabase.from('spy_messages')
      .select('user_name, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', selectedCast)
      .in('msg_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .gte('message_time', since);
    if (until) tippersQuery = tippersQuery.lte('message_time', until);
    tippersQuery
      .order('tokens', { ascending: false })
      .limit(10000)
      .then(({ data }) => {
        if (data) {
          const tipMap = new Map<string, number>();
          data.forEach(r => {
            if (r.user_name) tipMap.set(r.user_name, (tipMap.get(r.user_name) || 0) + (r.tokens || 0));
          });
          setTopTippers(
            Array.from(tipMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([user_name, total_tokens]) => ({ user_name, total_tokens }))
          );
        } else {
          setTopTippers([]);
        }
      });

    // Tip timeline (last 20)
    let timelineQuery = supabase.from('spy_messages')
      .select('message_time, user_name, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', selectedCast)
      .in('msg_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .gte('message_time', since);
    if (until) timelineQuery = timelineQuery.lte('message_time', until);
    timelineQuery
      .order('message_time', { ascending: false })
      .limit(10000)
      .then(({ data }) => {
        if (data) setTipTimeline(data as { message_time: string; user_name: string; tokens: number }[]);
        else setTipTimeline([]);
      });
  }, [accountId, selectedCast, selectedSessionId, sessions]);

  // Ticket show detection
  useEffect(() => {
    if (!accountId || !selectedCast) return;
    setTicketLoading(true);
    const supabase = createClient();

    // Determine time range based on session selection
    let ticketSince: string;
    let ticketUntil: string | null = null;
    if (selectedSessionId !== 'all' && sessions.length > 0) {
      const session = sessions.find(s => s.session_id === selectedSessionId);
      if (session) {
        ticketSince = session.started_at;
        ticketUntil = session.ended_at || new Date().toISOString();
      } else {
        ticketSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      }
    } else {
      ticketSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }

    // Fetch ALL tip messages (not just 20) for ticket detection
    let ticketQuery = supabase.from('spy_messages')
      .select('message_time, user_name, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', selectedCast)
      .in('msg_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .gte('message_time', ticketSince);
    if (ticketUntil) ticketQuery = ticketQuery.lte('message_time', ticketUntil);
    ticketQuery
      .order('message_time', { ascending: true })
      .limit(10000)
      .then(async ({ data: tipData }) => {
        if (!tipData || tipData.length === 0) {
          setTicketShows([]);
          setTicketCVRs([]);
          setTicketLoading(false);
          return;
        }

        const detected = detectTicketShows(
          tipData.map(t => ({ tokens: t.tokens, message_time: t.message_time, user_name: t.user_name || '' }))
        );
        setTicketShows(detected);

        // For each detected show, fetch nearest viewer_stats snapshot before show start
        const cvrResults: TicketShowCVR[] = [];
        for (const show of detected) {
          const { data: vsData } = await supabase.from('viewer_stats')
            .select('total, coin_holders, ultimate_count')
            .eq('account_id', accountId)
            .eq('cast_name', selectedCast)
            .lte('recorded_at', show.started_at)
            .order('recorded_at', { ascending: false })
            .limit(1);

          const snapshot: ViewerSnapshot | null = vsData && vsData.length > 0
            ? { total: vsData[0].total || 0, coin_holders: vsData[0].coin_holders || 0, ultimate_count: vsData[0].ultimate_count || 0 }
            : null;

          cvrResults.push(calculateCVR(snapshot, show.estimated_attendees));
        }
        setTicketCVRs(cvrResults);
        setTicketLoading(false);
      });
  }, [accountId, selectedCast, selectedSessionId, sessions]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  if (spyCasts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="glass-card p-12 text-center max-w-md">
          <p className="text-3xl mb-4">📊</p>
          <h3 className="text-sm font-bold mb-2">簡易分析</h3>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            スパイキャストを登録すると、メッセージデータの簡易分析が表示されます。
          </p>
        </div>
      </div>
    );
  }

  const msgTypeLabels: Record<string, string> = {
    chat: '💬 チャット', tip: '💰 チップ', gift: '🎁 ギフト',
    enter: '👋 入室', leave: '🚪 退室', system: '⚙️ システム',
    viewer_count: '📊 視聴者', speech: '🎤 音声', goal: '🎯 ゴール',
  };

  return (
    <div className="flex-1 overflow-auto space-y-3">
      {/* Cast & session selector */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-xs font-bold" style={{ color: '#06b6d4' }}>📊 簡易分析</h3>
          <div className="flex items-center gap-2">
            <select
              value={selectedCast}
              onChange={e => setSelectedCast(e.target.value)}
              className="text-[11px] px-3 py-1.5 rounded-lg border outline-none"
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
            >
              {spyCasts.map(c => (
                <option key={c.cast_name} value={c.cast_name}>{c.cast_name}</option>
              ))}
            </select>
            <select
              value={selectedSessionId}
              onChange={e => setSelectedSessionId(e.target.value)}
              className="text-[11px] px-3 py-1.5 rounded-lg border outline-none"
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
            >
              <option value="all">直近24時間</option>
              {sessions.map(s => {
                const start = new Date(s.started_at);
                const end = s.ended_at ? new Date(s.ended_at) : null;
                const label = `${start.getMonth() + 1}/${start.getDate()} ${start.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}${end ? ` - ${end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : ' (配信中)'}`;
                return <option key={s.session_id} value={s.session_id}>{label}</option>;
              })}
            </select>
          </div>
        </div>
      </div>

      {/* Session summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="glass-card p-4 text-center">
          <p className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>配信時間</p>
          <p className="text-2xl font-bold mt-1 tabular-nums" style={{ color: '#06b6d4' }}>
            {sessionSummary ? `${sessionSummary.duration_min}分` : '-'}
          </p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>総メッセージ</p>
          <p className="text-2xl font-bold mt-1 tabular-nums" style={{ color: 'var(--text-primary)' }}>
            {sessionSummary ? sessionSummary.total_messages.toLocaleString() : '-'}
          </p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>総トークン</p>
          <p className="text-2xl font-bold mt-1 tabular-nums" style={{ color: 'var(--accent-amber)' }}>
            {sessionSummary ? (
              <>
                {formatTokens(sessionSummary.total_tokens)}
                <span className="text-[10px] block" style={{ color: 'var(--text-muted)' }}>
                  {tokensToJPY(sessionSummary.total_tokens)}
                </span>
              </>
            ) : '-'}
          </p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>ピーク視聴者</p>
          <p className="text-2xl font-bold mt-1 tabular-nums" style={{ color: 'var(--accent-purple, #a855f7)' }}>
            {sessionSummary ? sessionSummary.peak_viewers.toLocaleString() : '-'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Top 5 Tippers */}
        <div className="glass-card p-4">
          <h3 className="text-xs font-bold mb-3">💰 トップ5チッパー</h3>
          {topTippers.length === 0 ? (
            <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>チップデータがまだありません</p>
          ) : (
            <div className="space-y-2">
              {topTippers.map((t, i) => (
                <div key={t.user_name} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-bold w-4 text-center" style={{
                      color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)' }}>{i + 1}</span>
                    <Link href={`/spy/users/${encodeURIComponent(t.user_name)}`} className="truncate font-medium hover:text-cyan-400 transition-colors">{t.user_name}</Link>
                  </div>
                  <span className="flex-shrink-0 font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>{formatTokens(t.total_tokens)} <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>({tokensToJPY(t.total_tokens)})</span></span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Message type breakdown */}
        <div className="glass-card p-4">
          <h3 className="text-xs font-bold mb-3">📨 メッセージ内訳</h3>
          {msgBreakdown.length === 0 ? (
            <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>メッセージ内訳データがまだありません</p>
          ) : (
            <div className="space-y-2">
              {msgBreakdown.map(b => {
                const maxCount = msgBreakdown[0]?.count || 1;
                const pct = Math.max((b.count / maxCount) * 100, 3);
                const barColor = b.type === 'tip' || b.type === 'gift' ? '#f59e0b' : b.type === 'chat' ? '#06b6d4' : '#64748b';
                return (
                  <div key={b.type}>
                    <div className="flex items-center justify-between text-[10px] mb-0.5">
                      <span style={{ color: 'var(--text-secondary)' }}>{msgTypeLabels[b.type] || b.type}</span>
                      <span className="font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{b.count.toLocaleString()}</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${pct}%`, background: barColor }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Tip timeline */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">💸 直近チップタイムライン</h3>
        {tipTimeline.length === 0 ? (
          <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>チップイベントがまだありません</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>時刻</th>
                  <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>ユーザー</th>
                  <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>トークン</th>
                </tr>
              </thead>
              <tbody>
                {tipTimeline.map((t, i) => (
                  <tr key={`${t.message_time}-${i}`} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'rgba(6,182,212,0.05)' }}>
                    <td className="py-2 px-2 tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {new Date(t.message_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td className="py-2 px-2">
                      <Link href={`/spy/users/${encodeURIComponent(t.user_name)}`} className="font-medium hover:text-cyan-400 transition-colors">
                        {t.user_name}
                      </Link>
                    </td>
                    <td className="py-2 px-2 text-right font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                      <span>{formatTokens(t.tokens)}</span>
                      <span className="text-[9px] ml-1" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(t.tokens)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Ticket Show Analysis */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3" style={{ color: '#a78bfa' }}>🎫 チケットチャット分析</h3>
        {ticketLoading ? (
          <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>チケチャ検出中...</p>
        ) : ticketShows.length === 0 ? (
          <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>チケチャは検出されませんでした</p>
        ) : (
          <div className="space-y-3">
            {ticketShows.map((show, idx) => {
              const cvr = ticketCVRs[idx];
              const startDate = new Date(show.started_at);
              const endDate = new Date(show.ended_at);
              const dateStr = `${startDate.getMonth() + 1}/${startDate.getDate()}`;
              const startTime = startDate.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              const endTime = endDate.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              return (
                <div key={`ticket-${idx}`} className="rounded-xl p-4" style={{
                  background: 'linear-gradient(135deg, rgba(167,139,250,0.08), rgba(167,139,250,0.02))',
                  border: '1px solid rgba(167,139,250,0.15)',
                }}>
                  {/* Header: time range */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{
                        background: 'rgba(167,139,250,0.15)', color: '#a78bfa',
                      }}>
                        Show #{idx + 1}
                      </span>
                      <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                        {dateStr} {startTime} ~ {endTime}
                      </span>
                    </div>
                    <span className="text-[11px] font-bold" style={{ color: '#a78bfa' }}>
                      チケット {formatTokens(show.ticket_price)} ({tokensToJPY(show.ticket_price)})
                    </span>
                  </div>

                  {/* Stats grid */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                    <div className="rounded-lg p-2 text-center" style={{ background: 'rgba(15,23,42,0.4)' }}>
                      <p className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>参加者</p>
                      <p className="text-lg font-bold tabular-nums" style={{ color: '#a78bfa' }}>
                        {show.estimated_attendees}
                      </p>
                    </div>
                    <div className="rounded-lg p-2 text-center" style={{ background: 'rgba(15,23,42,0.4)' }}>
                      <p className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>チケット売上</p>
                      <p className="text-sm font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                        {formatTokens(show.ticket_revenue)}
                      </p>
                      <p className="text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                        {tokensToJPY(show.ticket_revenue)}
                      </p>
                    </div>
                    <div className="rounded-lg p-2 text-center" style={{ background: 'rgba(15,23,42,0.4)' }}>
                      <p className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>チップ売上</p>
                      <p className="text-sm font-bold tabular-nums" style={{ color: 'var(--accent-green, #22c55e)' }}>
                        {formatTokens(show.tip_revenue)}
                      </p>
                      <p className="text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                        {tokensToJPY(show.tip_revenue)}
                      </p>
                    </div>
                    <div className="rounded-lg p-2 text-center" style={{ background: 'rgba(15,23,42,0.4)' }}>
                      <p className="text-[9px] uppercase" style={{ color: 'var(--text-muted)' }}>合計売上</p>
                      <p className="text-sm font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                        {formatTokens(show.ticket_revenue + show.tip_revenue)}
                      </p>
                      <p className="text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                        {tokensToJPY(show.ticket_revenue + show.tip_revenue)}
                      </p>
                    </div>
                  </div>

                  {/* CVR metrics */}
                  {cvr && (
                    <div className="rounded-lg p-3" style={{ background: 'rgba(15,23,42,0.3)', border: '1px solid rgba(167,139,250,0.08)' }}>
                      <p className="text-[9px] font-bold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>CVR (コンバージョン率)</p>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
                        <div>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>総視聴者</p>
                          <p className="text-sm font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                            {cvr.total_viewers > 0 ? cvr.total_viewers.toLocaleString() : '-'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>コイン保持者</p>
                          <p className="text-sm font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                            {cvr.coin_holders > 0 ? cvr.coin_holders.toLocaleString() : '-'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>全体CVR</p>
                          <p className="text-sm font-bold tabular-nums" style={{ color: cvr.overall_cvr !== null ? '#22c55e' : 'var(--text-muted)' }}>
                            {cvr.overall_cvr !== null ? `${cvr.overall_cvr}%` : '-'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>コイン保持者CVR</p>
                          <p className="text-sm font-bold tabular-nums" style={{ color: cvr.coin_holder_cvr !== null ? '#38bdf8' : 'var(--text-muted)' }}>
                            {cvr.coin_holder_cvr !== null ? `${cvr.coin_holder_cvr}%` : '-'}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Summary if multiple shows */}
            {ticketShows.length > 1 && (
              <div className="rounded-xl p-3 text-center" style={{
                background: 'linear-gradient(135deg, rgba(167,139,250,0.12), rgba(56,189,248,0.06))',
                border: '1px solid rgba(167,139,250,0.2)',
              }}>
                <p className="text-[10px] font-bold mb-1" style={{ color: '#a78bfa' }}>
                  合計 {ticketShows.length} 回のチケチャを検出
                </p>
                <p className="text-sm font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                  総売上: {formatTokens(ticketShows.reduce((s, sh) => s + sh.ticket_revenue + sh.tip_revenue, 0))}
                  {' '}({tokensToJPY(ticketShows.reduce((s, sh) => s + sh.ticket_revenue + sh.tip_revenue, 0))})
                </p>
                <p className="text-[10px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  総参加者: {ticketShows.reduce((s, sh) => s + sh.estimated_attendees, 0)}人
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Advanced Analysis Tab — link to /spy/analysis
   ============================================================ */
function AdvancedAnalysisTab() {
  const { user } = useAuth();
  const [spyCasts, setSpyCasts] = useState<{ cast_name: string }[]>([]);
  const [selectedCast, setSelectedCast] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }

      const { data: casts } = await supabase
        .from('spy_casts')
        .select('cast_name')
        .eq('account_id', data.id)
        .eq('is_active', true)
        .order('cast_name')
        .limit(100);

      if (casts && casts.length > 0) {
        setSpyCasts(casts);
        setSelectedCast(casts[0].cast_name);
      }
      setLoading(false);
    });
  }, [user]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="glass-card p-10 text-center max-w-lg">
        <p className="text-4xl mb-4">🎯</p>
        <h3 className="text-base font-bold mb-3" style={{ color: '#06b6d4' }}>高度分析ダッシュボード</h3>
        <p className="text-[11px] mb-6" style={{ color: 'var(--text-muted)' }}>
          概要比較・セッション分析・視聴者分析・成功パターン分析を含む、フル機能の競合分析ダッシュボードを利用できます。
        </p>

        {spyCasts.length > 0 && (
          <div className="mb-4">
            <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>対象キャスト</label>
            <select
              value={selectedCast}
              onChange={e => setSelectedCast(e.target.value)}
              className="text-[11px] px-3 py-1.5 rounded-lg border outline-none w-48"
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
            >
              {spyCasts.map(c => (
                <option key={c.cast_name} value={c.cast_name}>{c.cast_name}</option>
              ))}
            </select>
          </div>
        )}

        <Link
          href={selectedCast ? `/spy/analysis?cast=${encodeURIComponent(selectedCast)}` : '/spy/analysis'}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all hover:opacity-90"
          style={{
            background: 'linear-gradient(135deg, rgba(6,182,212,0.2), rgba(6,182,212,0.08))',
            color: '#06b6d4',
            border: '1px solid rgba(6,182,212,0.3)',
            boxShadow: '0 0 20px rgba(6,182,212,0.1)',
          }}
        >
          高度分析を開く →
        </Link>
      </div>
    </div>
  );
}

/* ============================================================
   Type Catalog Tab — 型カタログ
   ============================================================ */

const REVENUE_PATTERN_LABELS: Record<string, string> = {
  public_heavy: 'パブ重視型',
  ticket_rotation: 'チケチャ回転型',
  hybrid: 'ハイブリッド',
};

const CUSTOMER_QUALITY_LABELS: Record<string, string> = {
  whale_retention: '太客定着型',
  new_rotation: '新規回転型',
  mixed: 'ハイブリッド',
};

const FREQUENCY_LABELS: Record<string, string> = {
  daily: '毎日配信',
  weekly_3_4: '週3-4回',
  weekly_1_2: '週1-2回',
  irregular: '不定期',
};

const ROUTE_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  harvest: { label: '収穫型', icon: '\u{1F33E}', color: '#f59e0b' },
  nurture: { label: '育成型', icon: '\u{1F331}', color: '#22c55e' },
};

const GENRE_OPTIONS = ['\u7D61\u307F\u914D\u4FE1', '\u5973\u6027\u5358\u4F53', '\u30AB\u30C3\u30D7\u30EB', '\u30B0\u30EB\u30FC\u30D7', '\u305D\u306E\u4ED6'];
const CATEGORY_OPTIONS = ['\u4EBA\u59BB', '\u5973\u5B50\u5927\u751F', '\u30AE\u30E3\u30EB', '\u304A\u59C9\u3055\u3093', '\u30E1\u30F3\u30D8\u30E9', '\u30ED\u30EA', '\u305D\u306E\u4ED6'];

const DEFAULT_CHECKLIST = [
  '\u914D\u4FE1\u6642\u9593\u5E2F\u304C\u30DA\u30EB\u30BD\u30CA\u3068\u6574\u5408\u3057\u3066\u3044\u308B\u304B',
  '\u30D7\u30ED\u30D5\u30A3\u30FC\u30EB\u6587\u304C\u30DA\u30EB\u30BD\u30CA\u3068\u6574\u5408\u3057\u3066\u3044\u308B\u304B',
  '\u914D\u4FE1\u30BF\u30A4\u30C8\u30EB\u306B\u30CE\u30A4\u30BA\u304C\u306A\u3044\u304B',
  '\u5916\u898B\u8A2D\u5B9A\u3068\u30E9\u30A4\u30D5\u30B9\u30BF\u30A4\u30EB\u304C\u77DB\u76FE\u3057\u3066\u3044\u306A\u3044\u304B',
  '\u767A\u8A00\u5185\u5BB9\u304C\u30AD\u30E3\u30E9\u30AF\u30BF\u30FC\u304B\u3089\u9038\u8131\u3057\u3066\u3044\u306A\u3044\u304B',
];

/* ============================================================
   Market Analysis Tab — 他社マーケット分析
   ============================================================ */
function MarketAnalysisTab() {
  const { user } = useAuth();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
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

  const sb = useMemo(() => createClient(), []);

  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  useEffect(() => {
    if (!accountId) return;
    const load = async () => {
      setLoading(true);
      const [marketRes, trendsRes, revRes] = await Promise.all([
        sb.rpc('get_spy_market_now', { p_account_id: accountId, p_days: days }),
        sb.rpc('get_spy_viewer_trends', { p_account_id: accountId, p_days: days }),
        sb.rpc('get_spy_revenue_types', { p_account_id: accountId, p_days: days }),
      ]);
      if (marketRes.data && marketRes.data.length > 0) setMarketNow(marketRes.data[0]);
      if (trendsRes.data) setViewerTrends(trendsRes.data);
      if (revRes.data) setRevenueTypes(revRes.data);
      setLoading(false);
    };
    load();
  }, [accountId, days, sb]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>マーケットデータ読み込み中...</p>
        </div>
      </div>
    );
  }

  if (viewerTrends.length === 0 && revenueTypes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="glass-card p-8 text-center max-w-md">
          <p className="text-2xl mb-3">📊</p>
          <p className="text-sm font-bold mb-2">マーケットデータなし</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            他社キャストのSPYデータが蓄積されると、マーケット分析が表示されます
          </p>
        </div>
      </div>
    );
  }

  const castNames = Array.from(new Set(viewerTrends.map(v => v.cast_name)));
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const maxV = Math.max(...viewerTrends.map(v => v.avg_viewers), 1);
  const currentHour = marketNow?.current_hour ?? new Date().getHours();

  // Viewer ranking: sum avg_viewers across all hours
  const castViewerRank = castNames.map(cn => {
    const rows = viewerTrends.filter(v => v.cast_name === cn);
    const avgAll = rows.length > 0 ? rows.reduce((s, r) => s + r.avg_viewers, 0) / rows.length : 0;
    const peakV = rows.length > 0 ? Math.max(...rows.map(r => r.max_viewers)) : 0;
    const bc = rows.length > 0 ? Math.max(...rows.map(r => r.broadcast_count)) : 0;
    return { cast_name: cn, avg_viewers: Math.round(avgAll), peak_viewers: peakV, broadcast_count: bc };
  }).sort((a, b) => b.avg_viewers - a.avg_viewers);

  return (
    <div className="flex-1 overflow-y-auto space-y-4 p-1">
      {/* Period Selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold" style={{ color: 'rgb(6,182,212)' }}>📊 マーケット分析</h2>
        <div className="flex items-center gap-1.5">
          {[7, 14, 30].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
              style={{
                background: days === d ? 'rgba(6,182,212,0.12)' : 'transparent',
                color: days === d ? '#06b6d4' : 'var(--text-muted)',
                border: days === d ? '1px solid rgba(6,182,212,0.3)' : '1px solid transparent',
              }}
            >{d}日</button>
          ))}
        </div>
      </div>

      {/* Market Now Summary */}
      {marketNow && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>現在のマーケット概況</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>時間帯</p>
              <p className="text-base font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.current_hour}時台</p>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>アクティブ他社</p>
              <p className="text-base font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.active_casts}配信</p>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>他社平均視聴者</p>
              <p className="text-base font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.avg_viewers_now ?? '-'}人</p>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>トップキャスト</p>
              <p className="text-xs font-bold truncate" style={{ color: 'var(--accent-purple)' }}>{marketNow.best_cast ?? '-'}</p>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>最大{marketNow.best_viewers ?? 0}人</p>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>自社平均視聴者</p>
              <p className="text-base font-bold" style={{
                color: marketNow.own_avg_viewers != null && marketNow.avg_viewers_now > 0 && marketNow.own_avg_viewers >= marketNow.avg_viewers_now
                  ? 'var(--accent-green)' : 'var(--accent-amber)',
              }}>{marketNow.own_avg_viewers ?? '-'}人</p>
            </div>
          </div>
        </div>
      )}

      {/* Viewer Heatmap */}
      {viewerTrends.length > 0 && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>時間帯別視聴者数ヒートマップ</p>
          <div className="overflow-x-auto">
            <table className="text-[9px] w-full" style={{ minWidth: '700px' }}>
              <thead>
                <tr>
                  <th className="text-left px-1 py-1 sticky left-0" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', minWidth: '90px', zIndex: 1 }}>キャスト</th>
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
                    <td className="px-1 py-0.5 truncate sticky left-0" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', maxWidth: '90px', zIndex: 1 }}>
                      <Link href={`/spy/${encodeURIComponent(cn)}`} className="hover:underline">{cn}</Link>
                    </td>
                    {hours.map(h => {
                      const cell = viewerTrends.find(v => v.cast_name === cn && v.hour_of_day === h);
                      const val = cell ? cell.avg_viewers : 0;
                      const intensity = val / maxV;
                      return (
                        <td key={h} className="px-0.5 py-0.5 text-center" title={val > 0 ? `${cn} ${h}時台: 平均${Math.round(val)}人 / 最大${cell?.max_viewers ?? 0}人` : ''} style={{
                          background: val > 0
                            ? `rgba(6,182,212,${Math.max(0.08, intensity * 0.6)})`
                            : 'transparent',
                          color: val > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                          borderLeft: h === currentHour ? '2px solid rgba(6,182,212,0.5)' : undefined,
                          borderRight: h === currentHour ? '2px solid rgba(6,182,212,0.5)' : undefined,
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
          <p className="text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>値 = 平均視聴者数 / 太線 = 現在時刻</p>
        </div>
      )}

      {/* Viewer Ranking */}
      {castViewerRank.length > 0 && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>視聴者数ランキング</p>
          <div className="space-y-1.5">
            {castViewerRank.map((c, i) => {
              const barW = castViewerRank[0].avg_viewers > 0 ? (c.avg_viewers / castViewerRank[0].avg_viewers) * 100 : 0;
              return (
                <div key={c.cast_name} className="flex items-center gap-2">
                  <span className="text-[10px] font-bold w-5 text-right" style={{ color: i < 3 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                    {i + 1}
                  </span>
                  <Link href={`/spy/${encodeURIComponent(c.cast_name)}`} className="text-[10px] truncate hover:underline" style={{ color: 'var(--text-secondary)', width: '90px', minWidth: '90px' }}>
                    {c.cast_name}
                  </Link>
                  <div className="flex-1 h-4 rounded" style={{ background: 'rgba(6,182,212,0.06)' }}>
                    <div className="h-full rounded flex items-center px-1.5" style={{ width: `${barW}%`, background: 'rgba(6,182,212,0.2)', minWidth: '20px' }}>
                      <span className="text-[9px] font-bold" style={{ color: 'rgb(6,182,212)' }}>{c.avg_viewers}</span>
                    </div>
                  </div>
                  <span className="text-[9px] w-14 text-right" style={{ color: 'var(--text-muted)' }}>最大{c.peak_viewers}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Revenue Type Distribution */}
      {revenueTypes.length > 0 && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>応援タイプ分布</p>
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
                {revenueTypes.sort((a, b) => b.total_tokens - a.total_tokens).map(r => {
                  const total = r.tip_count + r.ticket_count + r.group_count;
                  const tipPct = total > 0 ? (r.tip_count / total * 100).toFixed(0) : '0';
                  const ticketPct = total > 0 ? (r.ticket_count / total * 100).toFixed(0) : '0';
                  const groupPct = total > 0 ? (r.group_count / total * 100).toFixed(0) : '0';
                  return (
                    <tr key={r.cast_name} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                      <td className="px-2 py-1.5 truncate" style={{ color: 'var(--text-secondary)', maxWidth: '100px' }}>
                        <Link href={`/spy/${encodeURIComponent(r.cast_name)}`} className="hover:underline">{r.cast_name}</Link>
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: r.tip_count > 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                        {r.tip_count} <span className="text-[8px]">({tipPct}%)</span>
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: r.ticket_count > 0 ? 'var(--accent-purple)' : 'var(--text-muted)' }}>
                        {r.ticket_count} <span className="text-[8px]">({ticketPct}%)</span>
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: r.group_count > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                        {r.group_count} <span className="text-[8px]">({groupPct}%)</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-bold" style={{ color: 'var(--accent-primary)' }}>{r.total_tokens.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{r.broadcast_days}日</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Stacked bar per cast */}
          <div className="mt-4 space-y-1.5">
            {revenueTypes.sort((a, b) => b.total_tokens - a.total_tokens).map(r => {
              const total = r.tip_count + r.ticket_count + r.group_count;
              if (total === 0) return null;
              const tipW = (r.tip_count / total) * 100;
              const ticketW = (r.ticket_count / total) * 100;
              const groupW = (r.group_count / total) * 100;
              return (
                <div key={r.cast_name} className="flex items-center gap-2">
                  <span className="text-[9px] truncate" style={{ color: 'var(--text-muted)', width: '80px', minWidth: '80px' }}>{r.cast_name}</span>
                  <div className="flex-1 h-3 rounded-full overflow-hidden flex" style={{ background: 'rgba(255,255,255,0.03)' }}>
                    {tipW > 0 && <div style={{ width: `${tipW}%`, background: 'var(--accent-amber)' }} />}
                    {ticketW > 0 && <div style={{ width: `${ticketW}%`, background: 'var(--accent-purple)' }} />}
                    {groupW > 0 && <div style={{ width: `${groupW}%`, background: 'var(--accent-green)' }} />}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center gap-4 mt-2 text-[9px]" style={{ color: 'var(--text-muted)' }}>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--accent-amber)' }} /> チップ</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--accent-purple)' }} /> チケット</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--accent-green)' }} /> グループ</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Type Catalog Tab — 型カタログ
   ============================================================ */
function TypeCatalogTab() {
  const { user } = useAuth();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [types, setTypes] = useState<CastType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingType, setEditingType] = useState<CastType | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [castCounts, setCastCounts] = useState<Record<string, { count: number; names: string[] }>>({});

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }
      setAccountId(data.id);

      const { data: typesData } = await supabase
        .from('cast_types')
        .select('*')
        .eq('account_id', data.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(50);

      if (typesData) setTypes(typesData as CastType[]);

      const { data: spyCasts } = await supabase
        .from('spy_casts')
        .select('cast_name, cast_type_id')
        .eq('account_id', data.id)
        .filter('cast_type_id', 'not.is', null)
        .limit(100);

      const { data: regCasts } = await supabase
        .from('registered_casts')
        .select('cast_name, cast_type_id')
        .eq('account_id', data.id)
        .filter('cast_type_id', 'not.is', null)
        .limit(100);

      const counts: Record<string, { count: number; names: string[] }> = {};
      [...(spyCasts || []), ...(regCasts || [])].forEach((c: { cast_name: string; cast_type_id: string | null }) => {
        if (c.cast_type_id) {
          if (!counts[c.cast_type_id]) counts[c.cast_type_id] = { count: 0, names: [] };
          if (!counts[c.cast_type_id].names.includes(c.cast_name)) {
            counts[c.cast_type_id].count++;
            counts[c.cast_type_id].names.push(c.cast_name);
          }
        }
      });
      setCastCounts(counts);
      setLoading(false);
    });
  }, [user]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  if (isCreating || editingType) {
    return <TypeForm
      accountId={accountId!}
      existingType={editingType}
      onSave={(saved) => {
        if (editingType) {
          setTypes(prev => prev.map(t => t.id === saved.id ? saved : t));
        } else {
          setTypes(prev => [saved, ...prev]);
        }
        setEditingType(null);
        setIsCreating(false);
      }}
      onCancel={() => { setEditingType(null); setIsCreating(false); }}
    />;
  }

  return (
    <div className="space-y-4 overflow-y-auto flex-1 p-1">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold flex items-center gap-2">
          <span>型カタログ ({types.length})</span>
        </h2>
        <button onClick={() => setIsCreating(true)} className="btn-primary text-[11px] py-1.5 px-4">
          + 新しい型を作成
        </button>
      </div>

      {types.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <p className="text-3xl mb-4">📦</p>
          <h3 className="text-sm font-bold mb-2">型が登録されていません</h3>
          <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
            ベンチマークキャストの分析データから「型」を定義しましょう。
          </p>
          <button onClick={() => setIsCreating(true)} className="btn-primary text-[11px] py-2 px-6">
            最初の型を作成
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {types.map(type => (
            <TypeCard key={type.id} type={type} castInfo={castCounts[type.id]} onEdit={() => setEditingType(type)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TypeCard — 型カード表示
   ============================================================ */
function TypeCard({ type, castInfo, onEdit }: { type: CastType; castInfo?: { count: number; names: string[] }; onEdit: () => void }) {
  const route = type.product_route ? ROUTE_LABELS[type.product_route] : null;

  return (
    <div className="glass-card p-5 hover:border-sky-500/20 transition-all">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold flex items-center gap-2">
          📦 {type.type_name}
        </h3>
        <button onClick={onEdit} className="btn-ghost text-[10px] py-1 px-3">編集</button>
      </div>

      {/* Benchmark */}
      <p className="text-[11px] mb-3" style={{ color: 'var(--text-secondary)' }}>
        ベンチマーク: <span className="font-semibold text-sky-400">{type.benchmark_cast}</span>
      </p>

      {/* Category tags */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {type.category && <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(168,85,247,0.12)', color: '#a855f7' }}>{type.category}</span>}
        {type.genre && <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(56,189,248,0.12)', color: '#38bdf8' }}>{type.genre}</span>}
      </div>

      {/* Revenue */}
      <div className="space-y-1.5 text-[11px] mb-3">
        {type.avg_session_revenue_min != null && type.avg_session_revenue_max != null && (
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}>売上レンジ:</span>
            <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
              {type.avg_session_revenue_min.toLocaleString()}-{type.avg_session_revenue_max.toLocaleString()} tk/回
            </span>
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
              ({tokensToJPY(type.avg_session_revenue_min)}-{tokensToJPY(type.avg_session_revenue_max)})
            </span>
          </div>
        )}

        {type.revenue_pattern && (
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}>収益:</span>
            <span>{REVENUE_PATTERN_LABELS[type.revenue_pattern] || type.revenue_pattern}</span>
            {type.ticket_ratio != null && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>({type.ticket_ratio}%)</span>}
          </div>
        )}

        {type.customer_quality && (
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}>顧客:</span>
            <span>{CUSTOMER_QUALITY_LABELS[type.customer_quality] || type.customer_quality}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--text-muted)' }}>配信:</span>
          <span>
            {type.streaming_frequency ? FREQUENCY_LABELS[type.streaming_frequency] : '-'}
            {type.expected_lifespan_months && ` / 推定${type.expected_lifespan_months}ヶ月活動`}
          </span>
        </div>
      </div>

      {/* Route */}
      {route && (
        <div className="mb-3">
          <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: `${route.color}15`, color: route.color }}>
            {route.icon} {route.label}
          </span>
        </div>
      )}

      {/* Linked casts */}
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        紐付けキャスト: {castInfo?.count || 0}名
        {castInfo?.names && castInfo.names.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {castInfo.names.map(name => (
              <Link key={name} href={`/spy/${encodeURIComponent(name)}`}
                className="px-1.5 py-0.5 rounded text-[9px] hover:text-sky-400 transition-colors"
                style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--text-secondary)' }}>
                {name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   TypeForm — 型 作成/編集フォーム
   ============================================================ */
function TypeForm({ accountId, existingType, onSave, onCancel }: {
  accountId: string;
  existingType: CastType | null;
  onSave: (saved: CastType) => void;
  onCancel: () => void;
}) {
  const [typeName, setTypeName] = useState(existingType?.type_name || '');
  const [benchmarkCast, setBenchmarkCast] = useState(existingType?.benchmark_cast || '');
  const [description, setDescription] = useState(existingType?.description || '');
  const [genre, setGenre] = useState(existingType?.genre || '');
  const [category, setCategory] = useState(existingType?.category || '');
  const [streamingStyle, setStreamingStyle] = useState(existingType?.streaming_style || '');
  const [revenuePattern, setRevenuePattern] = useState(existingType?.revenue_pattern || '');
  const [revenueMin, setRevenueMin] = useState<number | ''>(existingType?.avg_session_revenue_min ?? '');
  const [revenueMax, setRevenueMax] = useState<number | ''>(existingType?.avg_session_revenue_max ?? '');
  const [ticketRatio, setTicketRatio] = useState<number | ''>(existingType?.ticket_ratio ?? '');
  const [avgTicketPrice, setAvgTicketPrice] = useState<number | ''>(existingType?.avg_ticket_price ?? '');
  const [avgTicketAttendees, setAvgTicketAttendees] = useState<number | ''>(existingType?.avg_ticket_attendees ?? '');
  const [customerQuality, setCustomerQuality] = useState(existingType?.customer_quality || '');
  const [streamingFrequency, setStreamingFrequency] = useState(existingType?.streaming_frequency || '');
  const [expectedLifespan, setExpectedLifespan] = useState<number | ''>(existingType?.expected_lifespan_months ?? '');
  const [survivalRate, setSurvivalRate] = useState<number | ''>(existingType?.survival_rate_30d ?? '');
  const [productRoute, setProductRoute] = useState(existingType?.product_route || '');
  const [checklist, setChecklist] = useState<{ item: string; checked: boolean }[]>(
    existingType?.consistency_checklist && existingType.consistency_checklist.length > 0
      ? existingType.consistency_checklist
      : DEFAULT_CHECKLIST.map(item => ({ item, checked: false }))
  );
  const [hypothesis, setHypothesis] = useState(existingType?.hypothesis_1year || '');
  const [saving, setSaving] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const [newCheckItem, setNewCheckItem] = useState('');

  const [availableCasts, setAvailableCasts] = useState<string[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase.from('spy_casts')
      .select('cast_name')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .order('cast_name')
      .limit(100)
      .then(({ data }) => {
        if (data) setAvailableCasts(data.map((c: { cast_name: string }) => c.cast_name));
      });
  }, [accountId]);

  async function autoFillFromBenchmark() {
    if (!benchmarkCast) return;
    setAutoFilling(true);
    const supabase = createClient();

    try {
      const { data: sessions } = await supabase
        .from('sessions')
        .select('session_id, started_at, ended_at, ticket_shows, total_ticket_revenue, total_tip_revenue, total_ticket_attendees')
        .eq('account_id', accountId)
        .eq('cast_name', benchmarkCast)
        .filter('ended_at', 'not.is', null)
        .order('started_at', { ascending: false })
        .limit(500);

      const { data: tips } = await supabase
        .from('spy_messages')
        .select('message_time, tokens')
        .eq('account_id', accountId)
        .eq('cast_name', benchmarkCast)
        .in('msg_type', ['tip', 'gift'])
        .gt('tokens', 0)
        .order('message_time', { ascending: false })
        .limit(10000);

      if (sessions && sessions.length > 0 && tips) {
        const sessionRevenues: number[] = [];
        for (const s of sessions) {
          const sessionTips = tips.filter(t =>
            t.message_time >= s.started_at && t.message_time <= (s.ended_at || '')
          );
          const revenue = sessionTips.reduce((sum, t) => sum + (t.tokens || 0), 0);
          sessionRevenues.push(revenue);
        }

        if (sessionRevenues.length > 0) {
          const sorted = [...sessionRevenues].sort((a, b) => a - b);
          const p25 = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
          const p75 = sorted[Math.floor(sorted.length * 0.75)] || sorted[sorted.length - 1];
          setRevenueMin(Math.round(p25));
          setRevenueMax(Math.round(p75));
        }

        let totalTicketRev = 0;
        const totalAllRev = tips.reduce((s, t) => s + (t.tokens || 0), 0);
        let totalAttendees = 0;
        const ticketPrices: number[] = [];

        for (const s of sessions) {
          if (s.total_ticket_revenue) totalTicketRev += s.total_ticket_revenue;
          if (s.total_ticket_attendees) totalAttendees += s.total_ticket_attendees;
          if (s.ticket_shows) {
            const shows = typeof s.ticket_shows === 'string' ? JSON.parse(s.ticket_shows) : s.ticket_shows;
            if (Array.isArray(shows)) {
              shows.forEach((sh: { ticket_price?: number }) => { if (sh.ticket_price) ticketPrices.push(sh.ticket_price); });
            }
          }
        }

        if (totalAllRev > 0) setTicketRatio(Math.round(totalTicketRev / totalAllRev * 100));
        if (ticketPrices.length > 0) setAvgTicketPrice(Math.round(ticketPrices.reduce((a, b) => a + b, 0) / ticketPrices.length));
        const sessionsWithTickets = sessions.filter(s => s.total_ticket_attendees && s.total_ticket_attendees > 0);
        if (sessionsWithTickets.length > 0) {
          setAvgTicketAttendees(Math.round(totalAttendees / sessionsWithTickets.length));
        }

        const ratio = totalAllRev > 0 ? totalTicketRev / totalAllRev * 100 : 0;
        if (ratio >= 60) setRevenuePattern('ticket_rotation');
        else if (ratio <= 20) setRevenuePattern('public_heavy');
        else setRevenuePattern('hybrid');
      }

      const { data: castInfo } = await supabase
        .from('spy_casts')
        .select('genre, category, benchmark')
        .eq('account_id', accountId)
        .eq('cast_name', benchmarkCast)
        .limit(1)
        .maybeSingle();

      if (castInfo) {
        if (castInfo.genre && !genre) setGenre(castInfo.genre);
        if (castInfo.category && !category) setCategory(castInfo.category);
      }
    } catch (e) {
      console.error('Auto-fill failed:', e);
    }

    setAutoFilling(false);
  }

  async function handleSave() {
    if (!typeName || !benchmarkCast) return;
    setSaving(true);
    const supabase = createClient();

    const payload = {
      account_id: accountId,
      type_name: typeName,
      benchmark_cast: benchmarkCast,
      description: description || null,
      genre: genre || null,
      category: category || null,
      streaming_style: streamingStyle || null,
      revenue_pattern: revenuePattern || null,
      avg_session_revenue_min: revenueMin !== '' ? Number(revenueMin) : null,
      avg_session_revenue_max: revenueMax !== '' ? Number(revenueMax) : null,
      ticket_ratio: ticketRatio !== '' ? Number(ticketRatio) : null,
      avg_ticket_price: avgTicketPrice !== '' ? Number(avgTicketPrice) : null,
      avg_ticket_attendees: avgTicketAttendees !== '' ? Number(avgTicketAttendees) : null,
      customer_quality: customerQuality || null,
      streaming_frequency: streamingFrequency || null,
      expected_lifespan_months: expectedLifespan !== '' ? Number(expectedLifespan) : null,
      survival_rate_30d: survivalRate !== '' ? Number(survivalRate) : null,
      product_route: productRoute || null,
      consistency_checklist: checklist,
      hypothesis_1year: hypothesis || null,
      updated_at: new Date().toISOString(),
    };

    if (existingType) {
      const { data } = await supabase
        .from('cast_types')
        .update(payload)
        .eq('id', existingType.id)
        .select()
        .single();
      if (data) onSave(data as CastType);
    } else {
      const { data } = await supabase
        .from('cast_types')
        .insert(payload)
        .select()
        .single();
      if (data) onSave(data as CastType);
    }
    setSaving(false);
  }

  const inputCls = "input-glass w-full text-[12px] px-3 py-2";
  const labelCls = "block text-[11px] font-semibold mb-1";
  const sectionCls = "glass-card p-4 space-y-3";

  return (
    <div className="overflow-y-auto flex-1 space-y-4 p-1">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">
          {existingType ? `型を編集: ${existingType.type_name}` : '新しい型を作成'}
        </h2>
        <button onClick={onCancel} className="btn-ghost text-[11px] py-1.5 px-4">キャンセル</button>
      </div>

      {/* Basic Info */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>基本情報</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>型名 <span className="text-rose-400">*</span></label>
            <input className={inputCls} value={typeName} onChange={e => setTypeName(e.target.value)} placeholder="例: お姉さん系チケチャ型" />
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>ベンチマークキャスト <span className="text-rose-400">*</span></label>
            <div className="flex gap-2">
              {availableCasts.length > 0 ? (
                <select className={inputCls} value={benchmarkCast} onChange={e => setBenchmarkCast(e.target.value)}
                  style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
                  <option value="">選択してください</option>
                  {availableCasts.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input className={inputCls} value={benchmarkCast} onChange={e => setBenchmarkCast(e.target.value)} placeholder="キャスト名" />
              )}
              <button
                onClick={autoFillFromBenchmark}
                disabled={!benchmarkCast || autoFilling}
                className="btn-ghost text-[10px] py-1 px-3 whitespace-nowrap disabled:opacity-40"
              >
                {autoFilling ? '取得中...' : '自動入力'}
              </button>
            </div>
          </div>
        </div>
        <div>
          <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>説明</label>
          <textarea className={inputCls + " resize-none"} rows={2} value={description} onChange={e => setDescription(e.target.value)}
            placeholder="この型の特徴や狙いを簡潔に" />
        </div>
      </div>

      {/* Section 1: Category Attributes */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1.5"
            style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>1</span>
          カテゴリー属性
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>ジャンル</label>
            <select className={inputCls} value={genre} onChange={e => setGenre(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              {GENRE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>カテゴリー</label>
            <select className={inputCls} value={category} onChange={e => setCategory(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>配信スタイル</label>
            <input className={inputCls} value={streamingStyle} onChange={e => setStreamingStyle(e.target.value)}
              placeholder="例: トーク+ゲーム" />
          </div>
        </div>
      </div>

      {/* Section 2: Revenue Pattern */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1.5"
            style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>2</span>
          収益パターン
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>収益パターン</label>
            <select className={inputCls} value={revenuePattern} onChange={e => setRevenuePattern(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              <option value="public_heavy">パブ重視型</option>
              <option value="ticket_rotation">チケチャ回転型</option>
              <option value="hybrid">ハイブリッド</option>
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>売上レンジ (tk/回)</label>
            <div className="flex items-center gap-1">
              <input className={inputCls} type="number" value={revenueMin} onChange={e => setRevenueMin(e.target.value ? Number(e.target.value) : '')} placeholder="min" />
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>-</span>
              <input className={inputCls} type="number" value={revenueMax} onChange={e => setRevenueMax(e.target.value ? Number(e.target.value) : '')} placeholder="max" />
            </div>
            {revenueMin !== '' && revenueMax !== '' && (
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {tokensToJPY(Number(revenueMin))} - {tokensToJPY(Number(revenueMax))}
              </p>
            )}
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>チケット比率 (%)</label>
            <input className={inputCls} type="number" min={0} max={100} value={ticketRatio} onChange={e => setTicketRatio(e.target.value ? Number(e.target.value) : '')} placeholder="0-100" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>平均チケット価格 (tk)</label>
            <input className={inputCls} type="number" value={avgTicketPrice} onChange={e => setAvgTicketPrice(e.target.value ? Number(e.target.value) : '')} placeholder="例: 50" />
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>平均チケット参加者数</label>
            <input className={inputCls} type="number" value={avgTicketAttendees} onChange={e => setAvgTicketAttendees(e.target.value ? Number(e.target.value) : '')} placeholder="例: 8" />
          </div>
        </div>
      </div>

      {/* Section 3: Customer Quality */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1.5"
            style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>3</span>
          顧客の質
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>顧客タイプ</label>
            <select className={inputCls} value={customerQuality} onChange={e => setCustomerQuality(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              <option value="whale_retention">太客定着型</option>
              <option value="new_rotation">新規回転型</option>
              <option value="mixed">ハイブリッド</option>
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>配信頻度</label>
            <select className={inputCls} value={streamingFrequency} onChange={e => setStreamingFrequency(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              <option value="daily">毎日配信</option>
              <option value="weekly_3_4">週3-4回</option>
              <option value="weekly_1_2">週1-2回</option>
              <option value="irregular">不定期</option>
            </select>
          </div>
        </div>
      </div>

      {/* Section 4: Survival Pattern */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1.5"
            style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>4</span>
          生存パターン
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>推定活動期間 (ヶ月)</label>
            <input className={inputCls} type="number" value={expectedLifespan} onChange={e => setExpectedLifespan(e.target.value ? Number(e.target.value) : '')} placeholder="例: 6" />
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>30日生存率 (%)</label>
            <input className={inputCls} type="number" min={0} max={100} value={survivalRate} onChange={e => setSurvivalRate(e.target.value ? Number(e.target.value) : '')} placeholder="0-100" />
          </div>
        </div>
      </div>

      {/* Product Route */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold mb-2" style={{ color: 'var(--accent-primary)' }}>プロダクトルート</h3>
        <div className="flex gap-3">
          {(['harvest', 'nurture'] as const).map(r => {
            const info = ROUTE_LABELS[r];
            const isSelected = productRoute === r;
            return (
              <button
                key={r}
                onClick={() => setProductRoute(isSelected ? '' : r)}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all"
                style={{
                  background: isSelected ? `${info.color}15` : 'rgba(15,23,42,0.4)',
                  color: isSelected ? info.color : 'var(--text-muted)',
                  border: `1px solid ${isSelected ? info.color + '40' : 'var(--border-glass)'}`,
                }}
              >
                <span className="text-lg">{info.icon}</span>
                {info.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Consistency Checklist */}
      <div className={sectionCls}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>一貫性チェックリスト</h3>
          <button
            onClick={() => setChecklist(DEFAULT_CHECKLIST.map(item => ({ item, checked: false })))}
            className="btn-ghost text-[9px] py-0.5 px-2"
          >
            デフォルトに戻す
          </button>
        </div>
        <div className="space-y-1.5">
          {checklist.map((c, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <input
                type="checkbox"
                checked={c.checked}
                onChange={() => {
                  const next = [...checklist];
                  next[i] = { ...next[i], checked: !next[i].checked };
                  setChecklist(next);
                }}
                className="rounded border-gray-600 bg-gray-800 text-sky-500 focus:ring-sky-500 focus:ring-offset-0"
              />
              <span className="text-[11px] flex-1" style={{ color: c.checked ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{c.item}</span>
              <button
                onClick={() => setChecklist(prev => prev.filter((_, idx) => idx !== i))}
                className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ color: 'var(--accent-pink)' }}
              >
                削除
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          <input
            className={inputCls}
            value={newCheckItem}
            onChange={e => setNewCheckItem(e.target.value)}
            placeholder="チェック項目を追加..."
            onKeyDown={e => {
              if (e.key === 'Enter' && newCheckItem.trim()) {
                setChecklist(prev => [...prev, { item: newCheckItem.trim(), checked: false }]);
                setNewCheckItem('');
              }
            }}
          />
          <button
            onClick={() => {
              if (newCheckItem.trim()) {
                setChecklist(prev => [...prev, { item: newCheckItem.trim(), checked: false }]);
                setNewCheckItem('');
              }
            }}
            className="btn-ghost text-[10px] py-1 px-3 whitespace-nowrap"
          >
            追加
          </button>
        </div>
      </div>

      {/* 1-Year Hypothesis */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>1年仮説</h3>
        <textarea
          className={inputCls + " resize-none"}
          rows={3}
          value={hypothesis}
          onChange={e => setHypothesis(e.target.value)}
          placeholder="この型のキャストが1年後にどうなっているか。目標売上、成長シナリオなど。"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pb-4">
        <button onClick={onCancel} className="btn-ghost text-[11px] py-2 px-5">キャンセル</button>
        <button
          onClick={handleSave}
          disabled={!typeName || !benchmarkCast || saving}
          className="btn-primary text-[11px] py-2 px-6 disabled:opacity-40"
        >
          {saving ? '保存中...' : existingType ? '更新する' : '作成する'}
        </button>
      </div>
    </div>
  );
}
