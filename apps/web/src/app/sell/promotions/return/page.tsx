import { redirect } from 'next/navigation';
import { applyVerifiedPayment } from '@thrift/application';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';

export const metadata = { title: 'Confirming payment' };
export const dynamic = 'force-dynamic';

/**
 * Where the payment provider sends the seller back after paying for a promotion. The query string is never
 * trusted: the reference is verified with the provider server-side (idempotently — the webhook may already have
 * applied it), then the seller sees the result on their promotions page.
 */
export default async function PromotionPaymentReturnPage({ searchParams }: { searchParams: Promise<{ reference?: string; trxref?: string }> }) {
  const sp = await searchParams;
  await requireUserPage(routes.sell.promotions);
  const reference = (sp.reference ?? sp.trxref ?? '').slice(0, 100);
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(reference)) redirect(routes.sell.promotions);
  const result = await applyVerifiedPayment(await getCtx(), reference);
  redirect(`${routes.sell.promotions}?payment=${encodeURIComponent(result.outcome)}`);
}
