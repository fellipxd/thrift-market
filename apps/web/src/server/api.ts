import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { HTTP_STATUS, isDomainError } from '@thrift/domain';
import { resolveSession, SESSION_COOKIE, type AppContext } from '@thrift/application';
import { services } from './services';

type RouteParams = Record<string, string | string[]>;

/**
 * Wraps a JSON API route handler: builds the context (cookie or Bearer session), applies a same-origin
 * check for cookie-authenticated mutations (CSRF), and maps domain errors to stable error bodies:
 *   { "error": { "code": "STOCK_CONFLICT", "message": "...", "details": {...} } }
 */
export function apiRoute<P extends RouteParams = RouteParams>(
  handler: (req: NextRequest, ctx: AppContext, params: P) => Promise<unknown>,
) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const svc = services();
    const requestId = req.headers.get('x-request-id') ?? `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
      const cookieToken = req.cookies.get(SESSION_COOKIE)?.value;
      if (!bearer && cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isSameOrigin(req)) {
        return json({ error: { code: 'FORBIDDEN', message: 'Cross-site request rejected.' } }, 403, requestId);
      }
      const user = await resolveSession(svc.pool, bearer ?? cookieToken, new Date());
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
      const ctx = svc.context(user ?? { kind: 'guest' }, { requestId, ip });
      const result = await handler(req, ctx, await segment.params);
      if (result instanceof Response) return result;
      return json(result ?? { ok: true }, 200, requestId);
    } catch (err) {
      if (isDomainError(err)) {
        return json({ error: { code: err.code, message: err.message, details: err.details } }, HTTP_STATUS[err.code] ?? 400, requestId);
      }
      if (err instanceof SyntaxError) {
        return json({ error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON body.' } }, 400, requestId);
      }
      console.error(`[api] ${req.method} ${req.nextUrl.pathname} request=${requestId}`, err);
      return json({ error: { code: 'INTERNAL', message: 'Unexpected server error.', details: { requestId } } }, 500, requestId);
    }
  };
}

function json(body: unknown, status: number, requestId: string): Response {
  return NextResponse.json(body, { status, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } });
}

function isSameOrigin(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

export async function readJson(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (text.length > 100_000) throw new SyntaxError('Body too large');
  return text ? JSON.parse(text) : {};
}
