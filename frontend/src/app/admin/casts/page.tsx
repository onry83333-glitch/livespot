'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth-provider';
import type { RegisteredCast, Account } from '@/types';

// ============================================================
// Types
// ============================================================
interface CostSetting {
  cast_name: string;
  revenue_share_rate: number | null;
  platform_fee_rate: number | null;
  token_to_usd: number | null;
}

interface EditState {
  display_name: string;
  platform: string;
  stripchat_model_id: string;
  notes: string;
  genre: string;
  benchmark: string;
  category: string;
  revenue_share_rate: string;
}

// ============================================================
// Presets
// ============================================================
const GENRE_PRESETS = ['女性単体', '絡み配信', 'カップル', 'レズ', '3P+', '男性単体'];
const BENCHMARK_PRESETS = ['新人', '中堅', 'ランカー', 'ベテラン'];
const CATEGORY_PRESETS = ['人妻', '女子大生', 'ギャル', 'お姉さん', '清楚系', '熟女', 'コスプレ', 'その他'];

// ============================================================
// Component
// ============================================================
export default function AdminCastsPage() {
  const { user } = useAuth();
  const sbRef = useRef(createClient());

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [casts, setCasts] = useState<RegisteredCast[]>([]);
  const [costSettings, setCostSettings] = useState<CostSetting[]>([]);
  const [loading, setLoading] = useState(true);

  // 編集
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<EditState>({
    display_name: '', platform: '', stripchat_model_id: '',
    notes: '', genre: '', benchmark: '', category: '',
    revenue_share_rate: '',
  });
  const [saving, setSaving] = useState(false);

  // アカウント取得
  useEffect(() => {
    if (!user) return;
    sbRef.current.from('accounts').select('*').then(({ data }) => {
      if (data && data.length > 0) {
        setAccounts(data);
        setSelectedAccount(data[0].id);
      }
    });
  }, [user]);

  // キャスト一覧 + コスト設定取得
  const loadCasts = useCallback(async () => {
    if (!selectedAccount) return;
    setLoading(true);
    const sb = sbRef.current;

    const [castsRes, costRes] = await Promise.all([
      sb.from('registered_casts')
        .select('*')
        .eq('account_id', selectedAccount)
        .order('is_active', { ascending: false })
        .order('created_at', { ascending: true }),
      sb.from('cast_cost_settings')
        .select('cast_name, revenue_share_rate, platform_fee_rate, token_to_usd')
        .eq('account_id', selectedAccount),
    ]);

    setCasts(castsRes.data || []);
    setCostSettings(costRes.data || []);
    setLoading(false);
  }, [selectedAccount]);

  useEffect(() => { loadCasts(); }, [loadCasts]);

  // 編集開始
  const startEdit = (cast: RegisteredCast) => {
    const cost = costSettings.find(c => c.cast_name === cast.cast_name);
    setEditingId(cast.id);
    setEditState({
      display_name: cast.display_name || '',
      platform: cast.platform || 'stripchat',
      stripchat_model_id: cast.stripchat_model_id || '',
      notes: cast.notes || '',
      genre: cast.genre || '',
      benchmark: cast.benchmark || '',
      category: cast.category || '',
      revenue_share_rate: cost?.revenue_share_rate?.toString() || '50',
    });
  };

  // 編集保存
  const handleSaveEdit = async () => {
    if (!editingId || !selectedAccount) return;
    setSaving(true);
    const sb = sbRef.current;
    const cast = casts.find(c => c.id === editingId);
    if (!cast) { setSaving(false); return; }

    const { error } = await sb
      .from('registered_casts')
      .update({
        display_name: editState.display_name.trim() || null,
        platform: editState.platform || null,
        stripchat_model_id: editState.stripchat_model_id.trim() || null,
        notes: editState.notes.trim() || null,
        genre: editState.genre || null,
        benchmark: editState.benchmark || null,
        category: editState.category || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editingId);

    if (error) { setSaving(false); return; }

    // cost_settings upsert
    const rate = parseFloat(editState.revenue_share_rate);
    if (!isNaN(rate)) {
      await sb.from('cast_cost_settings')
        .upsert({
          account_id: selectedAccount,
          cast_name: cast.cast_name,
          revenue_share_rate: rate,
          effective_from: new Date().toISOString().slice(0, 10),
        }, { onConflict: 'account_id,cast_name,effective_from' });
    }

    setEditingId(null);
    setSaving(false);
    loadCasts();
  };

  // 非活性化 / 復活
  const handleToggleActive = async (cast: RegisteredCast) => {
    const action = cast.is_active ? '無効化' : '有効化';
    if (!confirm(`${cast.cast_name} を${action}しますか？`)) return;
    await sbRef.current
      .from('registered_casts')
      .update({ is_active: !cast.is_active, updated_at: new Date().toISOString() })
      .eq('id', cast.id);
    loadCasts();
  };

  if (!user) return null;

  const activeCasts = casts.filter(c => c.is_active);
  const inactiveCasts = casts.filter(c => !c.is_active);

  return (
    <div className="space-y-6 anim-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">キャスト管理</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            キャストの登録・編集・無効化
          </p>
        </div>
        <div className="flex items-center gap-3">
          {accounts.length > 1 && (
            <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)}
              className="input-glass text-xs py-1.5 px-3 w-48">
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.account_name}</option>
              ))}
            </select>
          )}
          <Link href={`/admin/casts/new${selectedAccount ? `?account=${selectedAccount}` : ''}`}
            className="btn-primary text-xs py-2 px-5">
            + 新規登録
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>{activeCasts.length}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>有効キャスト</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--text-secondary)' }}>{inactiveCasts.length}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>無効キャスト</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-green)' }}>{casts.length}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>合計</p>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="glass-card p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
        </div>
      )}

      {/* Cast List */}
      {!loading && activeCasts.length === 0 && (
        <div className="glass-card p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            キャストが登録されていません。「+ 新規登録」から追加してください。
          </p>
        </div>
      )}

      {!loading && activeCasts.length > 0 && (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--text-muted)' }}>キャスト名</th>
                <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--text-muted)' }}>表示名</th>
                <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--text-muted)' }}>プラットフォーム</th>
                <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--text-muted)' }}>モデルID</th>
                <th className="text-center px-4 py-3 font-semibold" style={{ color: 'var(--text-muted)' }}>分配率</th>
                <th className="text-left px-4 py-3 font-semibold" style={{ color: 'var(--text-muted)' }}>タグ</th>
                <th className="text-center px-4 py-3 font-semibold" style={{ color: 'var(--text-muted)' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {activeCasts.map(cast => {
                const cost = costSettings.find(c => c.cast_name === cast.cast_name);
                const isEditing = editingId === cast.id;

                if (isEditing) {
                  return (
                    <tr key={cast.id} className="border-b" style={{ borderColor: 'var(--border-glass)', background: 'rgba(56,189,248,0.05)' }}>
                      <td colSpan={7} className="px-4 py-4">
                        <div className="space-y-4">
                          <p className="text-sm font-bold mb-3" style={{ color: 'var(--accent-primary)' }}>
                            {cast.cast_name} を編集中
                          </p>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div>
                              <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>表示名</label>
                              <input value={editState.display_name}
                                onChange={e => setEditState(s => ({ ...s, display_name: e.target.value }))}
                                className="input-glass text-xs py-1.5 px-3 w-full"
                                placeholder="例: はなちゃん" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>プラットフォーム</label>
                              <select value={editState.platform}
                                onChange={e => setEditState(s => ({ ...s, platform: e.target.value }))}
                                className="input-glass text-xs py-1.5 px-3 w-full">
                                <option value="stripchat">Stripchat</option>
                                <option value="chaturbate">Chaturbate</option>
                                <option value="other">その他</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>StripchatモデルID</label>
                              <input value={editState.stripchat_model_id}
                                onChange={e => setEditState(s => ({ ...s, stripchat_model_id: e.target.value }))}
                                className="input-glass text-xs py-1.5 px-3 w-full"
                                placeholder="例: abc123" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>分配率 (%)</label>
                              <input type="number" min="0" max="100" step="0.1"
                                value={editState.revenue_share_rate}
                                onChange={e => setEditState(s => ({ ...s, revenue_share_rate: e.target.value }))}
                                className="input-glass text-xs py-1.5 px-3 w-full"
                                placeholder="50" />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            <div>
                              <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>ジャンル</label>
                              <select value={editState.genre}
                                onChange={e => setEditState(s => ({ ...s, genre: e.target.value }))}
                                className="input-glass text-xs py-1.5 px-3 w-full">
                                <option value="">未設定</option>
                                {GENRE_PRESETS.map(g => <option key={g} value={g}>{g}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>ランク</label>
                              <select value={editState.benchmark}
                                onChange={e => setEditState(s => ({ ...s, benchmark: e.target.value }))}
                                className="input-glass text-xs py-1.5 px-3 w-full">
                                <option value="">未設定</option>
                                {BENCHMARK_PRESETS.map(b => <option key={b} value={b}>{b}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>カテゴリ</label>
                              <select value={editState.category}
                                onChange={e => setEditState(s => ({ ...s, category: e.target.value }))}
                                className="input-glass text-xs py-1.5 px-3 w-full">
                                <option value="">未設定</option>
                                {CATEGORY_PRESETS.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>メモ</label>
                            <input value={editState.notes}
                              onChange={e => setEditState(s => ({ ...s, notes: e.target.value }))}
                              className="input-glass text-xs py-1.5 px-3 w-full"
                              placeholder="自由メモ" />
                          </div>
                          <div className="flex gap-2">
                            <button onClick={handleSaveEdit} disabled={saving}
                              className="btn-primary text-xs py-1.5 px-4">
                              {saving ? '保存中...' : '保存'}
                            </button>
                            <button onClick={() => setEditingId(null)}
                              className="btn-ghost text-xs py-1.5 px-4">
                              キャンセル
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={cast.id} className="border-b hover:bg-white/[0.02] transition-colors"
                    style={{ borderColor: 'var(--border-glass)' }}>
                    <td className="px-4 py-3">
                      <Link href={`/casts/${encodeURIComponent(cast.cast_name)}`}
                        className="font-semibold hover:underline" style={{ color: 'var(--accent-primary)' }}>
                        {cast.cast_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                      {cast.display_name || '—'}
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                      {cast.platform || 'stripchat'}
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                      {cast.stripchat_model_id || '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="badge" style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--accent-green)' }}>
                        {cost?.revenue_share_rate ?? 50}%
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {cast.genre && <span className="badge">{cast.genre}</span>}
                        {cast.benchmark && <span className="badge">{cast.benchmark}</span>}
                        {cast.category && <span className="badge">{cast.category}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex gap-1 justify-center">
                        <button onClick={() => startEdit(cast)}
                          className="btn-ghost text-[10px] py-1 px-2">
                          編集
                        </button>
                        <button onClick={() => handleToggleActive(cast)}
                          className="text-[10px] py-1 px-2 rounded-lg hover:bg-rose-500/10 transition-colors"
                          style={{ color: 'var(--accent-pink)' }}>
                          無効化
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Inactive casts */}
      {!loading && inactiveCasts.length > 0 && (
        <div>
          <h2 className="text-sm font-bold mb-3" style={{ color: 'var(--text-muted)' }}>
            無効キャスト ({inactiveCasts.length})
          </h2>
          <div className="glass-card overflow-hidden opacity-60">
            <table className="w-full text-xs">
              <tbody>
                {inactiveCasts.map(cast => (
                  <tr key={cast.id} className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                    <td className="px-4 py-2.5 font-semibold" style={{ color: 'var(--text-secondary)' }}>
                      {cast.cast_name}
                    </td>
                    <td className="px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>
                      {cast.display_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => handleToggleActive(cast)}
                        className="btn-ghost text-[10px] py-1 px-3">
                        有効化
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
