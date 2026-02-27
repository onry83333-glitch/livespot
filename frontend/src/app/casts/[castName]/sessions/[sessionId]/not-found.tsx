import Link from 'next/link';

export default function SessionNotFound() {
  return (
    <div className="flex items-center justify-center min-h-[60vh] px-4">
      <div className="glass-card p-8 max-w-md w-full text-center space-y-4">
        <div className="text-6xl font-bold" style={{ color: 'var(--accent-primary)' }}>404</div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          セッションが見つかりません
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          指定された配信セッションは存在しないか、削除された可能性があります。
        </p>
        <div className="pt-2">
          <Link href="/casts" className="btn-primary text-sm inline-block">キャスト一覧へ戻る</Link>
        </div>
      </div>
    </div>
  );
}
