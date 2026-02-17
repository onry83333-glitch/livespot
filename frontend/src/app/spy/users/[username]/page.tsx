'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, timeAgo } from '@/lib/utils';
import Link from 'next/link';
import type { SpyMessage } from '@/types';

interface UserCastActivity {
  cast_name: string;
  total_coins: number;
  visit_count: number;
  last_visit: string | null;
  message_count: number;
}

export default function UserActivityPage() {
  const params = useParams();
  const username = decodeURIComponent(params.username as string);
  const { user } = useAuth();

  const [accountId, setAccountId] = useState<string | null>(null);
  const [activities, setActivities] = useState<UserCastActivity[]>([]);
  const [recentMessages, setRecentMessages] = useState<SpyMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();

    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }
      setAccountId(data.id);

      // Cross-cast activity via RPC
      const { data: actData } = await supabase.rpc('get_user_activity', {
        p_account_id: data.id,
        p_user_name: username,
      });
      if (actData) setActivities(actData as UserCastActivity[]);

      // Recent messages from this user across all casts
      const { data: msgs } = await supabase
        .from('spy_messages')
        .select('*')
        .eq('account_id', data.id)
        .eq('user_name', username)
        .order('message_time', { ascending: false })
        .limit(50);
      if (msgs) setRecentMessages(msgs as SpyMessage[]);

      setLoading(false);
    });
  }, [user, username]);

  // Totals
  const totalCoins = activities.reduce((s, a) => s + a.total_coins, 0);
  const totalMessages = activities.reduce((s, a) => s + a.message_count, 0);
  const totalVisits = activities.reduce((s, a) => s + a.visit_count, 0);
  const lastSeen = activities.reduce((latest, a) => {
    if (!a.last_visit) return latest;
    return latest && latest > a.last_visit ? latest : a.last_visit;
  }, null as string | null);

  if (!user) return null;

  if (loading) {
    return (
      <div className="h-[calc(100vh-48px)] flex items-center justify-center">
        <div className="glass-card p-8"><p className="text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</p></div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-3 overflow-hidden">
      {/* Header */}
      <div className="glass-card px-5 py-3 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/spy" className="text-xs hover:text-sky-400 transition-colors" style={{ color: 'var(--text-muted)' }}>← SPY</Link>
          <div>
            <h1 className="text-base font-bold flex items-center gap-2">
              👤 {username}
              <span className="text-[10px] px-2 py-0.5 rounded" style={{ background: 'rgba(167,139,250,0.1)', color: 'var(--accent-purple, #a855f7)' }}>横断分析</span>
            </h1>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {activities.length} キャストで活動確認
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto space-y-3">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: '合計コイン', value: formatTokens(totalCoins), color: 'var(--accent-amber)' },
            { label: '合計メッセージ', value: totalMessages.toLocaleString(), color: 'var(--text-primary)' },
            { label: '訪問日数', value: totalVisits.toString(), color: 'var(--accent-primary)' },
            { label: '最終確認', value: lastSeen ? timeAgo(lastSeen) : '-', color: 'var(--accent-green)' },
          ].map(card => (
            <div key={card.label} className="glass-card p-4 text-center">
              <p className="text-[10px] uppercase" style={{ color: 'var(--text-muted)' }}>{card.label}</p>
              <p className="text-xl font-bold mt-1 tabular-nums" style={{ color: card.color }}>{card.value}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {/* Cast-wise breakdown */}
          <div className="glass-card p-4">
            <h3 className="text-xs font-bold mb-3">🎭 キャスト別活動</h3>
            {activities.length === 0 ? (
              <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>活動データなし</p>
            ) : (
              <div className="overflow-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                      <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>キャスト</th>
                      <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>COINS</th>
                      <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>MSG</th>
                      <th className="text-right py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>訪問日</th>
                      <th className="text-left py-2 px-2 font-semibold" style={{ color: 'var(--text-muted)' }}>最終</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activities.map(a => (
                      <tr key={a.cast_name} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'rgba(56,189,248,0.05)' }}>
                        <td className="py-2.5 px-2">
                          <Link href={`/spy/${encodeURIComponent(a.cast_name)}`} className="font-semibold hover:text-sky-400 transition-colors">{a.cast_name}</Link>
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(a.total_coins)}</td>
                        <td className="py-2.5 px-2 text-right tabular-nums">{a.message_count.toLocaleString()}</td>
                        <td className="py-2.5 px-2 text-right tabular-nums">{a.visit_count}</td>
                        <td className="py-2.5 px-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>{a.last_visit ? timeAgo(a.last_visit) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent messages */}
          <div className="glass-card p-4">
            <h3 className="text-xs font-bold mb-3">💬 最近のメッセージ (全キャスト)</h3>
            {recentMessages.length === 0 ? (
              <p className="text-center text-[11px] py-8" style={{ color: 'var(--text-muted)' }}>メッセージなし</p>
            ) : (
              <div className="space-y-1.5 max-h-[400px] overflow-auto">
                {recentMessages.map(msg => (
                  <div key={msg.id} className="text-[10px] flex items-start gap-2 py-0.5">
                    <span className="flex-shrink-0 w-12 text-right tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {new Date(msg.message_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <Link href={`/spy/${encodeURIComponent(msg.cast_name)}`}
                      className="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] hover:opacity-70 transition-opacity"
                      style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
                      {msg.cast_name}
                    </Link>
                    <span className="flex-shrink-0 text-[9px] px-1 rounded" style={{
                      background: msg.msg_type === 'tip' || msg.msg_type === 'gift' ? 'rgba(245,158,11,0.1)' : 'rgba(100,116,139,0.1)',
                      color: msg.msg_type === 'tip' || msg.msg_type === 'gift' ? 'var(--accent-amber)' : 'var(--text-muted)',
                    }}>
                      {msg.msg_type}{msg.tokens > 0 ? ` ${msg.tokens}tk` : ''}
                    </span>
                    <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{msg.message || ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
