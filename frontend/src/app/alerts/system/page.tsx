'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { timeAgo } from '@/lib/utils';

// ---------- 型定義 ----------
interface SystemAlert {
  id: number;
  alert_type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info';
type TypeFilter = 'all' | 'revenue_drop' | 'consecutive_loss' | 'spy_cast_decline' | 'market_trend_change';

const SEVERITY_LABELS: Record<string, string> = {
  critical: '重大',
  warning: '警告',
  info: '情報',
};
const SEVERITY_COLORS: Record<string, string> = {
  critical: 'text-rose-400',
  warning: 'text-amber-400',
  info: 'text-sky-400',
};
const SEVERITY_BG: Record<string, string> = {
  critical: 'bg-rose-500/10 border-rose-500/20',
  warning: 'bg-amber-500/10 border-amber-500/20',
  info: 'bg-sky-500/10 border-sky-500/20',
};
const TYPE_LABELS: Record<string, string> = {
  revenue_drop: '売上急落',
  consecutive_loss: '連続赤字',
  spy_cast_decline: '競合変動',
  market_trend_change: '市場トレンド',
};
const TYPE_ICONS: Record<string, string> = {
  revenue_drop: '📉',
  consecutive_loss: '🔴',
  spy_cast_decline: '👁',
  market_trend_change: '📊',
};

const PAGE_SIZE = 20;

export default function SystemAlertsPage() {
  const { user } = useAuth();
  const sbRef = useRef(createClient());
  const sb = sbRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);

  // Filters
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [readFilter, setReadFilter] = useState<'all' | 'unread' | 'read'>('all');

  // Stats
  const [unreadCount, setUnreadCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);

