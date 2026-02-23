'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[SLS Global Error]', error);
  }, [error]);

  return (
    <html lang="ja" className="dark">
      <body style={{
        fontFamily: 'Outfit, sans-serif',
        background: '#030712',
        color: '#f1f5f9',
        margin: 0,
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{
          background: 'rgba(15,23,42,0.6)',
          border: '1px solid rgba(56,189,248,0.08)',
          borderRadius: '16px',
          padding: '32px',
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>💥</div>
          <h2 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>
            致命的なエラーが発生しました
          </h2>
          <p style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '24px' }}>
            アプリケーション全体でエラーが発生しました。ページをリロードしてください。
          </p>
          <button
            onClick={reset}
            style={{
              background: 'linear-gradient(135deg, #38bdf8, #0ea5e9)',
              color: 'white',
              border: 'none',
              borderRadius: '12px',
              padding: '10px 24px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            リロード
          </button>
        </div>
      </body>
    </html>
  );
}
