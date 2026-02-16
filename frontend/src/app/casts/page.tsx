'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, timeAgo } from '@/lib/utils';
import type { Account } from '@/types';

interface CastSummary {
  cast_name: string;
  total_messages: number;
  total_coins: number;
  unique_users: number;
  last_activity: string;
  tip_count: number;
}

export default function CastsPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [casts, setCasts] = useState<CastSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [coinRate] = useState(7.7);

  // アカウント一覧を取得
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('*').then(({ data }) => {
      if (data && data.length > 0) {
        setAccounts(data);
        setSelectedAccount(data[0].id);
      }
    });
  }, [user]);

  // キャスト別集計を取得
  useEffect(() => {
    if (!selectedAccount) return;
    setLoading(true);

    const supabase = createClient();
    supabase
      .from('spy_messages')
      .select('cast_name, message_time, msg_type, user_name, tokens')
      .eq('account_id', selectedAccount)
      .order('message_time', { ascending: false })
      .limit(5000)
      .then(({ data }) => {
        if (!data || data.length === 0) {
          setCasts([]);
          setLoading(false);
          return;
        }

        // キャスト別に集計
        const castMap = new Map<string, {
          total_messages: number;
          total_coins: number;
          users: Set<string>;
          last_activity: string;
          tip_count: number;
        }>();

        for (const msg of data) {
          const cn = msg.cast_name;
          if (!castMap.has(cn)) {
            castMap.set(cn, {
              total_messages: 0,
              total_coins: 0,
              users: new Set(),
              last_activity: msg.message_time,
              tip_count: 0,
            });
          }
          const entry = castMap.get(cn)!;
          entry.total_messages++;
          if (msg.msg_type === 'tip' || msg.msg_type === 'gift') {
            entry.total_coins += msg.tokens || 0;
            entry.tip_count++;
          }
          if (msg.user_name) {
            entry.users.add(msg.user_name);
          }
          // message_timeはdesc orderなので最初のが最新
          if (!entry.last_activity || msg.message_time > entry.last_activity) {
            entry.last_activity = msg.message_time;
          }
        }

        const summaries: CastSummary[] = Array.from(castMap.entries())
          .map(([cast_name, entry]) => ({
            cast_name,
            total_messages: entry.total_messages,
            total_coins: entry.total_coins,
            unique_users: entry.users.size,
            last_activity: entry.last_activity,
            tip_count: entry.tip_count,
          }))
          .sort((a, b) => b.total_coins - a.total_coins);

        setCasts(summaries);
        setLoading(false);
      });
  }, [selectedAccount]);

  // 全体統計
  const totals = useMemo(() => {
    return {
      casts: casts.length,
      messages: casts.reduce((s, c) => s + c.total_messages, 0),
      coins: casts.reduce((s, c) => s + c.total_coins, 0),
      users: casts.reduce((s, c) => s + c.unique_users, 0),
    };
  }, [casts]);

  if (!user) return null;

  return (
    <div className="space-y-6 anim-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">📋 キャスト一覧</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            自社キャストの配信データと売上サマリー
          </p>
        </div>

        {/* Account selector */}
        {accounts.length > 1 && (
          <select
            value={selectedAccount}
            onChange={e => setSelectedAccount(e.target.value)}
            className="input-glass text-xs py-1.5 px-3 w-48"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.account_name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>
            {totals.casts}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>キャスト数</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-amber)' }}>
            {formatTokens(totals.coins)}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>総チップ</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-green)' }}>
            {tokensToJPY(totals.coins, coinRate)}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>推定売上</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-purple, #a855f7)' }}>
            {totals.users}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>ユニークユーザー</p>
        </div>
      </div>

      {/* Cast List */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">読み込み中...</p>
          </div>
        ) : casts.length === 0 ? (
          <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">キャストデータがありません</p>
            <p className="text-xs mt-2">SPY監視を開始するとキャストデータが蓄積されます</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider"
                style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}>
                <th className="text-left px-5 py-3 font-semibold">キャスト名</th>
                <th className="text-right px-4 py-3 font-semibold">メッセージ</th>
                <th className="text-right px-4 py-3 font-semibold">チップ数</th>
                <th className="text-right px-4 py-3 font-semibold">総コイン</th>
                <th className="text-right px-4 py-3 font-semibold">推定売上</th>
                <th className="text-right px-4 py-3 font-semibold">ユーザー</th>
                <th className="text-right px-5 py-3 font-semibold">最終活動</th>
              </tr>
            </thead>
            <tbody>
              {casts.map((cast, i) => (
                <tr key={cast.cast_name}
                  className="text-xs hover:bg-white/[0.02] transition-colors"
                  style={{ borderBottom: '1px solid var(--border-glass)' }}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold w-6 text-center" style={{
                        color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)'
                      }}>
                        {i + 1}
                      </span>
                      <span className="font-semibold">{cast.cast_name}</span>
                    </div>
                  </td>
                  <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {cast.total_messages.toLocaleString()}
                  </td>
                  <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {cast.tip_count.toLocaleString()}
                  </td>
                  <td className="text-right px-4 py-3 font-semibold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                    {formatTokens(cast.total_coins)}
                  </td>
                  <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--accent-green)' }}>
                    {tokensToJPY(cast.total_coins, coinRate)}
                  </td>
                  <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--accent-purple, #a855f7)' }}>
                    {cast.unique_users}
                  </td>
                  <td className="text-right px-5 py-3" style={{ color: 'var(--text-muted)' }}>
                    {timeAgo(cast.last_activity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
