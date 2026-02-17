'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, timeAgo } from '@/lib/utils';
import type { Account, RegisteredCast, SpyMessage } from '@/types';

interface CastWithStats extends RegisteredCast {
  total_messages: number;
  total_coins: number;
  unique_users: number;
  last_activity: string | null;
  tip_count: number;
}

export default function CastsPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [registeredCasts, setRegisteredCasts] = useState<RegisteredCast[]>([]);
  const [spyMessages, setSpyMessages] = useState<SpyMessage[]>([]);
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

  // registered_casts → そのcast_nameでspy_messagesをフィルタ取得
  useEffect(() => {
    if (!selectedAccount) return;
    setLoading(true);

    const supabase = createClient();

    // Step 1: registered_casts を取得
    supabase
      .from('registered_casts')
      .select('*')
      .eq('account_id', selectedAccount)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .then(async (castsRes) => {
        const casts = castsRes.data || [];
        setRegisteredCasts(casts);
        console.log('[Casts] registered_casts:', casts.length, castsRes.error?.message || 'OK');

        if (casts.length === 0) {
          setSpyMessages([]);
          setLoading(false);
          return;
        }

        // Step 2: registered cast_namesでspy_messagesをフィルタ取得
        const castNames = casts.map(c => c.cast_name);
        console.log('[Casts] fetching spy_messages for:', castNames);

        const { data: msgs, error: msgErr } = await supabase
          .from('spy_messages')
          .select('cast_name, message_time, msg_type, user_name, tokens')
          .eq('account_id', selectedAccount)
          .in('cast_name', castNames)
          .order('message_time', { ascending: false })
          .limit(10000);

        console.log('[Casts] spy_messages:', msgs?.length, msgErr?.message || 'OK');
        for (const cn of castNames) {
          const count = msgs?.filter(m => m.cast_name === cn).length || 0;
          console.log(`[Casts]   ${cn}: ${count} msgs`);
        }

        setSpyMessages((msgs || []) as SpyMessage[]);
        setLoading(false);
      });
  }, [selectedAccount]);

  // registered_casts + spy_messages を結合してstatsを計算
  const castsWithStats = useMemo((): CastWithStats[] => {
    return registeredCasts.map(cast => {
      const msgs = spyMessages.filter(m => m.cast_name === cast.cast_name);
      const tips = msgs.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift');
      const users = new Set(msgs.filter(m => m.user_name).map(m => m.user_name));
      return {
        ...cast,
        total_messages: msgs.length,
        total_coins: tips.reduce((s, m) => s + (m.tokens || 0), 0),
        unique_users: users.size,
        last_activity: msgs.length > 0 ? msgs[0].message_time : null,
        tip_count: tips.length,
      };
    });
  }, [registeredCasts, spyMessages]);

  // 全体統計
  const totals = useMemo(() => {
    return {
      casts: castsWithStats.length,
      messages: castsWithStats.reduce((s, c) => s + c.total_messages, 0),
      coins: castsWithStats.reduce((s, c) => s + c.total_coins, 0),
      users: castsWithStats.reduce((s, c) => s + c.unique_users, 0),
    };
  }, [castsWithStats]);

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
      if (error.code === '23505') {
        setFormError(`${name} は既に登録済みです`);
      } else {
        setFormError(error.message);
      }
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
        updated_at: new Date().toISOString(),
      })
      .eq('id', castId);

    if (error) return;

    setRegisteredCasts(prev =>
      prev.map(c => c.id === castId
        ? { ...c, display_name: editDisplayName.trim() || null, notes: editNotes.trim() || null }
        : c
      )
    );
    setEditingId(null);
  }, [editDisplayName, editNotes]);

  // キャスト非活性化（論理削除）
  const handleDeactivate = useCallback(async (castId: number, castName: string) => {
    if (!confirm(`${castName} を一覧から削除しますか？`)) return;

    const supabase = createClient();
    const { error } = await supabase
      .from('registered_casts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', castId);

    if (!error) {
      setRegisteredCasts(prev => prev.filter(c => c.id !== castId));
    }
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

          {/* Register button */}
          <button
            onClick={() => setShowForm(!showForm)}
            className="btn-primary text-xs py-1.5 px-4"
          >
            {showForm ? 'キャンセル' : '+ キャスト追加'}
          </button>
        </div>
      </div>

      {/* Registration Form (inline) */}
      {showForm && (
        <div className="glass-card p-5 anim-fade-up">
          <h3 className="text-sm font-bold mb-4">新規キャスト登録</h3>
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
                style={{ color: 'var(--text-muted)' }}>
                表示名
              </label>
              <input
                type="text"
                value={formDisplayName}
                onChange={e => setFormDisplayName(e.target.value)}
                className="input-glass text-xs w-full"
                placeholder="本名やニックネーム"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5"
                style={{ color: 'var(--text-muted)' }}>
                メモ
              </label>
              <input
                type="text"
                value={formNotes}
                onChange={e => setFormNotes(e.target.value)}
                className="input-glass text-xs w-full"
                placeholder="任意のメモ"
              />
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

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>
            {totals.casts}
          </p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>登録キャスト数</p>
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
                <th className="text-right px-4 py-3 font-semibold">メッセージ</th>
                <th className="text-right px-4 py-3 font-semibold">チップ数</th>
                <th className="text-right px-4 py-3 font-semibold">総コイン</th>
                <th className="text-right px-4 py-3 font-semibold">推定売上</th>
                <th className="text-right px-4 py-3 font-semibold">ユーザー</th>
                <th className="text-right px-4 py-3 font-semibold">最終活動</th>
                <th className="text-center px-3 py-3 font-semibold">操作</th>
              </tr>
            </thead>
            <tbody>
              {castsWithStats.map((cast, i) => (
                <tr key={cast.id}
                  className="text-xs hover:bg-white/[0.02] transition-colors"
                  style={{ borderBottom: '1px solid var(--border-glass)' }}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold w-6 text-center" style={{
                        color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)'
                      }}>
                        {i + 1}
                      </span>
                      {editingId === cast.id ? (
                        <div className="flex-1 min-w-0">
                          <span className="font-semibold">{cast.cast_name}</span>
                          <input
                            type="text"
                            value={editDisplayName}
                            onChange={e => setEditDisplayName(e.target.value)}
                            className="input-glass text-[11px] w-full mt-1 py-1 px-2"
                            placeholder="表示名"
                          />
                          <input
                            type="text"
                            value={editNotes}
                            onChange={e => setEditNotes(e.target.value)}
                            className="input-glass text-[11px] w-full mt-1 py-1 px-2"
                            placeholder="メモ"
                          />
                        </div>
                      ) : (
                        <div className="min-w-0">
                          <span className="font-semibold">{cast.cast_name}</span>
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
                  <td className="text-right px-4 py-3" style={{ color: 'var(--text-muted)' }}>
                    {cast.last_activity ? timeAgo(cast.last_activity) : '--'}
                  </td>
                  <td className="text-center px-3 py-3">
                    {editingId === cast.id ? (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleSaveEdit(cast.id)}
                          className="text-[10px] px-2 py-1 rounded-lg hover:bg-emerald-500/10 transition-all"
                          style={{ color: 'var(--accent-green)' }}
                          title="保存"
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
                          onClick={() => {
                            setEditingId(cast.id);
                            setEditDisplayName(cast.display_name || '');
                            setEditNotes(cast.notes || '');
                          }}
                          className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-[11px]"
                          title="編集"
                          style={{ color: 'var(--accent-primary)' }}
                        >
                          編集
                        </button>
                        <button
                          onClick={() => handleDeactivate(cast.id, cast.cast_name)}
                          className="p-1.5 rounded-lg hover:bg-rose-500/10 transition-all text-[11px]"
                          title="削除"
                          style={{ color: 'var(--accent-pink)' }}
                        >
                          削除
                        </button>
                      </div>
                    )}
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
