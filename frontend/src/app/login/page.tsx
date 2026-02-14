'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message === 'Invalid login credentials'
        ? 'メールアドレスまたはパスワードが正しくありません'
        : error.message);
      setLoading(false);
    }
    // 成功時は AuthProvider の onAuthStateChange がリダイレクト処理
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-mesh">
      <form onSubmit={handleLogin} className="glass-card p-8 w-full max-w-md anim-fade-up">
        {/* ロゴ */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center text-3xl"
            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))' }}>
            🌐
          </div>
          <h1 className="text-2xl font-bold">LiveSpot</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Premium Agency OS にログイン</p>
        </div>

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
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" disabled={loading} className="btn-primary w-full py-3 text-sm disabled:opacity-50">
            {loading ? '認証中...' : 'ログイン'}
          </button>
          <p className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            アカウントをお持ちでない方は{' '}
            <Link href="/signup" style={{ color: 'var(--accent-primary)' }} className="hover:underline">
              新規登録
            </Link>
          </p>
        </div>
      </form>
    </div>
  );
}
