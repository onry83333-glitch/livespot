/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Supabase Storage の画像ドメイン
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'ujgbhkllfeacbgpdbjto.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },

  // 旧ルート → 新ルートへのリダイレクト（サブタブ統合に伴う廃止ページ）
  async redirects() {
    return [
      { source: '/dm', destination: '/casts', permanent: true },
      { source: '/analytics', destination: '/casts', permanent: true },
      { source: '/analytics/compare', destination: '/casts', permanent: true },
      { source: '/users', destination: '/casts', permanent: true },
      { source: '/users/:username', destination: '/casts', permanent: true },
      { source: '/settings', destination: '/casts', permanent: true },
      { source: '/settings/casts', destination: '/admin/casts', permanent: true },
      { source: '/sessions', destination: '/casts', permanent: true },
      { source: '/dashboard', destination: '/casts', permanent: true },
    ];
  },

  // セキュリティヘッダー
  async headers() {
    return [
      // /embed/* 以外: 従来通り iframe 埋め込み禁止
      // 負の先読みで /embed 配下を除外（path-to-regexp）
      {
        source: '/((?!embed/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      // /embed/* : Notion からの iframe 埋め込みを許可
      // X-Frame-Options は付与せず、frame-ancestors で self + notion.so/notion.site のみ許可
      {
        source: '/embed/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://*.notion.so https://*.notion.site;",
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
