'use client';

export default function AnalysisPage() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-deep)' }}>
      <div className="text-center glass-card p-10">
        <h1 className="text-2xl font-bold mb-4" style={{ color: 'var(--text-primary)' }}>📊 競合分析ダッシュボード</h1>
        <p style={{ color: 'var(--text-secondary)' }}>SPYデータを蓄積中です。しばらくお待ちください。</p>
        <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>配信データが十分に蓄積されると競合分析が利用可能になります。</p>
      </div>
    </div>
  );
}
