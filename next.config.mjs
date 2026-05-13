/** @type {import('next').NextConfig} */
const nextConfig = {
  // Compress les réponses
  compress: true,
  // Headers de cache pour les assets statiques
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
