'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth-provider';
import type { Account } from '@/types';

export default function NewCastPage() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sbRef = useRef(createClient());

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState(searchParams.get('account') || '');

  // フォーム
  const [castName, setCastName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [platform, setPlatform] = useState('stripchat');
  const [stripchatModelId, setStripchatModelId] = useState('');
  const [revenueShareRate, setRevenueShareRate] = useState('50');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // アカウント取得
  useEffect(() => {
    if (!user) return;
    sbRef.current.from('accounts').select('*').then(({ data }) => {
      if (data && data.length > 0) {
        setAccounts(data);
        if (!selectedAccount) setSelectedAccount(data[0].id);
      }
    });
  }, [user, selectedAccount]);

  // 登録処理
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = castName.trim();
    if (!name) { setError('キャスト名は必須です'); return; }
    if (!selectedAccount) { setError('アカウントを選択してください'); return; }

    setSaving(true);
    setError(null);
    const sb = sbRef.current;

    // 重複チェック
    const { data: existing } = await sb
      .from('registered_casts')
      .select('id, is_active')
      .eq('account_id', selectedAccount)
      .eq('cast_name', name)
      .maybeSingle();

    if (existing) {
      if (existing.is_active) {
        setError(`${name} は既に登録済みです`);
        setSaving(false);
        return;
      }
      // 無効化されたキャストを復活
      const { error: reactivateErr } = await sb
        .from('registered_casts')
        .update({
          is_active: true,
          display_name: displayName.trim() || null,
          platform: platform || null,
          stripchat_model_id: stripchatModelId.trim() || null,
          stripchat_url: platform === 'stripchat' ? `https://stripchat.com/${name}` : null,
          notes: notes.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (reactivateErr) { setError(reactivateErr.message); setSaving(false); return; }
    } else {
      // 新規INSERT
      const { error: insertErr } = await sb
        .from('registered_casts')
        .insert({
          account_id: selectedAccount,
          cast_name: name,
          display_name: displayName.trim() || null,
          platform: platform || null,
          stripchat_model_id: stripchatModelId.trim() || null,
          stripchat_url: platform === 'stripchat' ? `https://stripchat.com/${name}` : null,
          notes: notes.trim() || null,
        });

      if (insertErr) {
        setError(insertErr.code === '23505' ? `${name} は既に登録済みです` : insertErr.message);
        setSaving(false);
        return;
      }
    }

    // コスト設定（分配率）
    const rate = parseFloat(revenueShareRate);
    if (!isNaN(rate)) {
      await sb.from('cast_cost_settings')
        .upsert({
          account_id: selectedAccount,
          cast_name: name,
          revenue_share_rate: rate,
          effective_from: new Date().toISOString().slice(0, 10),
        }, { onConflict: 'account_id,cast_name,effective_from' });
    }

    setSaving(false);
    router.push('/admin/casts');
  };

  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6 anim-fade-up">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/admin/casts"
          className="text-sm hover:opacity-80 transition-opacity" style={{ color: 'var(--text-muted)' }}>
          ← 戻る
        </Link>
        <div>
          <h1 className="text-xl font-bold">新規キャスト登録</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            必須項目はキャスト名のみ
          </p>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
        {/* アカウント選択 */}
        {accounts.length > 1 && (
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              アカウント
            </label>
            <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)}
              className="input-glass text-xs py-2 px-3 w-full">
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.account_name}</option>
              ))}
            </select>
          </div>
        )}

        {/* キャスト名 (必須) */}
        <div>
          <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            キャスト名 <span style={{ color: 'var(--accent-pink)' }}>*</span>
          </label>
          <input value={castName} onChange={e => setCastName(e.target.value)}
            className="input-glass text-sm py-2.5 px-3 w-full"
            placeholder="Stripchatのユーザー名（例: hanachan_01）"
            required autoFocus />
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
            Stripchatプロフィール URL と一致する名前を入力
          </p>
        </div>

        {/* 表示名 */}
        <div>
          <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            表示名
          </label>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)}
            className="input-glass text-sm py-2.5 px-3 w-full"
            placeholder="例: はなちゃん" />
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
            UI上に表示する日本語名（空欄ならキャスト名を表示）
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* プラットフォーム */}
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              プラットフォーム
            </label>
            <select value={platform} onChange={e => setPlatform(e.target.value)}
              className="input-glass text-sm py-2.5 px-3 w-full">
              <option value="stripchat">Stripchat</option>
              <option value="chaturbate">Chaturbate</option>
              <option value="other">その他</option>
            </select>
          </div>

          {/* Stripchat モデルID */}
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              StripchatモデルID
            </label>
            <input value={stripchatModelId} onChange={e => setStripchatModelId(e.target.value)}
              className="input-glass text-sm py-2.5 px-3 w-full"
              placeholder="数字またはID文字列" />
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              API連携に使用（後から設定可）
            </p>
          </div>
        </div>

        {/* 分配率 */}
        <div>
          <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            レベニューシェア分配率 (%)
          </label>
          <div className="flex items-center gap-2">
            <input type="number" min="0" max="100" step="0.1"
              value={revenueShareRate} onChange={e => setRevenueShareRate(e.target.value)}
              className="input-glass text-sm py-2.5 px-3 w-32" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>%</span>
          </div>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
            ネット売上に対するキャストへの分配率（デフォルト50%）
          </p>
        </div>

        {/* メモ */}
        <div>
          <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            メモ
          </label>
          <input value={notes} onChange={e => setNotes(e.target.value)}
            className="input-glass text-sm py-2.5 px-3 w-full"
            placeholder="自由メモ（任意）" />
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg px-4 py-2.5 text-xs font-semibold"
            style={{ background: 'rgba(244,63,94,0.1)', color: 'var(--accent-pink)', border: '1px solid rgba(244,63,94,0.2)' }}>
            {error}
          </div>
        )}

        {/* Submit */}
        <div className="flex gap-3 pt-2">
          <button type="submit" disabled={saving || !castName.trim()}
            className="btn-primary text-sm py-2.5 px-8">
            {saving ? '登録中...' : 'キャストを登録'}
          </button>
          <Link href="/admin/casts" className="btn-ghost text-sm py-2.5 px-6">
            キャンセル
          </Link>
        </div>
      </form>
    </div>
  );
}
