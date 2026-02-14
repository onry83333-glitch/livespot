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
