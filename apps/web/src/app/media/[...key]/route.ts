import type { NextRequest } from 'next/server';
import { resolveMediaRequest } from '@thrift/application';
import { services } from '@/server/services';

/** Serves stored media. Restricted media (evidence, chat photos) requires a valid short-lived signature. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const storageKey = key.join('/');
  if (!/^[a-zA-Z0-9/_.-]+$/.test(storageKey) || storageKey.includes('..')) return new Response('Not found', { status: 404 });
  const ctx = services().context({ kind: 'guest' });
  const result = await resolveMediaRequest(ctx, {
    key: storageKey,
    exp: req.nextUrl.searchParams.get('exp'),
    sig: req.nextUrl.searchParams.get('sig'),
  });
  if (!result) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(result.data), {
    headers: {
      'Content-Type': result.contentType,
      'Cache-Control': result.cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}
