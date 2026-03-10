'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, timeAgo } from '@/lib/utils';
import Link from 'next/link';
import type { SpyCast } from '@/types';

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

export default function SpyCompetitorListTab() {
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

      // registered_casts の cast_name 一覧を取得（自社キャスト除外用）
      const { data: ownCasts } = await supabase
        .from('registered_casts')
        .select('cast_name')
        .eq('account_id', data.id)
        .eq('is_active', true);
      const ownNames = new Set((ownCasts || []).map(c => c.cast_name));

      const { data: casts } = await supabase
        .from('spy_casts')
        .select('*')
        .eq('account_id', data.id)
        .order('created_at', { ascending: false })
        .limit(100);

      if (casts) {
        // 自社キャストを除外（registered_castsに存在するcast_nameはspy一覧に表示しない）
        const filtered = (casts as SpyCast[]).filter(c => !ownNames.has(c.cast_name));
        setSpyCasts(filtered);
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
