import { NextResponse, type NextRequest } from 'next/server';
import { AD_PLACEMENTS, type AdPlacement } from '@thrift/contracts';
import { recordPromotionClick } from '@thrift/application';
import { promotionViewer } from '@/server/promotions';
import { getCtx } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Sponsored entries link here. Counts the click (once per shopper per campaign per day) and redirects to the
 * promoted item or shop — the destination is looked up server-side, never taken from the query string.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const p = request.nextUrl.searchParams.get('p') ?? '';
  const t = request.nextUrl.searchParams.get('t') ?? '';
  if (!(AD_PLACEMENTS as readonly string[]).includes(p)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const ctx = await getCtx();
  let href: string | null = null;
  try {
    href = await recordPromotionClick(ctx.pool, { placement: p as AdPlacement, targetId: t, viewer: await promotionViewer() });
  } catch {
    href = null;
  }
  if (!href) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return new NextResponse(null, { status: 303, headers: { Location: href, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}
