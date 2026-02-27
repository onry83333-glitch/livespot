/**
 * P0-3: 統一空データ表示コンポーネント
 */

import Link from 'next/link';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon = '📭',
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="text-center space-y-3 max-w-sm">
        <div className="text-4xl">{icon}</div>
        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        {description && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {description}
          </p>
        )}
        {actionLabel && actionHref && (
          <div className="pt-2">
            <Link href={actionHref} className="btn-primary text-sm inline-block">
              {actionLabel}
            </Link>
          </div>
        )}
        {actionLabel && onAction && !actionHref && (
          <div className="pt-2">
            <button onClick={onAction} className="btn-primary text-sm">
              {actionLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
