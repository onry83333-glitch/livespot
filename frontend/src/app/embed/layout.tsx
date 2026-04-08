import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SLS Embed',
  robots: { index: false, follow: false },
};

/**
 * /embed/* 配下用レイアウト。Notion 埋め込みを想定し、
 * 背景を透過にしてホスト側（Notion ダークモード）に馴染ませる。
 * 認証 / サイドバー / トップバーは AppShell 側で /embed/* を検知して抑止済み。
 */
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: 'transparent',
        // スクロールをホスト（Notion iframe）に委ねず自身で持つ
        overflowX: 'hidden',
      }}
    >
      {children}
    </div>
  );
}
