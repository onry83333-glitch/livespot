'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Sidebar } from '@/components/sidebar';
import { CoinSyncAlert } from '@/components/coin-sync-alert';
import { createClient } from '@/lib/supabase/client';
import { timeAgo } from '@/lib/utils';

const PUBLIC_PATHS = ['/login', '/signup'];

// ---------- Alert types ----------
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

// ---------- Bell + Dropdown ----------
function NotificationBell() {
  const { user } = useAuth();
  const router = useRouter();
  const sbRef = useRef(createClient());
  const sb = sbRef.current;
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [accountId, setAccountId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);

  // account取得
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await sb.from('accounts').select('id').limit(1).single();
      if (data) setAccountId(data.id);
    })();
  }, [user, sb]);

  // 未読カウント + 直近5件取得
  const loadAlerts = useCallback(async () => {
    if (!accountId) return;

    const [countRes, listRes] = await Promise.all([
      sb
        .from('alerts')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('is_read', false),
      sb
        .from('alerts')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    setUnreadCount(countRes.count ?? 0);
    setAlerts((listRes.data as SystemAlert[]) ?? []);
  }, [sb, accountId]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  // Realtime: 新着アラート
  useEffect(() => {
    if (!accountId) return;
    const channel = sb
      .channel('alerts-bell')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'alerts',
        filter: `account_id=eq.${accountId}`,
      }, (payload) => {
        const newAlert = payload.new as SystemAlert;
        setAlerts((prev) => [newAlert, ...prev].slice(0, 5));
        setUnreadCount((prev) => prev + 1);
      })
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, [sb, accountId]);

  // 既読処理
  const markRead = async (alertId: number) => {
    await sb.from('alerts').update({ is_read: true }).eq('id', alertId);
    setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, is_read: true } : a)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    if (!accountId) return;
    await sb.from('alerts').update({ is_read: true }).eq('account_id', accountId).eq('is_read', false);
    setAlerts((prev) => prev.map((a) => ({ ...a, is_read: true })));
    setUnreadCount(0);
  };

  // 外部クリックで閉じる
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <button
        onClick={() => { setOpen(!open); if (!open) loadAlerts(); }}
        className="relative p-2 rounded-lg hover:bg-white/5 transition-colors"
        title="通知"
      >
        <svg className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-rose-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[380px] rounded-xl border shadow-2xl z-50 overflow-hidden"
          style={{
            background: 'var(--bg-card)',
            borderColor: 'var(--border-glass)',
            backdropFilter: 'blur(24px)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-glass)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>通知</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="text-xs hover:underline"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  全て既読
                </button>
              )}
              <button
                onClick={() => { setOpen(false); router.push('/alerts/system'); }}
                className="text-xs hover:underline"
                style={{ color: 'var(--text-secondary)' }}
              >
                全て表示
              </button>
            </div>
          </div>

          {/* Alert list */}
          <div className="max-h-[400px] overflow-y-auto">
            {alerts.length === 0 ? (
              <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                通知はありません
              </div>
            ) : (
              alerts.map((alert) => (
                <button
                  key={alert.id}
                  onClick={() => { markRead(alert.id); setOpen(false); router.push('/alerts/system'); }}
                  className={`w-full text-left px-4 py-3 border-b transition-colors hover:bg-white/5 ${!alert.is_read ? 'bg-white/[0.02]' : ''}`}
                  style={{ borderColor: 'var(--border-glass)' }}
                >
                  <div className="flex items-start gap-3">
                    {/* Severity dot */}
                    <div className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                      alert.severity === 'critical' ? 'bg-rose-500' :
                      alert.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${SEVERITY_BG[alert.severity]} ${SEVERITY_COLORS[alert.severity]}`}>
                          {alert.severity === 'critical' ? '重大' : alert.severity === 'warning' ? '警告' : '情報'}
                        </span>
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{timeAgo(alert.created_at)}</span>
                        {!alert.is_read && <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />}
                      </div>
                      <p className="text-sm mt-1 truncate" style={{ color: 'var(--text-primary)' }}>{alert.title}</p>
                      {alert.body && (
                        <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{alert.body}</p>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- AppShell ----------
export function AppShell({ children }: { children: React.ReactNode }) {
  const { loading } = useAuth();
  const pathname = usePathname();
  const isPublic = PUBLIC_PATHS.includes(pathname);

  // ローディング中はスピナー表示
  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-mesh">
        <div className="flex flex-col items-center gap-4 anim-fade">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl animate-pulse"
            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))' }}
          >
            🌐
          </div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>読み込み中...</p>
        </div>
      </div>
    );
  }

  // publicページはサイドバーなし
  if (isPublic) {
    return <>{children}</>;
  }

  // 認証済みページはサイドバー + メインコンテンツ
  return (
    <>
      <Sidebar />
      <main className="flex-1 ml-[220px] overflow-auto">
        {/* Top bar with notification bell */}
        <div className="sticky top-0 z-40 flex items-center justify-end px-6 py-2 border-b" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-glass)' }}>
          <NotificationBell />
        </div>
        <CoinSyncAlert />
        <div className="p-6">
          {children}
        </div>
      </main>
    </>
  );
}
