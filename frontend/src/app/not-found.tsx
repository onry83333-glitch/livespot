import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-[60vh] px-4">
      <div className="glass-card p-8 max-w-md w-full text-center space-y-4">
        <div className="text-6xl font-bold" style={{ color: 'var(--accent-primary)' }}>
          404
        </div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          ページが見つかりません
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          お探しのページは存在しないか、移動された可能性があります。
        </p>
        <div className="pt-2">
          <Link href="/" className="btn-primary text-sm inline-block">
            ダッシュボードへ戻る
          </Link>
        </div>
      </div>
    </div>
  );
}
