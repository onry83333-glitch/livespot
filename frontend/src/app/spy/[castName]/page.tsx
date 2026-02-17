'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, timeAgo } from '@/lib/utils';
import Link from 'next/link';
import type { SpyCast, SpyMessage } from '@/types';

type SpyDetailTab = 'overview' | 'sessions' | 'users' | 'format';

const TAB_CONFIG: { key: SpyDetailTab; label: string; icon: string }[] = [
  { key: 'overview', label: '概要',       icon: '📊' },
  { key: 'sessions', label: '配信ログ',   icon: '📺' },
  { key: 'users',    label: 'ユーザー分析', icon: '👥' },
  { key: 'format',   label: 'フォーマット', icon: '📋' },
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
        .single();

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
      .limit(200)
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
  }, [accountId, castName]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
      {/* Stats cards */}
      <div className="xl:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'メッセージ', value: stats?.total_messages?.toLocaleString() ?? '-', color: 'var(--text-primary)' },
          { label: 'チップ回数', value: stats?.total_tips?.toLocaleString() ?? '-', color: 'var(--accent-primary)' },
          { label: 'コイン合計', value: stats ? formatTokens(stats.total_coins) : '-', color: 'var(--accent-amber)' },
          { label: 'ユニークユーザー', value: stats?.unique_users?.toLocaleString() ?? '-', color: 'var(--accent-purple, #a855f7)' },
        ].map(card => (
          <div key={card.label} className="glass-card p-4 text-center">
            <p className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>{card.label}</p>
            <p className="text-2xl font-bold mt-1 tabular-nums" style={{ color: card.color }}>{card.value}</p>
          </div>
        ))}
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
                <div className="flex items-center gap-2">
                  <span className="font-bold w-4 text-center" style={{
                    color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)' }}>{i + 1}</span>
                  <Link href={`/spy/users/${encodeURIComponent(t.user_name)}`} className="hover:text-sky-400 transition-colors">{t.user_name}</Link>
                </div>
                <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>{formatTokens(t.total_tokens)}</span>
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
   Sessions Tab — spy_messagesをセッション日別グルーピング
   ============================================================ */
function SessionsTab({ castName, accountId }: { castName: string; accountId: string }) {
  const [sessions, setSessions] = useState<{
    session_date: string; session_start: string; session_end: string;
    message_count: number; tip_count: number; total_coins: number; unique_users: number;
  }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.rpc('get_cast_sessions', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_since: '2026-02-15',
    }).then(({ data }) => {
      if (data) setSessions(data);
      setLoading(false);
    });
  }, [accountId, castName]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  return (
    <div className="glass-card p-4">
      <h3 className="text-xs font-bold mb-3">📺 配信セッション一覧</h3>
      {sessions.length === 0 ? (
        <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>セッションデータなし（メッセージが5件以上のセッションのみ表示）</p>
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
                const start = new Date(s.session_start);
                const end = new Date(s.session_end);
                const durationMin = Math.round((end.getTime() - start.getTime()) / 60000);
                return (
                  <tr key={i} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'rgba(56,189,248,0.05)' }}>
                    <td className="py-2.5 px-2 font-medium">{s.session_date}</td>
                    <td className="py-2.5 px-2" style={{ color: 'var(--text-secondary)' }}>
                      {start.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} -
                      {end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                      <span className="ml-1 text-[9px]" style={{ color: 'var(--text-muted)' }}>({durationMin}分)</span>
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums">{s.message_count.toLocaleString()}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums" style={{ color: 'var(--accent-primary)' }}>{s.tip_count}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(s.total_coins)}</td>
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
      <h3 className="text-xs font-bold mb-3">👥 課金ユーザーランキング ({users.length}名)</h3>
      {users.length === 0 ? (
        <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>課金ユーザーデータなし</p>
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
