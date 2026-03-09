'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth-provider';
import { timeAgo } from '@/lib/utils';
import type { RegisteredCast, SpyCast, Account } from '@/types';

// ============================================================
// Types
// ============================================================
interface CostSetting {
  cast_name: string;
  revenue_share_rate: number | null;
  platform_fee_rate: number | null;
  token_to_usd: number | null;
}

interface RegisteredEditState {
  display_name: string;
  platform: string;
  stripchat_model_id: string;
  stripchat_user_id: string;
  notes: string;
  genre: string;
  benchmark: string;
  category: string;
  screenshot_interval: string;
  gc_rate_per_minute: string;
  revenue_share_rate: string;
}

interface SpyEditState {
  display_name: string;
  stripchat_model_id: string;
  notes: string;
  genre: string;
  benchmark: string;
  category: string;
  format_tag: string;
  screenshot_interval: string;
  auto_monitor: boolean;
}

// ============================================================
// Presets
// ============================================================
const GENRE_PRESETS = ['女性単体', '絡み配信', 'カップル', 'レズ', '3P+', '男性単体'];
const BENCHMARK_PRESETS = ['新人', '中堅', 'ランカー', 'ベテラン'];
const CATEGORY_PRESETS = ['人妻', '女子大生', 'ギャル', 'お姉さん', '清楚系', '熟女', 'コスプレ', 'その他'];
const FORMAT_TAG_PRESETS = ['ソロ', 'カップル', 'レズ', 'グループ', 'トーク系', 'ゲーム系', 'その他'];

