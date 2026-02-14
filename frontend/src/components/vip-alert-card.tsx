'use client';

import { cn, formatTokens, timeAgo, lifecycleColor } from '@/lib/utils';
import type { VIPAlert } from '@/types';

export function VIPAlertCard({ alert }: { alert: VIPAlert }) {
  const isWhale = alert.level === 'whale';

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-xl border vip-pulse',
        isWhale
          ? 'bg-amber-500/10 border-amber-500/30'
          : 'bg-orange-500/10 border-orange-500/30'
      )}
    >
      {/* Icon */}
      <span className="text-2xl">{isWhale ? '🐋' : '⭐'}</span>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm">{alert.user_name}</span>
          <span className={cn('px-1.5 py-0.5 rounded text-[10px] text-white', lifecycleColor(alert.lifecycle))}>
            {alert.lifecycle}
          </span>
          {alert.user_level > 0 && (
            <span className="text-xs text-slate-400">Lv.{alert.user_level}</span>
          )}
        </div>
        <p className="text-xs text-slate-400 truncate">
          {alert.alert_message}
        </p>
      </div>

      {/* Tokens */}
      <div className="text-right">
        <p className={cn('font-bold text-sm', isWhale ? 'text-amber-400' : 'text-orange-400')}>
          {formatTokens(alert.total_tokens)}
        </p>
        {alert.message_time && (
          <p className="text-[10px] text-slate-500">{timeAgo(alert.message_time)}</p>
        )}
      </div>
    </div>
  );
}
