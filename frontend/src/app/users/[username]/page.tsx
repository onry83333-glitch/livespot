'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, formatJST, timeAgo, msgTypeLabel } from '@/lib/utils';
import type { SpyMessage } from '@/types';

type MsgTypeFilter = 'all' | 'chat' | 'tip' | 'gift' | 'enter' | 'leave';

export default function UserTimelinePage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const username = decodeURIComponent(params.username as string);
  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SpyMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<MsgTypeFilter>('all');

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

  // ユーザーのメッセージ取得
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data, error: fetchErr } = await sb
          .from('spy_messages')
          .select('*')
          .eq('account_id', accountId)
          .eq('user_name', username)
          .order('message_time', { ascending: false });

        if (fetchErr) throw new Error(fetchErr.message);
        setMessages(data || []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'データ取得に失敗しました');
      } finally {
        setLoading(false);
      }
    })();
  }, [accountId, username, sb]);

  // ユーザーサマリー計算
  const summary = useMemo(() => {
    if (messages.length === 0) return null;
    const totalTokens = messages.reduce((s, m) => s + (m.tokens || 0), 0);
    const times = messages.map(m => new Date(m.message_time).getTime());
    const firstVisit = new Date(Math.min(...times)).toISOString();
    const lastVisit = new Date(Math.max(...times)).toISOString();

    // セッション数: 30分以上の間隔で分割
    const sortedTimes = [...times].sort((a, b) => a - b);
    let sessions = 1;
    for (let i = 1; i < sortedTimes.length; i++) {
      if (sortedTimes[i] - sortedTimes[i - 1] > 30 * 60 * 1000) {
        sessions++;
      }
    }

    return { totalTokens, firstVisit, lastVisit, totalMessages: messages.length, sessions };
  }, [messages]);

  // フィルタ適用
  const filteredMessages = useMemo(() => {
    if (typeFilter === 'all') return messages;
    return messages.filter(m => m.msg_type === typeFilter);
  }, [messages, typeFilter]);

  // 日付グループ化
  const groupedByDate = useMemo(() => {
    const groups = new Map<string, SpyMessage[]>();
    for (const msg of filteredMessages) {
      const dateKey = new Date(msg.message_time).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const existing = groups.get(dateKey);
      if (existing) {
        existing.push(msg);
      } else {
        groups.set(dateKey, [msg]);
      }
    }
    return Array.from(groups.entries());
  }, [filteredMessages]);

  // メッセージタイプ別の色
  const getMsgColor = (type: string) => {
    switch (type) {
      case 'tip':
      case 'gift':
        return 'var(--accent-amber)';
      case 'enter':
      case 'leave':
        return 'var(--text-muted)';
      case 'system':
        return 'var(--text-muted)';
      default:
        return 'var(--text-primary)';
    }
  };

  const getMsgBg = (type: string) => {
    switch (type) {
      case 'tip':
      case 'gift':
        return 'rgba(245,158,11,0.06)';
      case 'enter':
        return 'rgba(34,197,94,0.04)';
      case 'leave':
        return 'rgba(244,63,94,0.04)';
      default:
        return 'transparent';
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-6 max-w-[1200px]">
      {/* 戻るボタン + ヘッダー */}
      <div className="anim-fade-up">
        <button
          onClick={() => router.push('/users')}
          className="text-xs flex items-center gap-1 mb-3 transition-colors hover:text-sky-400"
          style={{ color: 'var(--text-muted)' }}
        >
          ← ユーザー一覧に戻る
        </button>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <span>👤</span> {username}
        </h1>
      </div>

      {error && (
        <div className="glass-card p-4 anim-fade-up" style={{ borderLeft: '3px solid var(--accent-pink)' }}>
          <p className="text-xs" style={{ color: 'var(--accent-pink)' }}>{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !summary ? (
        <div className="glass-card p-10 text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            このユーザーのデータがありません
          </p>
        </div>
      ) : (
        <>
          {/* ユーザーカード */}
          <div className="glass-card p-5 anim-fade-up delay-1">
            <div className="flex items-center gap-4 mb-4">
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold"
                style={{
                  background: summary.totalTokens >= 1000
                    ? 'linear-gradient(135deg, #f59e0b, #ef4444)'
                    : summary.totalTokens > 0
                      ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))'
                      : 'rgba(100,116,139,0.3)',
                }}
              >
                {username.charAt(0).toUpperCase()}
              </div>
              <div>
                <h2 className="text-lg font-bold">{username}</h2>
                <div className="flex items-center gap-2 mt-1">
                  {summary.totalTokens >= 1000 && (
                    <span className="badge-warning text-[9px]">WHALE</span>
                  )}
                  {summary.totalTokens > 0 && summary.totalTokens < 1000 && (
                    <span className="badge-info text-[9px]">TIPPER</span>
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="glass-panel p-3 rounded-xl text-center">
                <p className="text-lg font-bold" style={{ color: 'var(--accent-amber)' }}>
                  {formatTokens(summary.totalTokens)}
                </p>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>累計チップ</p>
                <p className="text-[10px] font-medium" style={{ color: 'var(--accent-green)' }}>
                  {tokensToJPY(summary.totalTokens)}
                </p>
              </div>
              <div className="glass-panel p-3 rounded-xl text-center">
                <p className="text-lg font-bold" style={{ color: 'var(--accent-primary)' }}>
                  {summary.totalMessages.toLocaleString()}
                </p>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>総メッセージ</p>
              </div>
              <div className="glass-panel p-3 rounded-xl text-center">
                <p className="text-lg font-bold" style={{ color: 'var(--accent-purple)' }}>
                  {summary.sessions}
                </p>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>訪問セッション</p>
              </div>
              <div className="glass-panel p-3 rounded-xl text-center">
                <p className="text-sm font-medium">{formatJST(summary.firstVisit)}</p>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>初訪問日</p>
              </div>
              <div className="glass-panel p-3 rounded-xl text-center">
                <p className="text-sm font-medium">{formatJST(summary.lastVisit)}</p>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>最終訪問</p>
                <p className="text-[10px]" style={{ color: 'var(--accent-green)' }}>
                  {timeAgo(summary.lastVisit)}
                </p>
              </div>
            </div>
          </div>

          {/* フィルタ */}
          <div className="glass-card p-4 anim-fade-up delay-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold mr-2" style={{ color: 'var(--text-muted)' }}>
                フィルタ:
              </span>
              {([
                { key: 'all', label: '全て' },
                { key: 'chat', label: '💬 チャット' },
                { key: 'tip', label: '💰 チップ' },
                { key: 'gift', label: '🎁 ギフト' },
                { key: 'enter', label: '👋 入室' },
                { key: 'leave', label: '🚪 退室' },
              ] as { key: MsgTypeFilter; label: string }[]).map(f => (
                <button
                  key={f.key}
                  onClick={() => setTypeFilter(f.key)}
                  className="text-[11px] px-3 py-1.5 rounded-lg transition-all"
                  style={{
                    background: typeFilter === f.key ? 'rgba(56,189,248,0.12)' : 'transparent',
                    color: typeFilter === f.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                    border: typeFilter === f.key ? '1px solid rgba(56,189,248,0.2)' : '1px solid transparent',
                  }}
                >
                  {f.label}
                </button>
              ))}
              <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                {filteredMessages.length.toLocaleString()} 件
              </span>
            </div>
          </div>

          {/* タイムライン */}
          <div className="space-y-4 anim-fade-up delay-3">
            {groupedByDate.length === 0 ? (
              <div className="glass-card p-10 text-center">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  該当するメッセージがありません
                </p>
              </div>
            ) : (
              groupedByDate.map(([date, msgs]) => (
                <div key={date} className="glass-card p-4">
                  {/* 日付ヘッダー */}
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className="text-xs font-bold px-3 py-1 rounded-full"
                      style={{
                        background: 'rgba(56,189,248,0.1)',
                        color: 'var(--accent-primary)',
                        border: '1px solid rgba(56,189,248,0.15)',
                      }}
                    >
                      {date}
                    </div>
                    <div className="h-px flex-1" style={{ background: 'var(--border-glass)' }} />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {msgs.length} 件
                    </span>
                  </div>

                  {/* メッセージ一覧 */}
                  <div className="space-y-1">
                    {msgs.map(msg => (
                      <div
                        key={msg.id}
                        className="flex items-start gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-white/[0.02]"
                        style={{ background: getMsgBg(msg.msg_type) }}
                      >
                        {/* タイプアイコン */}
                        <span className="text-sm w-5 text-center flex-shrink-0 pt-0.5">
                          {msgTypeLabel(msg.msg_type)}
                        </span>

                        {/* 時間 */}
                        <span
                          className="text-[10px] font-mono w-14 flex-shrink-0 pt-0.5"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {new Date(msg.message_time).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>

                        {/* メッセージ内容 */}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs break-words" style={{ color: getMsgColor(msg.msg_type) }}>
                            {msg.message || (msg.msg_type === 'enter' ? '入室しました' : msg.msg_type === 'leave' ? '退室しました' : '—')}
                          </p>
                          {msg.cast_name && (
                            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                              @ {msg.cast_name}
                            </span>
                          )}
                        </div>

                        {/* トークン */}
                        {msg.tokens > 0 && (
                          <span
                            className="text-[11px] font-bold flex-shrink-0 tabular-nums"
                            style={{ color: 'var(--accent-amber)' }}
                          >
                            {formatTokens(msg.tokens)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
