'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, timeAgo, tokensToJPY } from '@/lib/utils';
import { detectTicketShows } from '@/lib/ticket-show-detector';
import { calculateCVR } from '@/lib/cvr-calculator';
import type { TicketShow } from '@/lib/ticket-show-detector';
import type { TicketShowCVR, ViewerSnapshot } from '@/lib/cvr-calculator';
import Link from 'next/link';
import type { SpyCast, SpyMessage } from '@/types';

type SpyDetailTab = 'overview' | 'sessions' | 'users' | 'ticket' | 'profile' | 'screenshots' | 'format';

const TAB_CONFIG: { key: SpyDetailTab; label: string; icon: string }[] = [
  { key: 'overview',     label: '概要',         icon: '📊' },
  { key: 'sessions',     label: '配信ログ',     icon: '📺' },
  { key: 'users',        label: 'ユーザー分析', icon: '👥' },
  { key: 'ticket',       label: 'チケチャ',     icon: '🎫' },
  { key: 'profile',      label: 'プロフィール', icon: '👤' },
  { key: 'screenshots',  label: 'スクショ',     icon: '📸' },
  { key: 'format',       label: 'フォーマット', icon: '📋' },
];

export default function SpyCastDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const castName = decodeURIComponent(params.castName as string);
  const tabParam = searchParams.get('tab') as SpyDetailTab | null;
  const [activeTab, setActiveTab] = useState<SpyDetailTab>(tabParam || 'overview');
  const { user } = useAuth();

  const [castInfo, setCastInfo] = useState<SpyCast | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }
      setAccountId(data.id);

      const { data: cast } = await supabase
        .from('spy_casts')
        .select('*')
        .eq('account_id', data.id)
        .eq('cast_name', castName)
        .limit(1)
        .maybeSingle();

      if (cast) setCastInfo(cast as SpyCast);
      setLoading(false);
    });
  }, [user, castName]);

  // Update tab from URL changes
  useEffect(() => {
    if (tabParam && TAB_CONFIG.some(t => t.key === tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  if (!user) return null;

  if (loading) {
    return (
      <div className="h-[calc(100vh-48px)] flex items-center justify-center">
        <div className="glass-card p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-3 overflow-hidden">
      {/* Header */}
      <div className="glass-card px-5 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/spy" className="text-xs hover:text-sky-400 transition-colors" style={{ color: 'var(--text-muted)' }}>← SPY</Link>
            <div>
              <h1 className="text-base font-bold flex items-center gap-2">
                🔍 {castName}
                <span className="text-[10px] px-2 py-0.5 rounded" style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>SPY</span>
              </h1>
              {castInfo?.display_name && (
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{castInfo.display_name}</p>
              )}
            </div>
          </div>
          {castInfo?.stripchat_url && (
            <a href={castInfo.stripchat_url} target="_blank" rel="noopener noreferrer"
              className="btn-ghost text-[10px] py-1 px-3">Stripchat →</a>
          )}
        </div>

        {/* Tab navigation */}
        <div className="flex items-center gap-1 mt-3">
          {TAB_CONFIG.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className="px-4 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
              style={{
                background: activeTab === t.key ? 'rgba(56,189,248,0.12)' : 'transparent',
                color: activeTab === t.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                border: activeTab === t.key ? '1px solid rgba(56,189,248,0.2)' : '1px solid transparent',
              }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'overview' && accountId && <OverviewTab castName={castName} accountId={accountId} castInfo={castInfo} />}
        {activeTab === 'sessions' && accountId && <SessionsTab castName={castName} accountId={accountId} />}
        {activeTab === 'users' && accountId && <UsersTab castName={castName} accountId={accountId} />}
        {activeTab === 'ticket' && accountId && <TicketTab castName={castName} accountId={accountId} />}
        {activeTab === 'profile' && accountId && <ProfileTab castName={castName} accountId={accountId} />}
        {activeTab === 'screenshots' && accountId && <ScreenshotsTab castName={castName} accountId={accountId} />}
        {activeTab === 'format' && <FormatTab castInfo={castInfo} />}
      </div>
    </div>
  );
}

/* ============================================================
   Overview Tab
   ============================================================ */
function OverviewTab({ castName, accountId, castInfo }: { castName: string; accountId: string; castInfo: SpyCast | null }) {
  const [stats, setStats] = useState<{ total_messages: number; total_tips: number; total_coins: number; unique_users: number; last_activity: string | null } | null>(null);
  const [topTippers, setTopTippers] = useState<{ user_name: string; total_tokens: number }[]>([]);
  const [recentMessages, setRecentMessages] = useState<SpyMessage[]>([]);
  const [castType, setCastType] = useState<any>(null);
  const [allTypes, setAllTypes] = useState<any[]>([]);
  const [assigningType, setAssigningType] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // Stats via RPC
    supabase.rpc('get_spy_cast_stats', { p_account_id: accountId, p_cast_names: [castName] })
      .then(({ data }) => {
        if (data && data.length > 0) setStats(data[0]);
      });

    // Top tippers from spy_messages
    supabase.from('spy_messages')
      .select('user_name, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('msg_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .order('tokens', { ascending: false })
      .limit(50000)
      .then(({ data }) => {
        if (data) {
          const tipMap = new Map<string, number>();
          data.forEach(r => {
            if (r.user_name) tipMap.set(r.user_name, (tipMap.get(r.user_name) || 0) + (r.tokens || 0));
          });
          const sorted = Array.from(tipMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([user_name, total_tokens]) => ({ user_name, total_tokens }));
          setTopTippers(sorted);
        }
      });

    // Recent messages
    supabase.from('spy_messages')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('message_time', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (data) setRecentMessages(data.reverse() as SpyMessage[]);
      });

    // Load cast type if assigned
    if (castInfo?.cast_type_id) {
      supabase.from('cast_types')
        .select('*')
        .eq('id', castInfo.cast_type_id)
        .limit(1)
        .maybeSingle()
        .then(({ data }) => { if (data) setCastType(data); });
    }

    // Load all available types for assignment dropdown
    supabase.from('cast_types')
      .select('id, type_name, benchmark_cast, product_route')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .then(({ data }) => { if (data) setAllTypes(data); });
  }, [accountId, castName, castInfo]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
      {/* Stats cards */}
      <div className="xl:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'メッセージ', value: stats?.total_messages?.toLocaleString() ?? '-', sub: null, color: 'var(--text-primary)' },
          { label: 'チップ回数', value: stats?.total_tips?.toLocaleString() ?? '-', sub: null, color: 'var(--accent-primary)' },
          { label: 'コイン合計', value: stats ? formatTokens(stats.total_coins) : '-', sub: stats ? tokensToJPY(stats.total_coins) : null, color: 'var(--accent-amber)' },
          { label: 'ユニークユーザー', value: stats?.unique_users?.toLocaleString() ?? '-', sub: null, color: 'var(--accent-purple, #a855f7)' },
        ].map(card => (
          <div key={card.label} className="glass-card p-4 text-center">
            <p className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>{card.label}</p>
            <p className="text-2xl font-bold mt-1 tabular-nums" style={{ color: card.color }}>{card.value}</p>
            {card.sub && <p className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{card.sub}</p>}
          </div>
        ))}
      </div>

      {/* 型情報カード */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">型情報</h3>
        {castType ? (
          <div className="space-y-2 text-[11px]">
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>型名</span>
              <span className="font-bold">{castType.type_name}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>ルート</span>
              <span>{castType.product_route === 'harvest' ? '収穫型' : castType.product_route === 'nurture' ? '育成型' : '-'}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>収益パターン</span>
              <span>{castType.revenue_pattern === 'ticket_rotation' ? 'チケチャ回転型' : castType.revenue_pattern === 'public_heavy' ? 'パブ重視型' : castType.revenue_pattern === 'hybrid' ? 'ハイブリッド' : '-'}</span>
            </div>
            {castType.avg_session_revenue_min != null && castType.avg_session_revenue_max != null && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-muted)' }}>売上レンジ</span>
                <span className="tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                  {castType.avg_session_revenue_min.toLocaleString()}-{castType.avg_session_revenue_max.toLocaleString()} tk
                </span>
              </div>
            )}
            <div className="flex gap-2 mt-3">
              <button onClick={() => setAssigningType(true)} className="btn-ghost text-[10px] py-1 px-3">型を変更</button>
              <Link href="/spy" className="btn-ghost text-[10px] py-1 px-3">型の詳細</Link>
            </div>
          </div>
        ) : (
          <div className="text-center py-4">
            <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>型: 未割り当て</p>
            <button onClick={() => setAssigningType(true)} className="btn-primary text-[10px] py-1.5 px-4">
              型を割り当てる
            </button>
          </div>
        )}

        {/* Type assignment dropdown */}
        {assigningType && (
          <div className="mt-3 p-3 rounded-lg" style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)' }}>
            <p className="text-[10px] font-bold mb-2">型を選択</p>
            <select
              value={castType?.id || ''}
              onChange={async (e) => {
                const typeId = e.target.value || null;
                const sb = createClient();

                // Update spy_casts
                await sb.from('spy_casts')
                  .update({ cast_type_id: typeId })
                  .eq('account_id', accountId)
                  .eq('cast_name', castName);

                // Update registered_casts too (if exists)
                await sb.from('registered_casts')
                  .update({ cast_type_id: typeId })
                  .eq('account_id', accountId)
                  .eq('cast_name', castName);

                // Update local state
                if (typeId) {
                  const selected = allTypes.find(t => t.id === typeId);
                  setCastType(selected || null);
                } else {
                  setCastType(null);
                }
                setAssigningType(false);
              }}
              className="w-full text-[11px] px-3 py-1.5 rounded-lg border outline-none mb-2"
              style={{ background: 'rgba(15,23,42,0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
            >
              <option value="">未割り当て</option>
              {allTypes.map(t => (
                <option key={t.id} value={t.id}>
                  {t.type_name} ({t.benchmark_cast}) {t.product_route === 'harvest' ? '' : ''}
                </option>
              ))}
            </select>
            <button onClick={() => setAssigningType(false)} className="btn-ghost text-[10px] py-1 px-3">キャンセル</button>
          </div>
        )}
      </div>

      {/* Cast info */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">キャスト情報</h3>
        <div className="space-y-2 text-[11px]">
          <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>カテゴリ</span><span>{castInfo?.category || '未設定'}</span></div>
          <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>タグ</span><span>{castInfo?.format_tag || '未設定'}</span></div>
          <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>メモ</span><span className="max-w-[150px] truncate">{castInfo?.notes || '-'}</span></div>
          <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>最終活動</span><span>{stats?.last_activity ? timeAgo(stats.last_activity) : '-'}</span></div>
          <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>登録日</span>
            <span>{castInfo ? new Date(castInfo.created_at).toLocaleDateString('ja-JP') : '-'}</span>
          </div>
        </div>
      </div>

      {/* Top tippers */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">💰 トップチッパー</h3>
        {topTippers.length === 0 ? (
          <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>チップデータなし</p>
        ) : (
          <div className="space-y-2">
            {topTippers.map((t, i) => (
              <div key={t.user_name} className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-bold w-4 text-center" style={{
                    color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)' }}>{i + 1}</span>
                  <Link href={`/spy/users/${encodeURIComponent(t.user_name)}`} className="truncate hover:text-sky-400 transition-colors">{t.user_name}</Link>
                </div>
                <span className="flex-shrink-0 font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                  {formatTokens(t.total_tokens)} <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(t.total_tokens)})</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent activity */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">最近のアクティビティ</h3>
        {recentMessages.length === 0 ? (
          <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>ログなし</p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-auto">
            {recentMessages.slice(-15).map(msg => (
              <div key={msg.id} className="text-[10px] flex items-start gap-2">
                <span className="flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                  {new Date(msg.message_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="flex-shrink-0" style={{ color: msg.msg_type === 'tip' || msg.msg_type === 'gift' ? 'var(--accent-amber)' : 'var(--text-secondary)' }}>
                  {msg.user_name || 'system'}
                </span>
                {msg.tokens > 0 && <span className="font-bold" style={{ color: 'var(--accent-amber)' }}>{msg.tokens}tk</span>}
                <span className="truncate" style={{ color: 'var(--text-muted)' }}>{msg.message || ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Sessions Tab — sessionsテーブル直接クエリ + spy_messages集計
   ============================================================ */
function SessionsTab({ castName, accountId }: { castName: string; accountId: string }) {
  const [sessions, setSessions] = useState<{
    session_id: string; started_at: string; ended_at: string;
    total_messages: number; total_tip_revenue: number; total_ticket_revenue: number;
    peak_viewers: number; title: string | null;
    tip_count: number; unique_users: number;
  }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const supabase = createClient();

      console.log('[配信ログ] castName:', castName, 'accountId:', accountId);

      // 1. sessionsテーブルから直接取得（cast_name + ended_at IS NOT NULL）
      const { data: sessionRows, error: sessErr } = await supabase
        .from('sessions')
        .select('*')
        .eq('cast_name', castName)
        .filter('ended_at', 'not.is', null)
        .order('started_at', { ascending: false })
        .limit(30);

      console.log('[配信ログ] sessions結果:', sessionRows?.length, '件', 'error:', JSON.stringify(sessErr));
      if (sessionRows?.length) {
        console.log('[配信ログ] 先頭session:', sessionRows[0].session_id, 'account_id:', sessionRows[0].account_id, 'cast_name:', sessionRows[0].cast_name);
      }

      if (!sessionRows || sessionRows.length === 0) {
        setSessions([]);
        setLoading(false);
        return;
      }

      // 2. spy_messagesからセッション別TIP件数・ユニークユーザー数を集計
      const sessionIds = sessionRows.map(s => s.session_id);
      const { data: msgs } = await supabase
        .from('spy_messages')
        .select('session_id, msg_type, user_name')
        .eq('cast_name', castName)
        .in('session_id', sessionIds)
        .limit(50000);

      // 3. Client-side集計
      const aggMap = new Map<string, { tip_count: number; unique_users: Set<string> }>();
      for (const m of (msgs || [])) {
        if (!m.session_id) continue;
        if (!aggMap.has(m.session_id)) {
          aggMap.set(m.session_id, { tip_count: 0, unique_users: new Set() });
        }
        const agg = aggMap.get(m.session_id)!;
        if (m.msg_type === 'tip' || m.msg_type === 'gift') agg.tip_count++;
        if (m.user_name) agg.unique_users.add(m.user_name);
      }

      // 4. マージ
      const merged = sessionRows.map(s => {
        const agg = aggMap.get(s.session_id);
        return {
          ...s,
          total_tip_revenue: s.total_tip_revenue || 0,
          total_ticket_revenue: s.total_ticket_revenue || 0,
          tip_count: agg?.tip_count || 0,
          unique_users: agg?.unique_users?.size || 0,
        };
      });

      setSessions(merged);
      setLoading(false);
    };
    load();
  }, [accountId, castName]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  return (
    <div className="glass-card p-4">
      <h3 className="text-xs font-bold mb-3">📺 配信セッション一覧 ({sessions.length}件)</h3>
      {sessions.length === 0 ? (
        <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>セッションデータなし</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>日付</th>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>時間</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>MSG</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>TIP</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>COINS</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>USERS</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => {
                const start = new Date(s.started_at);
                const end = new Date(s.ended_at);
                const durationMin = Math.round((end.getTime() - start.getTime()) / 60000);
                const coins = s.total_tip_revenue;
                return (
                  <tr key={s.session_id} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'rgba(56,189,248,0.05)' }}>
                    <td className="py-2.5 px-2 font-medium">
                      {start.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Tokyo' })}
                    </td>
                    <td className="py-2.5 px-2" style={{ color: 'var(--text-secondary)' }}>
                      {start.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })} -
                      {end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })}
                      <span className="ml-1 text-[9px]" style={{ color: 'var(--text-muted)' }}>({durationMin}分)</span>
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{(s.total_messages || 0).toLocaleString()}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums" style={{ color: 'var(--accent-primary)' }}>{s.tip_count}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>
                      {formatTokens(coins)}{coins > 0 && <span className="ml-1 text-[9px] font-normal" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(coins)})</span>}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{s.unique_users}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Users Tab — このキャストのユーザーランキング
   ============================================================ */
function UsersTab({ castName, accountId }: { castName: string; accountId: string }) {
  const [users, setUsers] = useState<{
    user_name: string; status: string; total_tokens: number; tip_count: number;
    last_tip: string | null; last_seen: string | null; first_tip: string | null;
  }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.rpc('get_user_retention_status', {
      p_account_id: accountId,
      p_cast_name: castName,
    }).then(({ data }) => {
      if (data) setUsers(data);
      setLoading(false);
    });
  }, [accountId, castName]);

  const statusColors: Record<string, string> = {
    active: '#22c55e', new: '#38bdf8', at_risk: '#f59e0b', churned: '#f43f5e', free: '#64748b',
  };

  const statusLabels: Record<string, string> = {
    active: 'アクティブ', new: '新規', at_risk: 'リスク', churned: '離脱', free: '無料',
  };

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  return (
    <div className="glass-card p-4">
      <h3 className="text-xs font-bold mb-3">👥 応援ユーザーランキング ({users.length}名)</h3>
      {users.length === 0 ? (
        <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>応援ユーザーデータなし</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>#</th>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>ユーザー</th>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>ステータス</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>COINS</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>TIP回数</th>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>最終TIP</th>
                <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>初回TIP</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={u.user_name} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'rgba(56,189,248,0.05)' }}>
                  <td className="py-2.5 px-2 font-bold" style={{
                    color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)' }}>{i + 1}</td>
                  <td className="py-2.5 px-2">
                    <Link href={`/spy/users/${encodeURIComponent(u.user_name)}`} className="font-semibold hover:text-sky-400 transition-colors">{u.user_name}</Link>
                  </td>
                  <td className="py-2.5 px-2">
                    <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: `${statusColors[u.status] || '#64748b'}20`, color: statusColors[u.status] || '#64748b' }}>
                      {statusLabels[u.status] || u.status}
                    </span>
                  </td>
                  <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(u.total_tokens)}</td>
                  <td className="py-2.5 px-2 text-right tabular-nums">{u.tip_count}</td>
                  <td className="py-2.5 px-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>{u.last_tip ? timeAgo(u.last_tip) : '-'}</td>
                  <td className="py-2.5 px-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>{u.first_tip ? new Date(u.first_tip).toLocaleDateString('ja-JP') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Ticket Tab — チケットショー分析 + CVR
   ============================================================ */
function TicketTab({ castName, accountId }: { castName: string; accountId: string }) {
  const [sessions, setSessions] = useState<{ session_id: string; started_at: string; ended_at: string | null }[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('all');
  const [ticketShows, setTicketShows] = useState<TicketShow[]>([]);
  const [ticketCVRs, setTicketCVRs] = useState<TicketShowCVR[]>([]);
  const [loading, setLoading] = useState(true);

  // Load sessions for this cast
  useEffect(() => {
    const supabase = createClient();
    supabase.from('sessions')
      .select('session_id, started_at, ended_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('started_at', { ascending: false })
      .limit(20)
      .then(({ data }) => { setSessions(data || []); });
  }, [accountId, castName]);

  // Detect ticket shows
  useEffect(() => {
    setLoading(true);
    const supabase = createClient();

    let since: string;
    let until: string | null = null;
    if (selectedSessionId !== 'all') {
      const session = sessions.find(s => s.session_id === selectedSessionId);
      if (session) { since = session.started_at; until = session.ended_at || new Date().toISOString(); }
      else { since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); }
    } else {
      since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    let query = supabase.from('spy_messages')
      .select('message_time, user_name, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('msg_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .gte('message_time', since)
      .order('message_time', { ascending: true })
      .limit(50000);

    if (until) query = query.lte('message_time', until);

    query.then(async ({ data: tipData }) => {
      if (!tipData || tipData.length === 0) {
        setTicketShows([]); setTicketCVRs([]); setLoading(false); return;
      }
      const detected = detectTicketShows(tipData.map(t => ({ tokens: t.tokens, message_time: t.message_time, user_name: t.user_name || '' })));
      setTicketShows(detected);

      const cvrResults: TicketShowCVR[] = [];
      for (const show of detected) {
        const { data: vsData } = await supabase.from('viewer_stats')
          .select('total, coin_holders, ultimate_count')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .lte('recorded_at', show.started_at)
          .order('recorded_at', { ascending: false })
          .limit(1);
        const snapshot: ViewerSnapshot | null = vsData && vsData.length > 0
          ? { total: vsData[0].total || 0, coin_holders: vsData[0].coin_holders || 0, ultimate_count: vsData[0].ultimate_count || 0 }
          : null;
        cvrResults.push(calculateCVR(snapshot, show.estimated_attendees));
      }
      setTicketCVRs(cvrResults);
      setLoading(false);
    });
  }, [accountId, castName, selectedSessionId, sessions]);

  return (
    <div className="space-y-3">
      {/* Session selector */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-xs font-bold" style={{ color: '#a78bfa' }}>🎫 チケットチャット分析</h3>
          <select
            value={selectedSessionId}
            onChange={e => setSelectedSessionId(e.target.value)}
            className="text-[11px] px-3 py-1.5 rounded-lg border outline-none"
            style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
          >
            <option value="all">直近7日間</option>
            {sessions.map(s => {
              const start = new Date(s.started_at);
              const end = s.ended_at ? new Date(s.ended_at) : null;
              const label = `${start.getMonth() + 1}/${start.getDate()} ${start.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}${end ? ` - ${end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : ' (配信中)'}`;
              return <option key={s.session_id} value={s.session_id}>{label}</option>;
            })}
          </select>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>チケチャ検出中...</div>
      ) : ticketShows.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-3xl mb-3">🎫</p>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>チケチャは検出されませんでした</p>
        </div>
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
                {/* Header */}
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
  );
}

/* ============================================================
   Profile Tab — cast_profiles + cast_feeds
   ============================================================ */
function ProfileTab({ castName, accountId }: { castName: string; accountId: string }) {
  const [profile, setProfile] = useState<{
    age: number | null; origin: string | null; body_type: string | null;
    ethnicity: string | null; hair_color: string | null; eye_color: string | null;
    bio: string | null; followers_count: string | null;
    tip_menu: Record<string, unknown>[] | null; epic_goal: Record<string, unknown> | null;
    details: string | null; fetched_at: string | null;
  } | null>(null);
  const [feeds, setFeeds] = useState<{
    id: string; post_text: string | null; post_date: string | null;
    likes_count: number; has_image: boolean; fetched_at: string;
  }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // Load profile
    supabase.from('cast_profiles')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data) setProfile(data); });

    // Load feeds
    supabase.from('cast_feeds')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('fetched_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (data) setFeeds(data);
        setLoading(false);
      });
  }, [accountId, castName]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      {/* Profile info */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">👤 プロフィール情報</h3>
        {!profile ? (
          <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>プロフィールデータなし</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {[
                { label: '年齢', value: profile.age ? `${profile.age}歳` : '-' },
                { label: '出身', value: profile.origin || '-' },
                { label: '体型', value: profile.body_type || '-' },
                { label: '人種', value: profile.ethnicity || '-' },
                { label: '髪色', value: profile.hair_color || '-' },
                { label: '目の色', value: profile.eye_color || '-' },
              ].map(item => (
                <div key={item.label} className="flex justify-between glass-panel px-3 py-2 rounded-lg">
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                  <span className="font-medium">{item.value}</span>
                </div>
              ))}
            </div>

            {/* Followers */}
            {profile.followers_count && (
              <div className="glass-panel px-3 py-2 rounded-lg flex justify-between text-[11px]">
                <span style={{ color: 'var(--text-muted)' }}>フォロワー数</span>
                <span className="font-bold" style={{ color: 'var(--accent-primary)' }}>{profile.followers_count}</span>
              </div>
            )}

            {/* Details */}
            {profile.details && (
              <div>
                <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>詳細</p>
                <p className="text-[11px] glass-panel px-3 py-2 rounded-lg" style={{ color: 'var(--text-secondary)' }}>
                  {profile.details}
                </p>
              </div>
            )}

            {/* Bio */}
            {profile.bio && (
              <div>
                <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>自己紹介</p>
                <p className="text-[11px] glass-panel px-3 py-2 rounded-lg whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                  {profile.bio}
                </p>
              </div>
            )}

            {/* Tip menu */}
            {profile.tip_menu && Array.isArray(profile.tip_menu) && profile.tip_menu.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>チップメニュー</p>
                <div className="space-y-1">
                  {profile.tip_menu.map((item, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px] glass-panel px-3 py-1.5 rounded-lg">
                      <span style={{ color: 'var(--text-secondary)' }}>{String(item.label || item.name || item.action || `Item ${i + 1}`)}</span>
                      <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                        {item.tokens || item.price || item.amount ? `${formatTokens(Number(item.tokens || item.price || item.amount))}` : '-'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Epic goal */}
            {profile.epic_goal && typeof profile.epic_goal === 'object' && (
              <div>
                <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>エピックゴール</p>
                <div className="glass-panel px-3 py-2 rounded-lg text-[11px]">
                  {Object.entries(profile.epic_goal).map(([key, val]) => (
                    <div key={key} className="flex justify-between">
                      <span style={{ color: 'var(--text-muted)' }}>{key}</span>
                      <span className="font-medium">{String(val)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Last fetched */}
            {profile.fetched_at && (
              <p className="text-[9px] text-right" style={{ color: 'var(--text-muted)' }}>
                最終取得: {timeAgo(profile.fetched_at)}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Feeds */}
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">📝 フィード投稿 ({feeds.length}件)</h3>
        {feeds.length === 0 ? (
          <p className="text-[10px] text-center py-4" style={{ color: 'var(--text-muted)' }}>フィード投稿なし</p>
        ) : (
          <div className="space-y-2 max-h-[600px] overflow-auto">
            {feeds.map(f => (
              <div key={f.id} className="glass-panel px-3 py-2.5 rounded-lg">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{f.post_date || '-'}</span>
                  <div className="flex items-center gap-2">
                    {f.has_image && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                        画像付き
                      </span>
                    )}
                    {f.likes_count > 0 && (
                      <span className="text-[10px] tabular-nums" style={{ color: 'var(--accent-pink, #f43f5e)' }}>
                        ♥ {f.likes_count}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-[11px] whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                  {f.post_text || '(テキストなし)'}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Screenshots Tab — スクリーンショット一覧
   ============================================================ */
function ScreenshotsTab({ castName, accountId }: { castName: string; accountId: string }) {
  const [screenshots, setScreenshots] = useState<{
    id: string; filename: string; storage_path: string | null;
    captured_at: string; session_id: string | null;
    signedUrl?: string | null;
  }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data } = await supabase.from('screenshots')
        .select('*')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .order('captured_at', { ascending: false })
        .limit(100);

      if (!data) { setLoading(false); return; }

      // privateバケット → signed URL を生成
      const withUrls = await Promise.all(
        data.map(async (ss: { storage_path?: string | null;[k: string]: unknown }) => {
          if (!ss.storage_path) return ss;
          const pathInBucket = (ss.storage_path as string).startsWith('screenshots/')
            ? (ss.storage_path as string).slice('screenshots/'.length)
            : ss.storage_path;
          const { data: signedData } = await supabase.storage
            .from('screenshots')
            .createSignedUrl(pathInBucket as string, 3600);
          return { ...ss, signedUrl: signedData?.signedUrl || null };
        })
      );
      setScreenshots(withUrls as typeof screenshots);
      setLoading(false);
    })();
  }, [accountId, castName]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  if (screenshots.length === 0) {
    return (
      <div className="glass-card p-8 text-center">
        <p className="text-3xl mb-3">📸</p>
        <h3 className="text-sm font-bold mb-2">スクリーンショット</h3>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          このキャストのスクリーンショットはまだありません。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-3">📸 スクリーンショット ({screenshots.length}枚)</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {screenshots.map(ss => {
            const capturedDate = new Date(ss.captured_at);
            const dateStr = `${capturedDate.getMonth() + 1}/${capturedDate.getDate()} ${capturedDate.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
            const imgUrl = ss.signedUrl || null;
            return (
              <div key={ss.id} className="glass-panel rounded-lg overflow-hidden">
                {imgUrl ? (
                  <a href={imgUrl} target="_blank" rel="noopener noreferrer" className="block">
                    <div className="aspect-video bg-slate-900 relative overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imgUrl}
                        alt={ss.filename}
                        className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                      />
                    </div>
                  </a>
                ) : (
                  <div className="aspect-video bg-slate-900/50 flex items-center justify-center">
                    <span className="text-2xl opacity-30">📸</span>
                  </div>
                )}
                <div className="p-2">
                  <p className="text-[10px] truncate font-medium" style={{ color: 'var(--text-secondary)' }}>{ss.filename}</p>
                  <p className="text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{dateStr}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Format Tab — placeholder
   ============================================================ */
function FormatTab({ castInfo }: { castInfo: SpyCast | null }) {
  return (
    <div className="glass-card p-8 text-center">
      <p className="text-3xl mb-4">📋</p>
      <h3 className="text-sm font-bold mb-2">フォーマット分析</h3>
      <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
        このキャストの配信フォーマット詳細を分析する機能を準備中です。
      </p>
      {castInfo && (
        <div className="inline-block text-left text-[11px] glass-panel p-4">
          <p><span style={{ color: 'var(--text-muted)' }}>カテゴリ:</span> {castInfo.category || '未設定'}</p>
          <p><span style={{ color: 'var(--text-muted)' }}>フォーマットタグ:</span> {castInfo.format_tag || '未設定'}</p>
          <p><span style={{ color: 'var(--text-muted)' }}>メモ:</span> {castInfo.notes || '-'}</p>
        </div>
      )}
    </div>
  );
}
