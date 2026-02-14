'use client';
import { useState } from 'react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-mesh">
      <div className="glass-card p-8 w-full max-w-md anim-fade-up">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center text-3xl"
            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))' }}>
            🌐
          </div>
          <h1 className="text-2xl font-bold">LiveSpot</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Premium Agency OS にログイン</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>メールアドレス</label>
            <input
              type="email"
              className="input-glass"
              placeholder="admin@livespot.jp"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>パスワード</label>
            <input
              type="password"
              className="input-glass"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          <button className="btn-primary w-full py-3 text-sm">ログイン</button>
          <p className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            アカウントをお持ちでない方は <span style={{ color: 'var(--accent-primary)' }} className="cursor-pointer">新規登録</span>
          </p>
        </div>
      </div>
    </div>
  );
}
