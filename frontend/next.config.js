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
    ];
  },

  // セキュリティヘッダー
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