// ============================================================
// Main Component
// ============================================================
export default function AdminCastsPage() {
  const { user } = useAuth();
  const sbRef = useRef(createClient());

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [activeTab, setActiveTab] = useState<'registered' | 'spy'>('registered');

  // --- Registered Casts ---
  const [casts, setCasts] = useState<RegisteredCast[]>([]);
  const [costSettings, setCostSettings] = useState<CostSetting[]>([]);
  const [loadingRegistered, setLoadingRegistered] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<RegisteredEditState>({
    display_name: '', platform: '', stripchat_model_id: '', stripchat_user_id: '',
    notes: '', genre: '', benchmark: '', category: '',
    screenshot_interval: '5', gc_rate_per_minute: '12', revenue_share_rate: '50',
  });
  const [saving, setSaving] = useState(false);

  // --- Spy Casts ---
  const [spyCasts, setSpyCasts] = useState<SpyCast[]>([]);
  const [loadingSpy, setLoadingSpy] = useState(true);
  const [spyEditingId, setSpyEditingId] = useState<number | null>(null);
  const [spyEditState, setSpyEditState] = useState<SpyEditState>({
    display_name: '', stripchat_model_id: '', notes: '',
    genre: '', benchmark: '', category: '', format_tag: '',
    screenshot_interval: '0', auto_monitor: false,
  });
  const [spySaving, setSpySaving] = useState(false);
  const [spyNewName, setSpyNewName] = useState('');
  const [spyAdding, setSpyAdding] = useState(false);
  const [spyAddError, setSpyAddError] = useState<string | null>(null);

  // Spy filters
  const [spyFilterGenre, setSpyFilterGenre] = useState('');
  const [spyHideExtinct, setSpyHideExtinct] = useState(false);

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

  // Registered casts + コスト設定取得
  const loadRegisteredCasts = useCallback(async () => {
    if (!selectedAccount) return;
    setLoadingRegistered(true);
    const sb = sbRef.current;
    const [castsRes, costRes] = await Promise.all([
      sb.from('registered_casts').select('*')
        .eq('account_id', selectedAccount)
        .order('is_active', { ascending: false })
        .order('created_at', { ascending: true }),
      sb.from('cast_cost_settings')
        .select('cast_name, revenue_share_rate, platform_fee_rate, token_to_usd')
        .eq('account_id', selectedAccount),
    ]);
    setCasts(castsRes.data || []);
    setCostSettings(costRes.data || []);
    setLoadingRegistered(false);
  }, [selectedAccount]);

  // Spy casts 取得
  const loadSpyCasts = useCallback(async () => {
    if (!selectedAccount) return;
    setLoadingSpy(true);
    const { data } = await sbRef.current
      .from('spy_casts').select('*')
      .eq('account_id', selectedAccount)
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: false });
    setSpyCasts(data || []);
    setLoadingSpy(false);
  }, [selectedAccount]);

  useEffect(() => { loadRegisteredCasts(); loadSpyCasts(); }, [loadRegisteredCasts, loadSpyCasts]);

  // ============================================================
  // Registered Cast Handlers
  // ============================================================
  const startEdit = (cast: RegisteredCast) => {
    const cost = costSettings.find(c => c.cast_name === cast.cast_name);
    setEditingId(cast.id);
    setEditState({
      display_name: cast.display_name || '',
      platform: cast.platform || 'stripchat',
      stripchat_model_id: cast.stripchat_model_id || '',
      stripchat_user_id: (cast as RegisteredCast & { stripchat_user_id?: number | null }).stripchat_user_id?.toString() || '',
      notes: cast.notes || '',
      genre: cast.genre || '',
      benchmark: cast.benchmark || '',
      category: cast.category || '',
      screenshot_interval: (cast.screenshot_interval ?? 5).toString(),
      gc_rate_per_minute: (cast.gc_rate_per_minute ?? 12).toString(),
      revenue_share_rate: cost?.revenue_share_rate?.toString() || '50',
    });
  };

  const handleSaveEdit = async () => {
    if (!editingId || !selectedAccount) return;
    setSaving(true);
    const sb = sbRef.current;
    const cast = casts.find(c => c.id === editingId);
    if (!cast) { setSaving(false); return; }

    const siVal = parseInt(editState.screenshot_interval);
    const gcVal = parseFloat(editState.gc_rate_per_minute);
    const suVal = editState.stripchat_user_id.trim();

    const updateObj: Record<string, unknown> = {
      display_name: editState.display_name.trim() || null,
      platform: editState.platform || null,
      stripchat_model_id: editState.stripchat_model_id.trim() || null,
      notes: editState.notes.trim() || null,
      genre: editState.genre || null,
      benchmark: editState.benchmark || null,
      category: editState.category || null,
      screenshot_interval: !isNaN(siVal) ? siVal : 5,
      gc_rate_per_minute: !isNaN(gcVal) ? gcVal : 12,
      updated_at: new Date().toISOString(),
    };
    if (suVal) updateObj.stripchat_user_id = parseInt(suVal) || null;

    const { error } = await sb.from('registered_casts').update(updateObj).eq('id', editingId);
    if (error) { setSaving(false); return; }

    // cost_settings upsert
    const rate = parseFloat(editState.revenue_share_rate);
    if (!isNaN(rate)) {
      await sb.from('cast_cost_settings').upsert({
        account_id: selectedAccount,
        cast_name: cast.cast_name,
        revenue_share_rate: rate,
        effective_from: new Date().toISOString().slice(0, 10),
      }, { onConflict: 'account_id,cast_name,effective_from' });
    }

    setEditingId(null);
    setSaving(false);
    loadRegisteredCasts();
  };

  const handleToggleActive = async (cast: RegisteredCast) => {
    const action = cast.is_active ? '無効化' : '有効化';
    if (!confirm(`${cast.cast_name} を${action}しますか？`)) return;
    await sbRef.current.from('registered_casts')
      .update({ is_active: !cast.is_active, updated_at: new Date().toISOString() })
      .eq('id', cast.id);
    loadRegisteredCasts();
  };

  const handleDelete = async (cast: RegisteredCast) => {
    if (!confirm(`${cast.cast_name} を完全に削除しますか？\nこの操作は取り消せません。`)) return;
    const sb = sbRef.current;
    await sb.from('cast_cost_settings').delete()
      .eq('account_id', selectedAccount).eq('cast_name', cast.cast_name);
    await sb.from('registered_casts').delete().eq('id', cast.id);
    loadRegisteredCasts();
  };

  // ============================================================
  // Spy Cast Handlers
  // ============================================================
  const startSpyEdit = (cast: SpyCast) => {
    setSpyEditingId(cast.id);
    setSpyEditState({
      display_name: cast.display_name || '',
      stripchat_model_id: cast.stripchat_model_id || '',
      notes: cast.notes || '',
      genre: cast.genre || '',
      benchmark: cast.benchmark || '',
      category: cast.category || '',
      format_tag: cast.format_tag || '',
      screenshot_interval: (cast.screenshot_interval ?? 0).toString(),
      auto_monitor: cast.auto_monitor || false,
    });
  };

  const handleSpySaveEdit = async () => {
    if (!spyEditingId) return;
    setSpySaving(true);
    const siVal = parseInt(spyEditState.screenshot_interval);
    await sbRef.current.from('spy_casts').update({
      display_name: spyEditState.display_name.trim() || null,
      stripchat_model_id: spyEditState.stripchat_model_id.trim() || null,
      notes: spyEditState.notes.trim() || null,
      genre: spyEditState.genre || null,
      benchmark: spyEditState.benchmark || null,
      category: spyEditState.category || null,
      format_tag: spyEditState.format_tag || null,
      screenshot_interval: !isNaN(siVal) ? siVal : 0,
      auto_monitor: spyEditState.auto_monitor,
      updated_at: new Date().toISOString(),
    }).eq('id', spyEditingId);

    setSpyEditingId(null);
    setSpySaving(false);
    loadSpyCasts();
  };

  const handleSpyAdd = async () => {
    const name = spyNewName.trim();
    if (!name || !selectedAccount) return;
    setSpyAdding(true);
    setSpyAddError(null);
    const { error } = await sbRef.current.from('spy_casts').insert({
      account_id: selectedAccount,
      cast_name: name,
      stripchat_url: `https://stripchat.com/${name}`,
    });
    if (error) {
      setSpyAddError(error.code === '23505' ? `${name} は既に登録済みです` : error.message);
    } else {
      setSpyNewName('');
    }
    setSpyAdding(false);
    loadSpyCasts();
  };

  const handleSpyToggleActive = async (cast: SpyCast) => {
    const action = cast.is_active ? '無効化' : '有効化';
    if (!confirm(`${cast.cast_name} を${action}しますか？`)) return;
    await sbRef.current.from('spy_casts')
      .update({ is_active: !cast.is_active, updated_at: new Date().toISOString() })
      .eq('id', cast.id);
    loadSpyCasts();
  };

  const handleSpyDelete = async (cast: SpyCast) => {
    if (!confirm(`${cast.cast_name} を完全に削除しますか？\nこの操作は取り消せません。`)) return;
    await sbRef.current.from('spy_casts').delete().eq('id', cast.id);
    loadSpyCasts();
  };

  // ============================================================
  // Filtered spy casts
  // ============================================================
  const filteredSpyCasts = spyCasts.filter(c => {
    if (spyHideExtinct && c.is_extinct) return false;
    if (spyFilterGenre && c.genre !== spyFilterGenre) return false;
    return true;
  });
  const activeSpyCasts = filteredSpyCasts.filter(c => c.is_active);
  const inactiveSpyCasts = filteredSpyCasts.filter(c => !c.is_active);

  if (!user) return null;

  const activeCasts = casts.filter(c => c.is_active);
  const inactiveCasts = casts.filter(c => !c.is_active);

  // ============================================================
  // Shared styles
  // ============================================================
  const labelCls = "block text-[10px] font-semibold mb-1";
  const labelStyle = { color: 'var(--text-muted)' };

  return (
    <div className="space-y-6 anim-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">キャスト管理</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            自社・他社キャストの登録・編集・無効化
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
          {activeTab === 'registered' && (
            <Link href={`/admin/casts/new${selectedAccount ? `?account=${selectedAccount}` : ''}`}
              className="btn-primary text-xs py-2 px-5">
              + 自社キャスト登録
            </Link>
          )}
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'rgba(15,23,42,0.5)' }}>
        <button
          onClick={() => setActiveTab('registered')}
          className={`flex-1 py-2 px-4 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'registered' ? 'text-white' : ''
          }`}
          style={activeTab === 'registered'
            ? { background: 'rgba(56,189,248,0.15)', color: 'var(--accent-primary)' }
            : { color: 'var(--text-muted)' }
          }
        >
          自社キャスト ({casts.length})
        </button>
        <button
          onClick={() => setActiveTab('spy')}
          className={`flex-1 py-2 px-4 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'spy' ? 'text-white' : ''
          }`}
          style={activeTab === 'spy'
            ? { background: 'rgba(167,139,250,0.15)', color: 'var(--accent-purple)' }
            : { color: 'var(--text-muted)' }
          }
        >
          他社キャスト ({spyCasts.length})
        </button>
      </div>

      {/* ============================================================
          自社キャスト TAB
          ============================================================ */}
      {activeTab === 'registered' && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>{activeCasts.length}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>有効</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--text-secondary)' }}>{inactiveCasts.length}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>無効</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-green)' }}>{casts.length}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>合計</p>
            </div>
          </div>

          {loadingRegistered && (
            <div className="glass-card p-8 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
            </div>
          )}

          {!loadingRegistered && activeCasts.length === 0 && (
            <div className="glass-card p-8 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                キャストが登録されていません。「+ 自社キャスト登録」から追加してください。
              </p>
            </div>
          )}

          {!loadingRegistered && activeCasts.length > 0 && (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>キャスト名</th>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>表示名</th>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>PF</th>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>モデルID</th>
                    <th className="text-center px-4 py-3 font-semibold" style={labelStyle}>分配率</th>
                    <th className="text-center px-4 py-3 font-semibold" style={labelStyle}>SS間隔</th>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>タグ</th>
                    <th className="text-right px-4 py-3 font-semibold" style={labelStyle}>最終確認</th>
                    <th className="text-center px-4 py-3 font-semibold" style={labelStyle}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {activeCasts.map(cast => {
                    const cost = costSettings.find(c => c.cast_name === cast.cast_name);
                    const isEditing = editingId === cast.id;

                    if (isEditing) {
                      return (
                        <tr key={cast.id} className="border-b" style={{ borderColor: 'var(--border-glass)', background: 'rgba(56,189,248,0.05)' }}>
                          <td colSpan={9} className="px-4 py-4">
                            <div className="space-y-4">
                              <p className="text-sm font-bold mb-3" style={{ color: 'var(--accent-primary)' }}>
                                {cast.cast_name} を編集中
                              </p>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div>
                                  <label className={labelCls} style={labelStyle}>表示名</label>
                                  <input value={editState.display_name}
                                    onChange={e => setEditState(s => ({ ...s, display_name: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full" placeholder="例: はなちゃん" />
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>プラットフォーム</label>
                                  <select value={editState.platform}
                                    onChange={e => setEditState(s => ({ ...s, platform: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="stripchat">Stripchat</option>
                                    <option value="chaturbate">Chaturbate</option>
                                    <option value="other">その他</option>
                                  </select>
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>StripchatモデルID</label>
                                  <input value={editState.stripchat_model_id}
                                    onChange={e => setEditState(s => ({ ...s, stripchat_model_id: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full" placeholder="abc123" />
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>StripchatユーザーID</label>
                                  <input value={editState.stripchat_user_id}
                                    onChange={e => setEditState(s => ({ ...s, stripchat_user_id: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full" placeholder="数値" />
                                </div>
                              </div>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div>
                                  <label className={labelCls} style={labelStyle}>分配率 (%)</label>
                                  <input type="number" min="0" max="100" step="0.1"
                                    value={editState.revenue_share_rate}
                                    onChange={e => setEditState(s => ({ ...s, revenue_share_rate: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full" placeholder="50" />
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>SS間隔 (分)</label>
                                  <select value={editState.screenshot_interval}
                                    onChange={e => setEditState(s => ({ ...s, screenshot_interval: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="0">OFF</option>
                                    <option value="1">1分</option>
                                    <option value="3">3分</option>
                                    <option value="5">5分</option>
                                    <option value="10">10分</option>
                                    <option value="15">15分</option>
                                    <option value="30">30分</option>
                                  </select>
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>GCレート (tk/分)</label>
                                  <input type="number" min="0" step="0.1"
                                    value={editState.gc_rate_per_minute}
                                    onChange={e => setEditState(s => ({ ...s, gc_rate_per_minute: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full" placeholder="12" />
                                </div>
                              </div>
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                <div>
                                  <label className={labelCls} style={labelStyle}>ジャンル</label>
                                  <select value={editState.genre}
                                    onChange={e => setEditState(s => ({ ...s, genre: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="">未設定</option>
                                    {GENRE_PRESETS.map(g => <option key={g} value={g}>{g}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>ランク</label>
                                  <select value={editState.benchmark}
                                    onChange={e => setEditState(s => ({ ...s, benchmark: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="">未設定</option>
                                    {BENCHMARK_PRESETS.map(b => <option key={b} value={b}>{b}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>カテゴリ</label>
                                  <select value={editState.category}
                                    onChange={e => setEditState(s => ({ ...s, category: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="">未設定</option>
                                    {CATEGORY_PRESETS.map(c => <option key={c} value={c}>{c}</option>)}
                                  </select>
                                </div>
                              </div>
                              <div>
                                <label className={labelCls} style={labelStyle}>メモ</label>
                                <input value={editState.notes}
                                  onChange={e => setEditState(s => ({ ...s, notes: e.target.value }))}
                                  className="input-glass text-xs py-1.5 px-3 w-full" placeholder="自由メモ" />
                              </div>
                              <div className="flex gap-2">
                                <button onClick={handleSaveEdit} disabled={saving}
                                  className="btn-primary text-xs py-1.5 px-4">
                                  {saving ? '保存中...' : '保存'}
                                </button>
                                <button onClick={() => setEditingId(null)}
                                  className="btn-ghost text-xs py-1.5 px-4">キャンセル</button>
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
                        <td className="px-4 py-3 text-center" style={{ color: (cast.screenshot_interval ?? 5) > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                          {(cast.screenshot_interval ?? 5) > 0 ? `${cast.screenshot_interval ?? 5}分` : 'OFF'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {cast.genre && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold" style={{ color: '#38bdf8', background: 'rgba(56,189,248,0.12)' }}>{cast.genre}</span>}
                            {cast.benchmark && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold" style={{ color: '#22c55e', background: 'rgba(34,197,94,0.12)' }}>{cast.benchmark}</span>}
                            {cast.category && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>{cast.category}</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right" style={{ color: 'var(--text-muted)' }}>
                          {cast.last_seen_online ? timeAgo(cast.last_seen_online) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <div className="flex gap-1 justify-center">
                            <button onClick={() => startEdit(cast)}
                              className="btn-ghost text-[10px] py-1 px-2">編集</button>
                            <button onClick={() => handleToggleActive(cast)}
                              className="text-[10px] py-1 px-2 rounded-lg hover:bg-rose-500/10 transition-colors"
                              style={{ color: 'var(--accent-pink)' }}>無効化</button>
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
          {!loadingRegistered && inactiveCasts.length > 0 && (
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
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => handleToggleActive(cast)}
                              className="btn-ghost text-[10px] py-1 px-3">有効化</button>
                            <button onClick={() => handleDelete(cast)}
                              className="text-[10px] py-1 px-2 rounded-lg hover:bg-rose-500/10 transition-colors"
                              style={{ color: 'var(--accent-pink)' }}>削除</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ============================================================
          他社キャスト TAB
          ============================================================ */}
      {activeTab === 'spy' && (
        <>
          {/* Quick Add + Filters */}
          <div className="glass-card p-4 space-y-3">
            <div className="flex items-center gap-3">
              <input value={spyNewName} onChange={e => setSpyNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSpyAdd()}
                className="input-glass text-xs py-2 px-3 flex-1"
                placeholder="他社キャスト名を入力（Stripchatユーザー名）" />
              <button onClick={handleSpyAdd} disabled={!spyNewName.trim() || spyAdding}
                className="btn-primary text-xs py-2 px-5 whitespace-nowrap disabled:opacity-50">
                {spyAdding ? '追加中...' : '+ 追加'}
              </button>
            </div>
            {spyAddError && (
              <p className="text-xs" style={{ color: 'var(--accent-pink)' }}>{spyAddError}</p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <select value={spyFilterGenre} onChange={e => setSpyFilterGenre(e.target.value)}
                className="input-glass text-[10px] py-1 px-2">
                <option value="">全ジャンル</option>
                {GENRE_PRESETS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={spyHideExtinct} onChange={e => setSpyHideExtinct(e.target.checked)}
                  className="rounded" />
                引退済みを非表示
              </label>
              <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                {activeSpyCasts.length}件 表示中
              </span>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-purple)' }}>{spyCasts.filter(c => c.is_active).length}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>有効</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--text-secondary)' }}>{spyCasts.filter(c => !c.is_active).length}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>無効</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-amber)' }}>{spyCasts.filter(c => c.is_extinct).length}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>引退</p>
            </div>
          </div>

          {loadingSpy && (
            <div className="glass-card p-8 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
            </div>
          )}

          {!loadingSpy && activeSpyCasts.length === 0 && (
            <div className="glass-card p-8 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                他社キャストが登録されていません。上の入力欄から追加してください。
              </p>
            </div>
          )}

          {!loadingSpy && activeSpyCasts.length > 0 && (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>キャスト名</th>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>表示名</th>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>モデルID</th>
                    <th className="text-center px-4 py-3 font-semibold" style={labelStyle}>自動監視</th>
                    <th className="text-center px-4 py-3 font-semibold" style={labelStyle}>SS間隔</th>
                    <th className="text-left px-4 py-3 font-semibold" style={labelStyle}>タグ</th>
                    <th className="text-right px-4 py-3 font-semibold" style={labelStyle}>最終確認</th>
                    <th className="text-center px-4 py-3 font-semibold" style={labelStyle}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSpyCasts.map(cast => {
                    const isEditing = spyEditingId === cast.id;

                    if (isEditing) {
                      return (
                        <tr key={cast.id} className="border-b" style={{ borderColor: 'var(--border-glass)', background: 'rgba(167,139,250,0.05)' }}>
                          <td colSpan={8} className="px-4 py-4">
                            <div className="space-y-4">
                              <p className="text-sm font-bold mb-3" style={{ color: 'var(--accent-purple)' }}>
                                {cast.cast_name} を編集中
                              </p>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div>
                                  <label className={labelCls} style={labelStyle}>表示名</label>
                                  <input value={spyEditState.display_name}
                                    onChange={e => setSpyEditState(s => ({ ...s, display_name: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full" placeholder="表示名" />
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>StripchatモデルID</label>
                                  <input value={spyEditState.stripchat_model_id}
                                    onChange={e => setSpyEditState(s => ({ ...s, stripchat_model_id: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full" placeholder="abc123" />
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>SS間隔 (分)</label>
                                  <select value={spyEditState.screenshot_interval}
                                    onChange={e => setSpyEditState(s => ({ ...s, screenshot_interval: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="0">OFF</option>
                                    <option value="1">1分</option>
                                    <option value="3">3分</option>
                                    <option value="5">5分</option>
                                    <option value="10">10分</option>
                                    <option value="15">15分</option>
                                    <option value="30">30分</option>
                                  </select>
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>自動監視</label>
                                  <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
                                    <input type="checkbox" checked={spyEditState.auto_monitor}
                                      onChange={e => setSpyEditState(s => ({ ...s, auto_monitor: e.target.checked }))}
                                      className="rounded" />
                                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>有効</span>
                                  </label>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div>
                                  <label className={labelCls} style={labelStyle}>ジャンル</label>
                                  <select value={spyEditState.genre}
                                    onChange={e => setSpyEditState(s => ({ ...s, genre: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="">未設定</option>
                                    {GENRE_PRESETS.map(g => <option key={g} value={g}>{g}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>ランク</label>
                                  <select value={spyEditState.benchmark}
                                    onChange={e => setSpyEditState(s => ({ ...s, benchmark: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="">未設定</option>
                                    {BENCHMARK_PRESETS.map(b => <option key={b} value={b}>{b}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>カテゴリ</label>
                                  <select value={spyEditState.category}
                                    onChange={e => setSpyEditState(s => ({ ...s, category: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="">未設定</option>
                                    {CATEGORY_PRESETS.map(c => <option key={c} value={c}>{c}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <label className={labelCls} style={labelStyle}>フォーマット</label>
                                  <select value={spyEditState.format_tag}
                                    onChange={e => setSpyEditState(s => ({ ...s, format_tag: e.target.value }))}
                                    className="input-glass text-xs py-1.5 px-3 w-full">
                                    <option value="">未設定</option>
                                    {FORMAT_TAG_PRESETS.map(f => <option key={f} value={f}>{f}</option>)}
                                  </select>
                                </div>
                              </div>
                              <div>
                                <label className={labelCls} style={labelStyle}>メモ</label>
                                <input value={spyEditState.notes}
                                  onChange={e => setSpyEditState(s => ({ ...s, notes: e.target.value }))}
                                  className="input-glass text-xs py-1.5 px-3 w-full" placeholder="自由メモ" />
                              </div>
                              <div className="flex gap-2">
                                <button onClick={handleSpySaveEdit} disabled={spySaving}
                                  className="btn-primary text-xs py-1.5 px-4">
                                  {spySaving ? '保存中...' : '保存'}
                                </button>
                                <button onClick={() => setSpyEditingId(null)}
                                  className="btn-ghost text-xs py-1.5 px-4">キャンセル</button>
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
                          <div className="flex items-center gap-2">
                            <Link href={`/spy/${encodeURIComponent(cast.cast_name)}`}
                              className="font-semibold hover:underline" style={{ color: 'var(--accent-purple)' }}>
                              {cast.cast_name}
                            </Link>
                            {cast.is_extinct && (
                              <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold"
                                style={{ color: 'var(--accent-amber)', background: 'rgba(245,158,11,0.12)' }}>
                                引退
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                          {cast.display_name || '—'}
                        </td>
                        <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                          {cast.stripchat_model_id || '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className="text-[10px]" style={{ color: cast.auto_monitor ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                            {cast.auto_monitor ? 'ON' : 'OFF'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center" style={{ color: (cast.screenshot_interval ?? 0) > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                          {(cast.screenshot_interval ?? 0) > 0 ? `${cast.screenshot_interval}分` : 'OFF'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {cast.genre && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold" style={{ color: '#38bdf8', background: 'rgba(56,189,248,0.12)' }}>{cast.genre}</span>}
                            {cast.benchmark && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold" style={{ color: '#22c55e', background: 'rgba(34,197,94,0.12)' }}>{cast.benchmark}</span>}
                            {cast.category && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>{cast.category}</span>}
                            {cast.format_tag && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold" style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)' }}>{cast.format_tag}</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right" style={{ color: 'var(--text-muted)' }}>
                          {cast.last_seen_online ? timeAgo(cast.last_seen_online) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <div className="flex gap-1 justify-center">
                            <button onClick={() => startSpyEdit(cast)}
                              className="btn-ghost text-[10px] py-1 px-2">編集</button>
                            <button onClick={() => handleSpyToggleActive(cast)}
                              className="text-[10px] py-1 px-2 rounded-lg hover:bg-rose-500/10 transition-colors"
                              style={{ color: 'var(--accent-pink)' }}>無効化</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Inactive spy casts */}
          {!loadingSpy && inactiveSpyCasts.length > 0 && (
            <div>
              <h2 className="text-sm font-bold mb-3" style={{ color: 'var(--text-muted)' }}>
                無効キャスト ({inactiveSpyCasts.length})
              </h2>
              <div className="glass-card overflow-hidden opacity-60">
                <table className="w-full text-xs">
                  <tbody>
                    {inactiveSpyCasts.map(cast => (
                      <tr key={cast.id} className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                        <td className="px-4 py-2.5 font-semibold" style={{ color: 'var(--text-secondary)' }}>
                          {cast.cast_name}
                          {cast.is_extinct && (
                            <span className="ml-2 text-[8px] px-1.5 py-0.5 rounded font-semibold"
                              style={{ color: 'var(--accent-amber)', background: 'rgba(245,158,11,0.12)' }}>
                              引退
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>
                          {cast.display_name || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => handleSpyToggleActive(cast)}
                              className="btn-ghost text-[10px] py-1 px-3">有効化</button>
                            <button onClick={() => handleSpyDelete(cast)}
                              className="text-[10px] py-1 px-2 rounded-lg hover:bg-rose-500/10 transition-colors"
                              style={{ color: 'var(--accent-pink)' }}>削除</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
