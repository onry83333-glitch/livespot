'use client';

import { usePathname } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { Sidebar } from '@/components/sidebar';
import { CoinSyncAlert } from '@/components/coin-sync-alert';

const PUBLIC_PATHS = ['/login', '/signup'];

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
        <CoinSyncAlert />
        <div className="p-6">
          {children}
        </div>
      </main>
    </>
  );
}
