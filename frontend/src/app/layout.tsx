import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/auth-provider';
import { AppShell } from '@/components/app-shell';

export const metadata: Metadata = {
  title: 'Strip Live Spot - Premium Agency OS',
  description: 'ライブ配信エージェンシー管理プラットフォーム',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className="dark">
      <body className="bg-mesh min-h-screen flex">
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
