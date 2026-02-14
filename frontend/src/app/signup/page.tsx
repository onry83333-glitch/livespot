'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('パスワードが一致しません');
      return;
    }
    if (password.length < 6) {
      setError('パスワードは6文字以上で入力してください');
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSent(true);
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-mesh">
      <div className="glass-card p-8 w-full max-w-md anim-fade-up">
        {/* ロゴ */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center text-3xl"
            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))' }}>
            🌐
          </div>
          <h1 className="text-2xl font-bold">LiveSpot</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>新規アカウント作成</p>
        </div>

        {/* 確認メール送信後の表示 */}
        {sent ? (
          <div className="text-center space-y-4 anim-fade">
            <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center text-2xl"
              style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.2)' }}>
              ✉️
            </div>
            <div>
              <p className="font-semibold text-sm">確認メールを送信しました</p>
              <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
                <span style={{ color: 'var(--accent-primary)' }}>{email}</span> に確認リンクを送信しました。
                メール内のリンクをクリックしてアカウントを有効化してください。
              </p>
            </div>
            <Link href="/login" className="btn-ghost inline-block mt-4">
              ログイン画面に戻る
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSignup}>
            {/* エラー表示 */}
            {error && (
              <div className="mb-4 px-4 py-3 rounded-xl text-sm border"
                style={{
                  background: 'rgba(244, 63, 94, 0.08)',
                  borderColor: 'rgba(244, 63, 94, 0.2)',
                  color: 'var(--accent-pink)',
                }}>
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>
                  メールアドレス
                </label>
                <input
                  type="email"
                  required
                  className="input-glass"
                  placeholder="admin@livespot.jp"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>
                  パスワード
                </label>
                <input
                  type="password"
                  required
                  className="input-glass"
                  placeholder="6文字以上"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>
                  パスワード（確認）
                </label>
                <input
                  type="password"
                  required
                  className="input-glass"
                  placeholder="もう一度入力"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                />
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full py-3 text-sm disabled:opacity-50">
                {loading ? '作成中...' : 'アカウントを作成'}
              </button>
              <p className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                すでにアカウントをお持ちの方は{' '}
                <Link href="/login" style={{ color: 'var(--accent-primary)' }} className="hover:underline">
                  ログイン
                </Link>
              </p>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
