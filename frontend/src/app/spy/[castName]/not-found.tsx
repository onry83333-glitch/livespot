import Link from 'next/link';

export default function SpyCastNotFound() {
  return (
    <div className="flex items-center justify-center min-h-[60vh] px-4">
      <div className="glass-card p-8 max-w-md w-full text-center space-y-4">
        <div className="text-6xl font-bold" style={{ color: 'var(--accent-primary)' }}>404</div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          SPY対象キャストが見つかりません
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          指定されたキャストのSPYデータは存在しません。
        </p>
        <div className="pt-2">
          <Link href="/spy" className="btn-primary text-sm inline-block">SPY一覧へ戻る</Link>
        </div>
      </div>
    </div>
  );
}
