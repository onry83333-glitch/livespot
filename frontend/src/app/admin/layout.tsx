'use client';

import { useAuth } from '@/components/auth-provider';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: '#080a10', color: '#7e8aa2',
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}>
        Wisteria OS を読み込み中...
      </div>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}
