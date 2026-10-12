import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// One .env at the repository root is shared by web, worker and CLIs.
loadEnvConfig(path.join(import.meta.dirname, '../..'), process.env.NODE_ENV !== 'production', undefined, true);

const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  // Next.js hydration requires inline scripts unless a nonce strategy is configured (see docs/security).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.paystack.com",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@thrift/application', '@thrift/contracts', '@thrift/database', '@thrift/domain', '@thrift/providers'],
  serverExternalPackages: ['pg', 'sharp'],
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  turbopack: {
    root: path.join(import.meta.dirname, '../..'),
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
          ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
        ],
      },
    ];
  },
};

export default nextConfig;
