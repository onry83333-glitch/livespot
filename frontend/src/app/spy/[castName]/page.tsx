'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, timeAgo, tokensToJPY } from '@/lib/utils';
import Link from 'next/link';
import type { SpyCast, SpyMessage } from '@/types';
import { mapChatLog } from '@/lib/table-mappers';

type SpyDetailTab = 'overview' | 'sessions' | 'users' | 'format';

const TAB_CONFIG: { key: SpyDetailTab; label: string; icon: string }[] = [
  { key: 'overview',     label: '概要',         icon: '📊' },
  { key: 'sessions',     label: '配信ログ',     icon: '📺' },
  { key: 'users',        label: 'ユーザー分析', icon: '👥' },
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

    // Top tippers from chat_logs
    supabase.from('chat_logs')
      .select('username, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('message_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .order('tokens', { ascending: false })
      .limit(50000)
      .then(({ data }) => {
        if (data) {
          const tipMap = new Map<string, number>();
          data.forEach(r => {
            if (r.username) tipMap.set(r.username, (tipMap.get(r.username) || 0) + (r.tokens || 0));
          });
          const sorted = Array.from(tipMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([user_name, total_tokens]) => ({ user_name, total_tokens }));
          setTopTippers(sorted);
        }
      });

    // Recent messages
    supabase.from('chat_logs')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('timestamp', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (data) setRecentMessages(data.map(mapChatLog).reverse() as SpyMessage[]);
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
    broadcast_group_id: string; session_ids: string[];
    started_at: string; ended_at: string;
    session_title: string | null;
    msg_count: number; chat_tokens: number; tip_count: number;
    duration_minutes: number; total_revenue: number;
  }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const supabase = createClient();

      // get_session_list_v2: chat_logsから正確な売上を集計（自社と同一ロジック）
      // sessions.total_tokens はコレクター再起動時にリセットされるため不正確
      const { data, error } = await supabase.rpc('get_session_list_v2', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_limit: 30,
        p_offset: 0,
      });

      if (error) {
        console.warn('[SessionsTab] v2 RPC error, falling back to chat_logs:', error.message);
        // フォールバック: chat_logsから直接集計
        const { data: rawData } = await supabase
          .from('chat_logs')
          .select('session_id, cast_name, timestamp, username, tokens')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .not('session_id', 'is', null)
          .order('timestamp', { ascending: false })
          .limit(5000);

        if (!rawData || rawData.length === 0) {
          setSessions([]);
          setLoading(false);
          return;
        }

        const sessionMap = new Map<string, { session_id: string; messages: { time: string; tokens: number }[] }>();
        for (const r of rawData) {
          if (!r.session_id) continue;
          if (!sessionMap.has(r.session_id)) {
            sessionMap.set(r.session_id, { session_id: r.session_id, messages: [] });
          }
          sessionMap.get(r.session_id)!.messages.push({ time: r.timestamp, tokens: r.tokens || 0 });
        }

        const rows = Array.from(sessionMap.values()).map(sess => {
          const times = sess.messages.map(m => new Date(m.time).getTime());
          const minTime = Math.min(...times);
          const maxTime = Math.max(...times);
          const totalTk = sess.messages.reduce((s, m) => s + (m.tokens > 0 ? m.tokens : 0), 0);
          const tips = sess.messages.filter(m => m.tokens > 0).length;
          return {
            broadcast_group_id: sess.session_id,
            session_ids: [sess.session_id],
            started_at: new Date(minTime).toISOString(),
            ended_at: new Date(maxTime).toISOString(),
            session_title: null as string | null,
            msg_count: sess.messages.length,
            chat_tokens: totalTk,
            tip_count: tips,
            duration_minutes: Math.round((maxTime - minTime) / 60000),
            total_revenue: totalTk,
          };
        });
        rows.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
        setSessions(rows);
        setLoading(false);
        return;
      }

      setSessions((data || []).map((r: Record<string, unknown>) => ({
        broadcast_group_id: r.broadcast_group_id as string,
        session_ids: r.session_ids as string[],
        started_at: r.started_at as string,
        ended_at: r.ended_at as string,
        session_title: r.session_title as string | null,
        msg_count: (r.msg_count as number) || 0,
        chat_tokens: (r.chat_tokens as number) || 0,
        tip_count: (r.tip_count as number) || 0,
        duration_minutes: (r.duration_minutes as number) || 0,
        total_revenue: (r.total_revenue as number) || 0,
      })));
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
                <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>タイトル</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>MSG</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>TIP</th>
                <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>COINS</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const start = new Date(s.started_at);
                const end = new Date(s.ended_at);
                const durationMin = s.duration_minutes || Math.round((end.getTime() - start.getTime()) / 60000);
                const totalCoins = s.total_revenue;
                return (
                  <tr key={s.broadcast_group_id} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'rgba(56,189,248,0.05)' }}>
                    <td className="py-2.5 px-2 font-medium">
                      {start.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Tokyo' })}
                    </td>
                    <td className="py-2.5 px-2" style={{ color: 'var(--text-secondary)' }}>
                      {start.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })} -
                      {end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })}
                      <span className="ml-1 text-[9px]" style={{ color: 'var(--text-muted)' }}>({durationMin}分)</span>
                    </td>
                    <td className="py-2.5 px-2 max-w-[200px] truncate" style={{ color: s.session_title ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                      {s.session_title || '-'}
                      {s.session_ids.length > 1 && (
                        <span className="ml-1 text-[9px] px-1 rounded" style={{ background: 'rgba(56,189,248,0.1)', color: '#38bdf8' }}>
                          {s.session_ids.length}セッション統合
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{(s.msg_count || 0).toLocaleString()}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums" style={{ color: 'var(--accent-primary)' }}>{s.tip_count}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>
                      {formatTokens(totalCoins)}{totalCoins > 0 && <span className="ml-1 text-[9px] font-normal" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(totalCoins)})</span>}
                    </td>
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
