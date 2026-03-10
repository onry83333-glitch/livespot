'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { timeAgo } from '@/lib/utils';
import Link from 'next/link';
import type { RegisteredCast } from '@/types';

export default function SpyCastListTab() {
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
