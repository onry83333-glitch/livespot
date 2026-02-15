'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, timeAgo } from '@/lib/utils';

interface UserSummary {
  user_name: string;
  messageCount: number;
  totalTokens: number;
  lastActivity: string;
}

export default function UsersPage() {
  const { user } = useAuth();
  const router = useRouter();
  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'tokens' | 'messages' | 'recent'>('tokens');

  // アカウントID取得
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const { data } = await sb.from('accounts').select('id').limit(1).single();
        if (data) setAccountId(data.id);
      } catch { /* ignored */ }
    })();
  }, [user, sb]);

  // ユーザー一覧取得（RPC関数 or フォールバック）
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // RPC関数を試行（003マイグレーション適用後に有効）
        const { data: rpcData, error: rpcError } = await sb.rpc('user_summary', { p_account_id: accountId });

        if (!rpcError && rpcData) {
          setUsers(rpcData.map((r: { user_name: string; message_count: number; total_tokens: number; last_activity: string }) => ({
            user_name: r.user_name,
            messageCount: Number(r.message_count),
            totalTokens: Number(r.total_tokens),
            lastActivity: r.last_activity,
          })));
        } else {
          // フォールバック: クライアント側集計
          const { data, error: fetchErr } = await sb
            .from('spy_messages')
            .select('user_name, tokens, message_time, msg_type')
            .eq('account_id', accountId)
            .not('user_name', 'is', null);

          if (fetchErr) throw new Error(fetchErr.message);
          if (!data) { setUsers([]); return; }

          const map = new Map<string, UserSummary>();
          for (const row of data) {
            const name = row.user_name as string;
            const isTipOrGift = row.msg_type === 'tip' || row.msg_type === 'gift';
            const existing = map.get(name);
            if (existing) {
              existing.messageCount += 1;
              if (isTipOrGift) existing.totalTokens += row.tokens || 0;
              if (row.message_time > existing.lastActivity) {
                existing.lastActivity = row.message_time;
              }
            } else {
              map.set(name, {
                user_name: name,
                messageCount: 1,
                totalTokens: isTipOrGift ? (row.tokens || 0) : 0,
                lastActivity: row.message_time,
              });
            }
          }
          setUsers(Array.from(map.values()));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'データ取得に失敗しました');
      } finally {
        setLoading(false);
      }
    })();
  }, [accountId, sb]);

  // 検索・ソート
  const filteredUsers = useMemo(() => {
    let list = users;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(u => u.user_name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (sortBy === 'tokens') return b.totalTokens - a.totalTokens;
      if (sortBy === 'messages') return b.messageCount - a.messageCount;
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });
  }, [users, search, sortBy]);

  if (!user) return null;

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* ヘッダー */}
      <div className="anim-fade-up">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <span>👥</span> ユーザー管理
        </h1>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          チャットユーザーの一覧と統合タイムライン
        </p>
      </div>

      {/* フィルタバー */}
      <div className="glass-card p-4 anim-fade-up delay-1">
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="input-glass text-sm flex-1 min-w-[200px]"
            placeholder="🔍 ユーザー名で検索..."
          />
          <div className="flex items-center gap-1">
            {([
              { key: 'tokens', label: '💰 チップ順' },
              { key: 'messages', label: '💬 メッセージ順' },
              { key: 'recent', label: '🕐 最新順' },
            ] as const).map(s => (
              <button
                key={s.key}
                onClick={() => setSortBy(s.key)}
                className="text-[11px] px-3 py-1.5 rounded-lg transition-all"
                style={{
                  background: sortBy === s.key ? 'rgba(56,189,248,0.12)' : 'transparent',
                  color: sortBy === s.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                  border: sortBy === s.key ? '1px solid rgba(56,189,248,0.2)' : '1px solid transparent',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 統計サマリー */}
      <div className="grid grid-cols-3 gap-3 anim-fade-up delay-2">
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>
            {users.length.toLocaleString()}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>ユニークユーザー</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-amber)' }}>
            {formatTokens(users.reduce((s, u) => s + u.totalTokens, 0))}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>累計チップ</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-green)' }}>
            {users.reduce((s, u) => s + u.messageCount, 0).toLocaleString()}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>累計メッセージ</p>
        </div>
      </div>

      {/* エラー表示 */}
      {error && (
        <div className="glass-card p-4 anim-fade-up" style={{ borderLeft: '3px solid var(--accent-pink)' }}>
          <p className="text-xs" style={{ color: 'var(--accent-pink)' }}>{error}</p>
        </div>
      )}

      {/* ユーザー一覧 */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="glass-card p-10 text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {search ? '検索結果なし' : 'ユーザーデータがありません'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 anim-fade-up delay-3">
          {filteredUsers.map(u => (
            <div
              key={u.user_name}
              onClick={() => router.push(`/users/${encodeURIComponent(u.user_name)}`)}
              className="glass-card-hover p-4 cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
                    style={{
                      background: u.totalTokens >= 1000
                        ? 'linear-gradient(135deg, #f59e0b, #ef4444)'
                        : u.totalTokens > 0
                          ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))'
                          : 'rgba(100,116,139,0.3)',
                    }}
                  >
                    {u.user_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{u.user_name}</p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {timeAgo(u.lastActivity)}
                    </p>
                  </div>
                </div>
                {u.totalTokens >= 1000 && (
                  <span className="badge-warning text-[9px] flex-shrink-0">WHALE</span>
                )}
              </div>

              <div className="flex items-center gap-4 mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-glass)' }}>
                <div className="text-[11px]">
                  <span style={{ color: 'var(--text-muted)' }}>MSG </span>
                  <span className="font-semibold">{u.messageCount.toLocaleString()}</span>
                </div>
                <div className="text-[11px]">
                  <span style={{ color: 'var(--text-muted)' }}>TIP </span>
                  <span className="font-semibold" style={{ color: u.totalTokens > 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                    {formatTokens(u.totalTokens)}
                  </span>
                </div>
                <div className="text-[11px] ml-auto">
                  <span style={{ color: 'var(--accent-green)' }}>
                    {tokensToJPY(u.totalTokens)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
