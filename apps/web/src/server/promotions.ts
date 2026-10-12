import 'server-only';
import { headers } from 'next/headers';
import { recordPromotionImpressions, type PromotionViewer } from '@thrift/application';
import { getCtx } from './session';

type Placement = 'home_feed' | 'search_results' | 'nearby';

/** Who is looking, for once-per-day promotion counting (raw IPs are hashed with the app secret before storage). */
export async function promotionViewer(): Promise<PromotionViewer> {
  const ctx = await getCtx();
  const h = await headers();
  const userAgent = h.get('user-agent');
  const userId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  return { viewerKey: userId ? `u:${userId}` : `a:${ctx.ip ?? ''}:${userAgent ?? ''}`, userId, userAgent, secret: ctx.config.appSecret };
}

/** Counts impressions for the sponsored entries a page rendered. Never fails the page. */
export async function recordSponsoredImpressions(placement: Placement, targetIds: string[]): Promise<void> {
  if (targetIds.length === 0) return;
  try {
    const ctx = await getCtx();
    await recordPromotionImpressions(ctx.pool, { placement, targetIds, viewer: await promotionViewer() });
  } catch {
    // Reporting is best effort; discovery must keep working.
  }
}
