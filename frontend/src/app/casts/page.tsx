'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, timeAgo } from '@/lib/utils';
import type { Account, RegisteredCast } from '@/types';

/** 今週の月曜00:00（JST）をUTCで返す。offset=1で前週月曜。 */
function getWeekStartJST(offset = 0): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(jst);
  monday.setUTCDate(jst.getUTCDate() - diff - offset * 7);
  monday.setUTCHours(0, 0, 0, 0);
  return new Date(monday.getTime() - 9 * 60 * 60 * 1000);
}

interface CastStats {
  cast_name: string;
  total_messages: number;
  total_tips: number;
  total_coins: number;
  unique_users: number;
  last_activity: string | null;
}

interface WeeklyCoinStats {
  cast_name: string;
  this_week: number;
  last_week: number;
}

interface CastWithStats extends RegisteredCast {
  total_messages: number;
  this_week_coins: number;
  last_week_coins: number;
  last_activity: string | null;
  tip_count: number;
}

export default function CastsPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [registeredCasts, setRegisteredCasts] = useState<RegisteredCast[]>([]);
  const [castStats, setCastStats] = useState<CastStats[]>([]);
  const [weeklyStats, setWeeklyStats] = useState<WeeklyCoinStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [coinRate] = useState(7.7);

  // 登録フォーム state
  const [showForm, setShowForm] = useState(false);
  const [formCastName, setFormCastName] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 編集モード
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editGenre, setEditGenre] = useState('');
  const [editBenchmark, setEditBenchmark] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editScreenshotInterval, setEditScreenshotInterval] = useState(5);

  // Tag presets
  const GENRE_PRESETS = ['女性単体', '絡み配信', 'カップル', 'レズ', '3P+', '男性単体'];
  const BENCHMARK_PRESETS = ['新人', '中堅', 'ランカー', 'ベテラン'];
  const CATEGORY_PRESETS = ['人妻', '女子大生', 'ギャル', 'お姉さん', '清楚系', '熟女', 'コスプレ', 'その他'];

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

  // registered_casts → RPC get_cast_stats で集計取得
  useEffect(() => {
    if (!selectedAccount) return;
    setLoading(true);

    const supabase = createClient();
    supabase
      .from('registered_casts')
      .select('*')
      .eq('account_id', selectedAccount)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .then(async (castsRes) => {
        const casts = castsRes.data || [];
        setRegisteredCasts(casts);

        if (casts.length === 0) {
          setCastStats([]);
          setLoading(false);
          return;
        }

        const castNames = casts.map(c => c.cast_name);

        // SPYデータ（メッセージ数、チップ数、最終活動）
        const { data: stats } = await supabase.rpc('get_cast_stats', {
          p_account_id: selectedAccount,
          p_cast_names: castNames,
        });
        setCastStats((stats || []) as CastStats[]);

        // coin_transactionsから今週・前週のコイン集計（JST暦週: 月曜〜日曜）
        const thisWeekStart = getWeekStartJST(0); // 今週月曜 00:00 JST
        const lastWeekStart = getWeekStartJST(1); // 前週月曜 00:00 JST

        const { data: coinRows } = await supabase
          .from('coin_transactions')
          .select('cast_name, tokens, date')
          .eq('account_id', selectedAccount)
          .in('cast_name', castNames)
          .gte('date', lastWeekStart.toISOString());

        const weeklyMap = new Map<string, { this_week: number; last_week: number }>();
        (coinRows || []).forEach((row: { cast_name: string; tokens: number; date: string }) => {
          const prev = weeklyMap.get(row.cast_name) || { this_week: 0, last_week: 0 };
          const rowDate = new Date(row.date);
          if (rowDate >= thisWeekStart) {
            prev.this_week += row.tokens || 0;
          } else {
            prev.last_week += row.tokens || 0;
          }
          weeklyMap.set(row.cast_name, prev);
        });
        const weeklyArr: WeeklyCoinStats[] = Array.from(weeklyMap.entries()).map(([cast_name, v]) => ({
          cast_name, ...v,
        }));
        setWeeklyStats(weeklyArr);

        setLoading(false);
      });
  }, [selectedAccount]);

  // registered_casts + SPY stats + weekly coin stats を結合
  const castsWithStats = useMemo((): CastWithStats[] => {
    return registeredCasts.map(cast => {
      const spy = castStats.find(s => s.cast_name === cast.cast_name);
      const weekly = weeklyStats.find(s => s.cast_name === cast.cast_name);
      return {
        ...cast,
        total_messages: spy?.total_messages || 0,
        this_week_coins: weekly?.this_week || 0,
        last_week_coins: weekly?.last_week || 0,
        last_activity: spy?.last_activity || null,
        tip_count: spy?.total_tips || 0,
      };
    });
  }, [registeredCasts, castStats, weeklyStats]);

  // 全体統計
  const totals = useMemo(() => ({
    casts: castsWithStats.length,
    thisWeekCoins: castsWithStats.reduce((s, c) => s + c.this_week_coins, 0),
    lastWeekCoins: castsWithStats.reduce((s, c) => s + c.last_week_coins, 0),
  }), [castsWithStats]);

  // キャスト登録
  const handleRegister = useCallback(async () => {
    const name = formCastName.trim();
    if (!name || !selectedAccount) return;
    setFormSaving(true);
    setFormError(null);

    const supabase = createClient();
    const { data, error } = await supabase
      .from('registered_casts')
      .insert({
        account_id: selectedAccount,
        cast_name: name,
        display_name: formDisplayName.trim() || null,
        stripchat_url: `https://stripchat.com/${name}`,
        notes: formNotes.trim() || null,
      })
      .select()
      .single();

    if (error) {
      setFormError(error.code === '23505' ? `${name} は既に登録済みです` : error.message);
      setFormSaving(false);
      return;
    }

    setRegisteredCasts(prev => [...prev, data as RegisteredCast]);
    setFormCastName('');
    setFormDisplayName('');
    setFormNotes('');
    setShowForm(false);
    setFormSaving(false);
  }, [formCastName, formDisplayName, formNotes, selectedAccount]);

  // キャスト編集保存
  const handleSaveEdit = useCallback(async (castId: number) => {
    const supabase = createClient();
    const { error } = await supabase
      .from('registered_casts')
      .update({
        display_name: editDisplayName.trim() || null,
        notes: editNotes.trim() || null,
        genre: editGenre || null,
        benchmark: editBenchmark || null,
        category: editCategory || null,
        screenshot_interval: editScreenshotInterval,
        updated_at: new Date().toISOString(),
      })
      .eq('id', castId);

    if (error) return;
    setRegisteredCasts(prev =>
      prev.map(c => c.id === castId
        ? { ...c, display_name: editDisplayName.trim() || null, notes: editNotes.trim() || null, genre: editGenre || null, benchmark: editBenchmark || null, category: editCategory || null, screenshot_interval: editScreenshotInterval }
        : c
      )
    );
    setEditingId(null);
  }, [editDisplayName, editNotes, editGenre, editBenchmark, editCategory, editScreenshotInterval]);

  // キャスト非活性化
  const handleDeactivate = useCallback(async (castId: number, castName: string) => {
    if (!confirm(`${castName} を一覧から削除しますか？`)) return;
    const supabase = createClient();
    const { error } = await supabase
      .from('registered_casts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', castId);
    if (!error) setRegisteredCasts(prev => prev.filter(c => c.id !== castId));
  }, []);

  if (!user) return null;

  return (
    <div className="space-y-6 anim-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">自社キャスト管理</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            登録済みキャストの配信データと売上サマリー
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
          <button onClick={() => setShowForm(!showForm)} className="btn-primary text-xs py-1.5 px-4">
            {showForm ? 'キャンセル' : '+ キャスト追加'}
          </button>
        </div>
      </div>

      {/* Registration Form */}
      {showForm && (
        <div className="glass-card p-5 anim-fade-up">
          <h3 className="text-sm font-bold mb-4">新規キャスト登録</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>
                キャスト名 <span style={{ color: 'var(--accent-pink)' }}>*</span>
              </label>
              <input type="text" value={formCastName} onChange={e => setFormCastName(e.target.value)}
                className="input-glass text-xs w-full" placeholder="Stripchatのユーザー名"
                onKeyDown={e => e.key === 'Enter' && handleRegister()} />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>表示名</label>
              <input type="text" value={formDisplayName} onChange={e => setFormDisplayName(e.target.value)}
                className="input-glass text-xs w-full" placeholder="本名やニックネーム" />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>メモ</label>
              <input type="text" value={formNotes} onChange={e => setFormNotes(e.target.value)}
                className="input-glass text-xs w-full" placeholder="任意のメモ" />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button onClick={handleRegister} disabled={!formCastName.trim() || formSaving}
              className="btn-primary text-xs py-1.5 px-6 disabled:opacity-50">
              {formSaving ? '登録中...' : '登録する'}
            </button>
            {formError && <span className="text-xs" style={{ color: 'var(--accent-pink)' }}>{formError}</span>}
          </div>
        </div>
      )}

      {/* Summary Cards */}
      {(() => {
        const weekDiff = totals.lastWeekCoins > 0
          ? ((totals.thisWeekCoins - totals.lastWeekCoins) / totals.lastWeekCoins * 100)
          : totals.thisWeekCoins > 0 ? 100 : 0;
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>{totals.casts}</p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>登録キャスト数</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(totals.thisWeekCoins)}</p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週のコイン</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(totals.thisWeekCoins, coinRate)}</p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週の推定売上</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-2xl font-bold" style={{
                color: weekDiff > 0 ? 'var(--accent-green)' : weekDiff < 0 ? 'var(--accent-pink)' : 'var(--text-secondary)'
              }}>
                {weekDiff > 0 ? '▲' : weekDiff < 0 ? '▼' : '→'}{Math.abs(weekDiff).toFixed(0)}%
              </p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>前週比</p>
            </div>
          </div>
        );
      })()}

      {/* Cast List */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">読み込み中...</p>
          </div>
        ) : castsWithStats.length === 0 ? (
          <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">登録済みキャストがいません</p>
            <p className="text-xs mt-2">「+ キャスト追加」ボタンからキャストを登録してください</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider"
                style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}>
                <th className="text-left px-5 py-3 font-semibold">キャスト</th>
                <th className="text-left px-3 py-3 font-semibold">タグ</th>
                <th className="text-right px-4 py-3 font-semibold">今週コイン</th>
                <th className="text-right px-4 py-3 font-semibold">今週売上</th>
                <th className="text-right px-4 py-3 font-semibold">前週コイン</th>
                <th className="text-right px-4 py-3 font-semibold">前週比</th>
                <th className="text-right px-4 py-3 font-semibold">最終活動</th>
                <th className="text-center px-3 py-3 font-semibold">📸</th>
                <th className="text-center px-3 py-3 font-semibold">操作</th>
              </tr>
            </thead>
            <tbody>
              {castsWithStats.map((cast, i) => {
                const diff = cast.last_week_coins > 0
                  ? ((cast.this_week_coins - cast.last_week_coins) / cast.last_week_coins * 100)
                  : cast.this_week_coins > 0 ? 100 : 0;
                return (
                  <tr key={cast.id}
                    className="text-xs hover:bg-white/[0.02] transition-colors"
                    style={{ borderBottom: '1px solid var(--border-glass)' }}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold w-6 text-center" style={{
                          color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)'
                        }}>{i + 1}</span>
                        {editingId === cast.id ? (
                          <div className="flex-1 min-w-0">
                            <span className="font-semibold">{cast.cast_name}</span>
                            <input type="text" value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)}
                              className="input-glass text-[11px] w-full mt-1 py-1 px-2" placeholder="表示名" />
                            <input type="text" value={editNotes} onChange={e => setEditNotes(e.target.value)}
                              className="input-glass text-[11px] w-full mt-1 py-1 px-2" placeholder="メモ" />
                          </div>
                        ) : (
                          <Link href={`/casts/${encodeURIComponent(cast.cast_name)}`}
                            className="min-w-0 hover:opacity-80 transition-opacity">
                            <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>{cast.cast_name}</span>
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
                          </Link>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {editingId === cast.id ? (
                        <div className="flex flex-col gap-1">
                          <select value={editGenre} onChange={e => setEditGenre(e.target.value)}
                            className="text-[10px] px-1.5 py-0.5 rounded border outline-none"
                            style={{ background: 'rgba(15,23,42,0.6)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
                            <option value="">ジャンル</option>
                            {GENRE_PRESETS.map(g => <option key={g} value={g}>{g}</option>)}
                          </select>
                          <select value={editBenchmark} onChange={e => setEditBenchmark(e.target.value)}
                            className="text-[10px] px-1.5 py-0.5 rounded border outline-none"
                            style={{ background: 'rgba(15,23,42,0.6)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
                            <option value="">ベンチマーク</option>
                            {BENCHMARK_PRESETS.map(b => <option key={b} value={b}>{b}</option>)}
                          </select>
                          <select value={editCategory} onChange={e => setEditCategory(e.target.value)}
                            className="text-[10px] px-1.5 py-0.5 rounded border outline-none"
                            style={{ background: 'rgba(15,23,42,0.6)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
                            <option value="">カテゴリ</option>
                            {CATEGORY_PRESETS.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-0.5">
                          {cast.genre && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap" style={{ color: '#38bdf8', background: 'rgba(56,189,248,0.12)' }}>{cast.genre}</span>}
                          {cast.benchmark && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap" style={{ color: '#22c55e', background: 'rgba(34,197,94,0.12)' }}>{cast.benchmark}</span>}
                          {cast.category && <span className="text-[8px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>{cast.category}</span>}
                          {!cast.genre && !cast.benchmark && !cast.category && <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>-</span>}
                        </div>
                      )}
                    </td>
                    <td className="text-right px-4 py-3 font-semibold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                      {formatTokens(cast.this_week_coins)}
                    </td>
                    <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--accent-green)' }}>
                      {tokensToJPY(cast.this_week_coins, coinRate)}
                    </td>
                    <td className="text-right px-4 py-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      {formatTokens(cast.last_week_coins)}
                    </td>
                    <td className="text-right px-4 py-3 font-semibold tabular-nums" style={{
                      color: diff > 0 ? 'var(--accent-green)' : diff < 0 ? 'var(--accent-pink)' : 'var(--text-muted)'
                    }}>
                      {diff > 0 ? '▲' : diff < 0 ? '▼' : '→'}{Math.abs(diff).toFixed(0)}%
                    </td>
                    <td className="text-right px-4 py-3" style={{ color: 'var(--text-muted)' }}>
                      {cast.last_activity ? timeAgo(cast.last_activity) : '--'}
                    </td>
                    <td className="text-center px-3 py-3">
                      {editingId === cast.id ? (
                        <select value={editScreenshotInterval} onChange={e => setEditScreenshotInterval(Number(e.target.value))}
                          className="text-[10px] px-1.5 py-0.5 rounded border outline-none"
                          style={{ background: 'rgba(15,23,42,0.6)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
                          <option value={0}>OFF</option>
                          <option value={1}>1分</option>
                          <option value={3}>3分</option>
                          <option value={5}>5分</option>
                          <option value={10}>10分</option>
                          <option value={15}>15分</option>
                          <option value={30}>30分</option>
                        </select>
                      ) : (
                        <span className="text-[10px]" style={{ color: (cast.screenshot_interval ?? 5) > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                          {(cast.screenshot_interval ?? 5) > 0 ? `${cast.screenshot_interval ?? 5}分` : 'OFF'}
                        </span>
                      )}
                    </td>
                    <td className="text-center px-3 py-3">
                      {editingId === cast.id ? (
                        <div className="flex items-center justify-center gap-1">
                          <button onClick={() => handleSaveEdit(cast.id)}
                            className="text-[10px] px-2 py-1 rounded-lg hover:bg-emerald-500/10 transition-all"
                            style={{ color: 'var(--accent-green)' }}>保存</button>
                          <button onClick={() => setEditingId(null)}
                            className="text-[10px] px-2 py-1 rounded-lg hover:bg-white/5 transition-all"
                            style={{ color: 'var(--text-muted)' }}>取消</button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1">
                          <button onClick={() => { setEditingId(cast.id); setEditDisplayName(cast.display_name || ''); setEditNotes(cast.notes || ''); setEditGenre(cast.genre || ''); setEditBenchmark(cast.benchmark || ''); setEditCategory(cast.category || ''); setEditScreenshotInterval(cast.screenshot_interval ?? 5); }}
                            className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-[11px]"
                            style={{ color: 'var(--accent-primary)' }}>編集</button>
                          <button onClick={() => handleDeactivate(cast.id, cast.cast_name)}
                            className="p-1.5 rounded-lg hover:bg-rose-500/10 transition-all text-[11px]"
                            style={{ color: 'var(--accent-pink)' }}>削除</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