  // Account
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await sb.from('accounts').select('id').limit(1).single();
      if (data) setAccountId(data.id);
    })();
  }, [user, sb]);

  // Load alerts
  const loadAlerts = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);

    let query = sb
      .from('alerts')
      .select('*', { count: 'exact' })
      .eq('account_id', accountId);

    if (severityFilter !== 'all') query = query.eq('severity', severityFilter);
    if (typeFilter !== 'all') query = query.eq('alert_type', typeFilter);
    if (readFilter === 'unread') query = query.eq('is_read', false);
    else if (readFilter === 'read') query = query.eq('is_read', true);

    query = query
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    const { data, count } = await query;
    setAlerts((data as SystemAlert[]) ?? []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [sb, accountId, severityFilter, typeFilter, readFilter, page]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  // Load stats
  useEffect(() => {
    if (!accountId) return;
    (async () => {
      const [unreadRes, critRes] = await Promise.all([
        sb.from('alerts').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('is_read', false),
        sb.from('alerts').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('severity', 'critical').eq('is_read', false),
      ]);
      setUnreadCount(unreadRes.count ?? 0);
      setCriticalCount(critRes.count ?? 0);
    })();
  }, [sb, accountId, alerts]);

  // Realtime
  useEffect(() => {
    if (!accountId) return;
    const channel = sb
      .channel('alerts-system-page')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'alerts',
        filter: `account_id=eq.${accountId}`,
      }, () => { loadAlerts(); })
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, [sb, accountId, loadAlerts]);

  // Actions
  const markRead = async (alertId: number) => {
    await sb.from('alerts').update({ is_read: true }).eq('id', alertId);
    setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, is_read: true } : a)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    if (!accountId) return;
    await sb.from('alerts').update({ is_read: true }).eq('account_id', accountId).eq('is_read', false);
    loadAlerts();
    setUnreadCount(0);
    setCriticalCount(0);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
              システム通知
            </h1>
            {unreadCount > 0 && (
              <span className="bg-rose-500/20 text-rose-400 text-xs font-semibold px-2 py-0.5 rounded-full border border-rose-500/30">
                {unreadCount} 未読
              </span>
            )}
          </div>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            売上急落・連続赤字・競合変動・市場トレンドの自動検出アラート
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/alerts" className="text-sm px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors" style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-glass)' }}>
            VIPアラート
          </Link>
          {unreadCount > 0 && (
            <button onClick={markAllRead} className="btn-ghost text-sm px-3 py-1.5">
              全て既読にする
            </button>
          )}
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: '未読', value: unreadCount, color: 'var(--accent-primary)' },
          { label: '重大', value: criticalCount, color: '#f43f5e' },
          { label: '合計', value: total, color: 'var(--text-secondary)' },
          { label: '種類', value: `${new Set(alerts.map((a) => a.alert_type)).size}/4`, color: 'var(--accent-purple)' },
        ].map((s) => (
          <div key={s.label} className="glass-card px-4 py-3 text-center">
            <div className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Severity */}
        <div className="flex items-center gap-1">
          {(['all', 'critical', 'warning', 'info'] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setSeverityFilter(s); setPage(0); }}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${severityFilter === s ? 'bg-white/10 border-white/20' : 'border-transparent hover:bg-white/5'}`}
              style={{ color: s === 'all' ? 'var(--text-secondary)' : undefined }}
            >
              <span className={s !== 'all' ? SEVERITY_COLORS[s] : ''}>
                {s === 'all' ? '全重要度' : SEVERITY_LABELS[s]}
              </span>
            </button>
          ))}
        </div>

        <span className="w-px h-4" style={{ background: 'var(--border-glass)' }} />

        {/* Type */}
        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value as TypeFilter); setPage(0); }}
          className="input-glass text-xs px-2 py-1 rounded-md"
        >
          <option value="all">全種別</option>
          <option value="revenue_drop">売上急落</option>
          <option value="consecutive_loss">連続赤字</option>
          <option value="spy_cast_decline">競合変動</option>
          <option value="market_trend_change">市場トレンド</option>
        </select>

        {/* Read status */}
        <select
          value={readFilter}
          onChange={(e) => { setReadFilter(e.target.value as 'all' | 'unread' | 'read'); setPage(0); }}
          className="input-glass text-xs px-2 py-1 rounded-md"
        >
          <option value="all">全て</option>
          <option value="unread">未読のみ</option>
          <option value="read">既読のみ</option>
        </select>
      </div>

      {/* Alert list */}
      <div className="space-y-2">
        {loading ? (
          <div className="glass-card p-8 text-center">
            <div className="animate-spin w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full mx-auto" />
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
          </div>
        ) : alerts.length === 0 ? (
          <div className="glass-card p-12 text-center">
            <div className="text-4xl mb-3">🔔</div>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {severityFilter !== 'all' || typeFilter !== 'all' || readFilter !== 'all'
                ? 'フィルタ条件に一致するアラートはありません'
                : 'アラートはまだありません。Collectorが1時間ごとに自動評価します。'}
            </p>
          </div>
        ) : (
          alerts.map((alert) => (
            <div
              key={alert.id}
              className={`glass-card px-5 py-4 flex items-start gap-4 transition-colors ${!alert.is_read ? 'ring-1 ring-white/5' : 'opacity-80'}`}
            >
              {/* Icon */}
              <div className="text-xl flex-shrink-0 mt-0.5">{TYPE_ICONS[alert.alert_type] ?? '🔔'}</div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${SEVERITY_BG[alert.severity]} ${SEVERITY_COLORS[alert.severity]}`}>
                    {SEVERITY_LABELS[alert.severity]}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded border" style={{ borderColor: 'var(--border-glass)', color: 'var(--text-muted)' }}>
                    {TYPE_LABELS[alert.alert_type] ?? alert.alert_type}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {timeAgo(alert.created_at)}
                    {' '}
                    ({new Date(alert.created_at).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})
                  </span>
                  {!alert.is_read && <span className="w-2 h-2 rounded-full bg-sky-400 flex-shrink-0" />}
                </div>
                <p className="text-sm font-medium mt-1" style={{ color: 'var(--text-primary)' }}>{alert.title}</p>
                {alert.body && (
                  <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{alert.body}</p>
                )}

                {/* Metadata details */}
                {alert.metadata && Object.keys(alert.metadata).length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {alert.metadata.cast_name != null && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-glass)', color: 'var(--text-muted)' }}>
                        {String(alert.metadata.cast_name)}
                      </span>
                    )}
                    {alert.metadata.change_rate != null && (
                      <span className={`text-[11px] px-1.5 py-0.5 rounded ${Number(alert.metadata.change_rate) < 0 ? 'text-rose-400 bg-rose-500/10' : 'text-emerald-400 bg-emerald-500/10'}`}>
                        {Number(alert.metadata.change_rate) > 0 ? '+' : ''}{String(alert.metadata.change_rate)}%
                      </span>
                    )}
                    {alert.metadata.total_loss != null && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded text-rose-400 bg-rose-500/10">
                        {Number(alert.metadata.total_loss).toLocaleString()}円
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Action */}
              {!alert.is_read && (
                <button
                  onClick={() => markRead(alert.id)}
                  className="flex-shrink-0 text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                  title="既読にする"
                >
                  既読
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="btn-ghost text-xs px-3 py-1 disabled:opacity-30"
          >
            前へ
          </button>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="btn-ghost text-xs px-3 py-1 disabled:opacity-30"
          >
            次へ
          </button>
        </div>
      )}
    </div>
  );
}
