import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';

export const metadata: Metadata = {
  title: 'LiveSpot - Premium Agency OS',
  description: 'ライブ配信エージェンシー管理プラットフォーム',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className="dark">
      <body className="bg-mesh min-h-screen flex">
        <Sidebar />
        <main className="flex-1 ml-[220px] p-6 overflow-auto">
          {children}
        </main>
      </body>
    </html>
  );
}
