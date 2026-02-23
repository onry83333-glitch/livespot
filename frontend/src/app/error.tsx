'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[SLS Error Boundary]', error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-[60vh] px-4">
      <div className="glass-card p-8 max-w-md w-full text-center space-y-4">
        <div className="text-4xl">⚠️</div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          問題が発生しました
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          予期しないエラーが発生しました。リロードして再度お試しください。
        </p>
        {process.env.NODE_ENV === 'development' && (
          <pre className="text-left text-[10px] font-mono p-3 rounded-lg overflow-auto max-h-32"
            style={{ background: 'rgba(244,63,94,0.08)', color: 'var(--accent-pink)' }}>
            {error.message}
          </pre>
        )}
        <div className="flex gap-3 justify-center pt-2">
          <button onClick={reset} className="btn-primary text-sm">
            リロード
          </button>
          <a href="/" className="btn-ghost text-sm inline-flex items-center">
            ダッシュボードへ
          </a>
        </div>
      </div>
    </div>
  );
}
