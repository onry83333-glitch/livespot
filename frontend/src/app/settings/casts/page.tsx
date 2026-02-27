'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import type { SpyCast } from '@/types';

const GENRE_PRESETS = ['女性単体', '絡み配信', 'カップル', 'レズ', '3P+', '男性単体'];
const BENCHMARK_PRESETS = ['新人', '中堅', 'ランカー', 'ベテラン'];
const CATEGORY_PRESETS = ['人妻', '女子大生', 'ギャル', 'お姉さん', '清楚系', '熟女', 'コスプレ', 'その他'];

export default function SpyCastsPage() {
  const { user } = useAuth();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [casts, setCasts] = useState<SpyCast[]>([]);
  const [loading, setLoading] = useState(true);

  // アカウントIDを動的取得
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user]);

  // Add form
  const [showForm, setShowForm] = useState(false);
  const [formCastName, setFormCastName] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formGenre, setFormGenre] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formAutoMonitor, setFormAutoMonitor] = useState(false);
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Edit mode
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editGenre, setEditGenre] = useState('');
  const [editBenchmark, setEditBenchmark] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editAutoMonitor, setEditAutoMonitor] = useState(false);
  const [editScreenshotInterval, setEditScreenshotInterval] = useState(0);

  // Search / filter
  const [search, setSearch] = useState('');
  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'inactive'>('active');

  // Fetch spy_casts
  useEffect(() => {
    if (!user || !accountId) return;
    setLoading(true);
    const supabase = createClient();

    let query = supabase
      .from('spy_casts')
      .select('*')
      .eq('account_id', accountId)
      .order('cast_name', { ascending: true });

    if (filterActive === 'active') query = query.eq('is_active', true);
    else if (filterActive === 'inactive') query = query.eq('is_active', false);

    query.then(({ data, error }) => {
      if (error) {
        console.error('spy_casts fetch error:', error);
      }
      setCasts(data || []);
      setLoading(false);
    });
  }, [user, accountId, filterActive]);

  // Filtered by search
  const filteredCasts = casts.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.cast_name.toLowerCase().includes(q) ||
      (c.display_name || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q) ||
      (c.notes || '').toLowerCase().includes(q)
    );
  });

  // Register new cast
  const handleRegister = useCallback(async () => {
    const name = formCastName.trim();
    if (!name || !accountId) return;
    setFormSaving(true);
    setFormError(null);

    const supabase = createClient();
    const { data, error } = await supabase
      .from('spy_casts')
      .insert({
        account_id: accountId,
        cast_name: name,
        display_name: formDisplayName.trim() || null,
        stripchat_url: `https://stripchat.com/${name}`,
        category: formCategory || null,
        genre: formGenre || null,
        notes: formNotes.trim() || null,
        auto_monitor: formAutoMonitor,
      })
      .select()
      .single();

    if (error) {
      setFormError(
        error.code === '23505'
          ? `${name} は既に登録済みです`
          : error.message
      );
      setFormSaving(false);
      return;
    }

    setCasts(prev => [...prev, data as SpyCast].sort((a, b) => a.cast_name.localeCompare(b.cast_name)));
    setFormCastName('');
    setFormDisplayName('');
    setFormCategory('');
    setFormGenre('');
    setFormNotes('');
    setFormAutoMonitor(false);
    setShowForm(false);
    setFormSaving(false);
  }, [accountId, formCastName, formDisplayName, formCategory, formGenre, formNotes, formAutoMonitor]);

  // Save edit
  const handleSaveEdit = useCallback(async (castId: number) => {
    const supabase = createClient();
    const { error } = await supabase
      .from('spy_casts')
      .update({
        display_name: editDisplayName.trim() || null,
        category: editCategory || null,
        genre: editGenre || null,
        benchmark: editBenchmark || null,
        notes: editNotes.trim() || null,
        auto_monitor: editAutoMonitor,
        screenshot_interval: editScreenshotInterval,
        updated_at: new Date().toISOString(),
      })
      .eq('id', castId);

    if (error) {
      console.error('spy_casts update error:', error);
      return;
    }

    setCasts(prev =>
      prev.map(c =>
        c.id === castId
          ? {
              ...c,
              display_name: editDisplayName.trim() || null,
              category: editCategory || null,
              genre: editGenre || null,
              benchmark: editBenchmark || null,
              notes: editNotes.trim() || null,
              auto_monitor: editAutoMonitor,
              screenshot_interval: editScreenshotInterval,
            }
          : c,
      ),
    );
    setEditingId(null);
  }, [editDisplayName, editCategory, editGenre, editBenchmark, editNotes, editAutoMonitor, editScreenshotInterval]);

  // Soft delete (is_active = false)
  const handleDeactivate = useCallback(async (castId: number, castName: string) => {
    if (!confirm(`${castName} を非アクティブにしますか？`)) return;
    const supabase = createClient();
    const { error } = await supabase
      .from('spy_casts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', castId);
    if (!error) {
      if (filterActive === 'active') {
        setCasts(prev => prev.filter(c => c.id !== castId));
      } else {
        setCasts(prev => prev.map(c => c.id === castId ? { ...c, is_active: false } : c));
      }
    }
  }, [filterActive]);

  // Reactivate
  const handleReactivate = useCallback(async (castId: number) => {
    const supabase = createClient();
    const { error } = await supabase
      .from('spy_casts')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', castId);
    if (!error) {
      if (filterActive === 'inactive') {
        setCasts(prev => prev.filter(c => c.id !== castId));
      } else {
        setCasts(prev => prev.map(c => c.id === castId ? { ...c, is_active: true } : c));
      }
    }
  }, [filterActive]);

  // Start editing
  const startEdit = (cast: SpyCast) => {
    setEditingId(cast.id);
    setEditDisplayName(cast.display_name || '');
    setEditCategory(cast.category || '');
    setEditGenre(cast.genre || '');
    setEditBenchmark(cast.benchmark || '');
    setEditNotes(cast.notes || '');
    setEditAutoMonitor(cast.auto_monitor);
    setEditScreenshotInterval(cast.screenshot_interval ?? 0);
  };

  if (!user || !accountId) return null;

  return (
    <div className="space-y-6 anim-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/settings" className="text-xs hover:opacity-80 transition-opacity"
              style={{ color: 'var(--text-muted)' }}>
              Settings
            </Link>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>/</span>
            <h1 className="text-xl font-bold">SPY キャスト管理</h1>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            監視対象キャストの登録・編集・管理
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filterActive}
            onChange={e => setFilterActive(e.target.value as 'all' | 'active' | 'inactive')}
            className="input-glass text-xs py-1.5 px-3"
          >
            <option value="active">アクティブのみ</option>
            <option value="inactive">非アクティブのみ</option>
            <option value="all">すべて</option>
          </select>
          <button
            onClick={() => setShowForm(!showForm)}
            className="btn-primary text-xs py-1.5 px-4"
          >
            {showForm ? 'キャンセル' : '+ キャスト追加'}
          </button>
        </div>
      </div>

      {/* Registration Form */}
      {showForm && (
        <div className="glass-card p-5 anim-fade-up">
          <h3 className="text-sm font-bold mb-4">新規SPYキャスト登録</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>
                キャスト名 <span style={{ color: 'var(--accent-pink)' }}>*</span>
              </label>
              <input
                type="text"
                value={formCastName}
                onChange={e => setFormCastName(e.target.value)}
                className="input-glass text-xs w-full"
                placeholder="Stripchatのユーザー名"
                onKeyDown={e => e.key === 'Enter' && handleRegister()}
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>表示名</label>
              <input
                type="text"
                value={formDisplayName}
                onChange={e => setFormDisplayName(e.target.value)}
                className="input-glass text-xs w-full"
                placeholder="識別用の名前"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>メモ</label>
              <input
                type="text"
                value={formNotes}
                onChange={e => setFormNotes(e.target.value)}
                className="input-glass text-xs w-full"
                placeholder="任意のメモ"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>カテゴリ</label>
              <select
                value={formCategory}
                onChange={e => setFormCategory(e.target.value)}
                className="input-glass text-xs w-full"
              >
                <option value="">選択...</option>
                {CATEGORY_PRESETS.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>ジャンル</label>
              <select
                value={formGenre}
                onChange={e => setFormGenre(e.target.value)}
                className="input-glass text-xs w-full"
              >
                <option value="">選択...</option>
                {GENRE_PRESETS.map(g => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formAutoMonitor}
                  onChange={e => setFormAutoMonitor(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  自動監視ON
                </span>
              </label>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={handleRegister}
              disabled={!formCastName.trim() || formSaving}
              className="btn-primary text-xs py-1.5 px-6 disabled:opacity-50"
            >
              {formSaving ? '登録中...' : '登録する'}
            </button>
            {formError && (
              <span className="text-xs" style={{ color: 'var(--accent-pink)' }}>{formError}</span>
            )}
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>
            {casts.filter(c => c.is_active).length}
            <span className="text-sm font-medium ml-0.5">名</span>
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>アクティブ</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-green)' }}>
            {casts.filter(c => c.auto_monitor).length}
            <span className="text-sm font-medium ml-0.5">名</span>
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>自動監視ON</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-amber)' }}>
            {filteredCasts.length}
            <span className="text-sm font-medium ml-0.5">件</span>
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>表示中</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--text-secondary)' }}>
            {casts.filter(c => !c.is_active).length}
            <span className="text-sm font-medium ml-0.5">名</span>
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>非アクティブ</p>
        </div>
      </div>

      {/* Search */}
      <div>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="input-glass text-xs w-full md:w-80"
          placeholder="キャスト名・表示名・カテゴリで検索..."
        />
      </div>

      {/* Cast Table */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">読み込み中...</p>
          </div>
        ) : filteredCasts.length === 0 ? (
          <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">
              {search ? '検索結果がありません' : 'SPYキャストが登録されていません'}
            </p>
            {!search && (
              <p className="text-xs mt-2">
                「+ キャスト追加」ボタンから登録してください
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr
                  className="text-[10px] uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}
                >
                  <th className="text-left px-5 py-3 font-semibold">キャスト</th>
                  <th className="text-left px-3 py-3 font-semibold">タグ</th>
                  <th className="text-center px-3 py-3 font-semibold">監視</th>
                  <th className="text-center px-3 py-3 font-semibold">SS間隔</th>
                  <th className="text-left px-3 py-3 font-semibold">最終オンライン</th>
                  <th className="text-center px-3 py-3 font-semibold">状態</th>
                  <th className="text-center px-3 py-3 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredCasts.map(cast => (
                  <tr
                    key={cast.id}
                    className="text-xs hover:bg-white/[0.02] transition-colors"
                    style={{ borderBottom: '1px solid var(--border-glass)' }}
                  >
                    {/* Cast name column */}
                    <td className="px-5 py-3">
                      {editingId === cast.id ? (
                        <div className="space-y-1">
                          <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>
                            {cast.cast_name}
                          </span>
                          <input
                            type="text"
                            value={editDisplayName}
                            onChange={e => setEditDisplayName(e.target.value)}
                            className="input-glass text-[11px] w-full py-1 px-2"
                            placeholder="表示名"
                          />
                          <input
                            type="text"
                            value={editNotes}
                            onChange={e => setEditNotes(e.target.value)}
                            className="input-glass text-[11px] w-full py-1 px-2"
                            placeholder="メモ"
                          />
                        </div>
                      ) : (
                        <div className="min-w-0">
                          <a
                            href={cast.stripchat_url || `https://stripchat.com/${cast.cast_name}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:opacity-80 transition-opacity"
                          >
                            <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>
                              {cast.cast_name}
                            </span>
                          </a>
                          {cast.display_name && (
                            <span className="ml-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              ({cast.display_name})
                            </span>
                          )}
                          {cast.notes && (
                            <p className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                              {cast.notes}
                            </p>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Tags column */}
                    <td className="px-3 py-3">
                      {editingId === cast.id ? (
                        <div className="flex flex-col gap-1">
                          <select
                            value={editGenre}
                            onChange={e => setEditGenre(e.target.value)}
                            className="text-[10px] px-1.5 py-0.5 rounded border outline-none"
                            style={{ background: 'rgba(15,23,42,0.6)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
                          >
                            <option value="">ジャンル</option>
                            {GENRE_PRESETS.map(g => <option key={g} value={g}>{g}</option>)}
                          </select>
                          <select
                            value={editBenchmark}
                            onChange={e => setEditBenchmark(e.target.value)}
                            className="text-[10px] px-1.5 py-0.5 rounded border outline-none"
                            style={{ background: 'rgba(15,23,42,0.6)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
                          >
                            <option value="">ベンチマーク</option>
                            {BENCHMARK_PRESETS.map(b => <option key={b} value={b}>{b}</option>)}
                          </select>
                          <select
                            value={editCategory}
                            onChange={e => setEditCategory(e.target.value)}
                            className="text-[10px] px-1.5 py-0.5 rounded border outline-none"
                            style={{ background: 'rgba(15,23,42,0.6)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
                          >
                            <option value="">カテゴリ</option>
                            {CATEGORY_PRESETS.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-0.5">
                          {cast.genre && (
                            <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap"
                              style={{ color: '#38bdf8', background: 'rgba(56,189,248,0.12)' }}>{cast.genre}</span>
                          )}
                          {cast.benchmark && (
                            <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap"
                              style={{ color: '#22c55e', background: 'rgba(34,197,94,0.12)' }}>{cast.benchmark}</span>
                          )}
                          {cast.category && (
                            <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap"
                              style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>{cast.category}</span>
                          )}
                          {!cast.genre && !cast.benchmark && !cast.category && (
                            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>-</span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Auto-monitor column */}
                    <td className="text-center px-3 py-3">
                      {editingId === cast.id ? (
                        <input
                          type="checkbox"
                          checked={editAutoMonitor}
                          onChange={e => setEditAutoMonitor(e.target.checked)}
                          className="w-4 h-4 rounded"
                        />
                      ) : (
                        <span className="text-[10px] font-semibold" style={{
                          color: cast.auto_monitor ? 'var(--accent-green)' : 'var(--text-muted)',
                        }}>
                          {cast.auto_monitor ? 'ON' : 'OFF'}
                        </span>
                      )}
                    </td>

                    {/* Screenshot interval column */}
                    <td className="text-center px-3 py-3">
                      {editingId === cast.id ? (
                        <select
                          value={editScreenshotInterval}
                          onChange={e => setEditScreenshotInterval(Number(e.target.value))}
                          className="text-[10px] px-1.5 py-0.5 rounded border outline-none"
                          style={{ background: 'rgba(15,23,42,0.6)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}
                        >
                          <option value={0}>OFF</option>
                          <option value={1}>1分</option>
                          <option value={3}>3分</option>
                          <option value={5}>5分</option>
                          <option value={10}>10分</option>
                          <option value={15}>15分</option>
                          <option value={30}>30分</option>
                        </select>
                      ) : (
                        <span className="text-[10px]" style={{
                          color: (cast.screenshot_interval ?? 0) > 0 ? 'var(--accent-green)' : 'var(--text-muted)',
                        }}>
                          {(cast.screenshot_interval ?? 0) > 0 ? `${cast.screenshot_interval}分` : 'OFF'}
                        </span>
                      )}
                    </td>

                    {/* Last seen online */}
                    <td className="px-3 py-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {cast.last_seen_online
                        ? new Date(cast.last_seen_online).toLocaleString('ja-JP', {
                            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
                          })
                        : '--'}
                    </td>

                    {/* Status column */}
                    <td className="text-center px-3 py-3">
                      <span
                        className="text-[9px] px-2 py-0.5 rounded font-semibold"
                        style={cast.is_active
                          ? { color: 'var(--accent-green)', background: 'rgba(34,197,94,0.1)' }
                          : { color: 'var(--accent-pink)', background: 'rgba(244,63,94,0.1)' }
                        }
                      >
                        {cast.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>

                    {/* Actions column */}
                    <td className="text-center px-3 py-3">
                      {editingId === cast.id ? (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => handleSaveEdit(cast.id)}
                            className="text-[10px] px-2 py-1 rounded-lg hover:bg-emerald-500/10 transition-all"
                            style={{ color: 'var(--accent-green)' }}
                          >
                            保存
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="text-[10px] px-2 py-1 rounded-lg hover:bg-white/5 transition-all"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => startEdit(cast)}
                            className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-[11px]"
                            style={{ color: 'var(--accent-primary)' }}
                          >
                            編集
                          </button>
                          {cast.is_active ? (
                            <button
                              onClick={() => handleDeactivate(cast.id, cast.cast_name)}
                              className="p-1.5 rounded-lg hover:bg-rose-500/10 transition-all text-[11px]"
                              style={{ color: 'var(--accent-pink)' }}
                            >
                              停止
                            </button>
                          ) : (
                            <button
                              onClick={() => handleReactivate(cast.id)}
                              className="p-1.5 rounded-lg hover:bg-emerald-500/10 transition-all text-[11px]"
                              style={{ color: 'var(--accent-green)' }}
                            >
                              復活
                            </button>
                          )}
                        </div>
                      )}
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
