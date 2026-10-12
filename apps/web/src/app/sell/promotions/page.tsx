import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, promotionOptions, sellerPromotions, type SellerPromotion } from '@thrift/application';
import { formatNaira, formatWat } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Card, CardSection } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { bookPromotionAction, cancelPromotionAction, payPromotionAction } from './actions';

export const metadata = { title: 'Promotions' };
export const dynamic = 'force-dynamic';

const STATUS: Record<SellerPromotion['status'], { label: string; tone: Tone }> = {
  awaiting_payment: { label: 'Waiting for payment', tone: 'warning' },
  pending_review: { label: 'Paid · in review', tone: 'info' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  active: { label: 'Live', tone: 'success' },
  paused: { label: 'Paused', tone: 'neutral' },
  ended: { label: 'Finished', tone: 'neutral' },
  rejected: { label: 'Not approved', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const PAYMENT_MESSAGE: Record<string, { tone: 'success' | 'info' | 'warning' | 'error'; text: string }> = {
  paid: { tone: 'success', text: 'Payment confirmed. Your promotion is now waiting for review.' },
  already_applied: { tone: 'success', text: 'Payment confirmed. Your promotion is now waiting for review.' },
  pending: { tone: 'info', text: 'We’re still waiting for the payment provider to confirm. This page updates once it does.' },
  uncertain: { tone: 'info', text: 'We couldn’t reach the payment provider. Check back in a few minutes before paying again.' },
  failed: { tone: 'error', text: 'The payment didn’t go through. You can try again from the booking below.' },
  mismatch: { tone: 'warning', text: 'The payment amount didn’t match. Our finance team will check it; you don’t need to pay again.' },
  late_refunded: { tone: 'warning', text: 'That booking had already closed, so your payment is being refunded in full.' },
  duplicate_refunded: { tone: 'warning', text: 'This promotion was already paid, so the second payment is being refunded.' },
};

const END_REASON: Record<string, string> = {
  completed: 'Ran its full time.',
  listing_unavailable: 'Stopped early because the item is no longer for sale.',
  listing_removed: 'Stopped early: the item was removed by trust & safety.',
  shop_suspended: 'Stopped early: the shop was suspended.',
  cancelled_by_seller: 'Cancelled by you.',
  payment_not_completed: 'Closed because payment wasn’t completed in time.',
};

export default async function PromotionsPage({ searchParams }: { searchParams: Promise<{ payment?: string }> }) {
  const user = await requireUserPage(routes.sell.promotions);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const sp = await searchParams;
  const ctx = await getCtx();
  const [{ packages, listings }, { promotions, attributionDays, generatedAt }] = await Promise.all([promotionOptions(ctx), sellerPromotions(ctx)]);
  const payment = sp.payment ? PAYMENT_MESSAGE[sp.payment] : undefined;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Promotions"
        description="Paid placements in the home feed, search results or nearby shops. They’re always labelled “Sponsored” and never change your reputation, reviews or badges."
      />
      {payment && <Alert tone={payment.tone}>{payment.text}</Alert>}
      <CardSection title="Book a promotion">
        <p className="mb-3 text-sm text-muted">
          Our team checks each promotion before it goes live. If it isn’t approved — or you cancel before it goes live — you get a full refund. Prices shown are draft sandbox prices.
        </p>
        <ul className="grid gap-3 md:grid-cols-3">
          {packages.map((p) => {
            const eligible = listings.filter((l) => !l.bookedPlacements.includes(p.placement));
            return (
            <li key={p.id}>
              <Card className="flex h-full flex-col gap-2 p-3">
                <p className="font-semibold">{p.name}</p>
                <p className="text-sm text-muted">
                  {p.placementLabel} · {p.durationDays} days · {p.targetKind === 'listing' ? 'one item' : 'your whole shop'}
                </p>
                <p className="font-serif text-2xl">{formatNaira(p.priceMinor)}</p>
                <ActionForm action={bookPromotionAction} refreshOnSuccess={false} className="mt-auto space-y-2">
                  <input type="hidden" name="packageId" value={p.id} />
                  {p.targetKind === 'listing' &&
                    (eligible.length > 0 ? (
                      <SelectField label="Item to promote" name="listingId" required placeholder="Choose an item" options={eligible.map((l) => ({ value: l.id, label: l.title }))} />
                    ) : (
                      <p className="text-sm text-muted">
                        {listings.length > 0 ? 'Every item in stock already has this placement booked.' : 'Publish an item that’s in stock to promote it.'}
                      </p>
                    ))}
                  <SubmitButton size="sm" disabled={p.targetKind === 'listing' && eligible.length === 0} pendingText="Starting payment…">
                    Book and pay {formatNaira(p.priceMinor)}
                  </SubmitButton>
                </ActionForm>
              </Card>
            </li>
            );
          })}
        </ul>
      </CardSection>
      <CardSection title="Your promotions">
        {promotions.length === 0 ? (
          <EmptyState title="No promotions yet">When you book one, you’ll see its status and how it performs here.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {promotions.map((p) => (
              <li key={p.id} className="space-y-2 py-3 text-sm" data-testid="promotion-row">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                  <span className="font-semibold">{p.packageName}</span>
                  {p.listingId && p.listingTitle && (
                    <Link href={routes.item(p.listingId)} className="text-primary underline">
                      {p.listingTitle}
                    </Link>
                  )}
                </div>
                <p className="text-muted">
                  {formatNaira(p.priceMinor)} · booked {formatWat(p.createdAt)}
                  {p.startsAt && p.endsAt && ` · runs ${formatWat(p.startsAt)} – ${formatWat(p.endsAt)}`}
                </p>
                {p.status === 'rejected' && p.reviewReason && <p>Reason: {p.reviewReason}</p>}
                {p.endReason && <p className="text-muted">{END_REASON[p.endReason] ?? (p.endReason.startsWith('staff:') ? `Stopped by our team — ${p.endReason.slice(6).trim()}` : p.endReason)}</p>}
                {p.endedEarly && p.refundMinor === 0 && p.refundPendingMinor === 0 && (
                  <p className="text-muted">Unused time (about {formatNaira(p.unusedMinor)}) isn’t refunded automatically. Contact support if you have questions.</p>
                )}
                {(p.refundMinor > 0 || p.refundPendingMinor > 0) && (
                  <p>
                    Refund: {p.refundMinor > 0 && <span className="font-semibold">{formatNaira(p.refundMinor)} confirmed</span>}
                    {p.refundMinor > 0 && p.refundPendingMinor > 0 && ' · '}
                    {p.refundPendingMinor > 0 && <span>{formatNaira(p.refundPendingMinor)} on its way</span>}
                  </p>
                )}
                {(p.status === 'active' || p.status === 'ended') && (
                  <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Impressions" value={p.impressions} />
                    <Stat label="Clicks" value={p.clicks} />
                    <Stat label="Attributed orders" value={p.attributedOrders} />
                    <Stat label="Attributed sales" value={formatNaira(p.attributedSalesMinor)} />
                  </dl>
                )}
                {(p.canPay || p.canCancel) && (
                  <div className="flex flex-wrap gap-2">
                    {p.canPay && (
                      <ActionForm action={payPromotionAction} refreshOnSuccess={false}>
                        <input type="hidden" name="campaignId" value={p.id} />
                        <SubmitButton size="sm" pendingText="Opening payment…">Pay {formatNaira(p.priceMinor)}</SubmitButton>
                      </ActionForm>
                    )}
                    {p.canCancel && (
                      <ActionForm action={cancelPromotionAction}>
                        <input type="hidden" name="campaignId" value={p.id} />
                        <SubmitButton size="sm" variant="ghost" pendingText="Cancelling…">
                          {p.status === 'awaiting_payment' ? 'Cancel booking' : 'Cancel and refund'}
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">
          Impressions and clicks count each shopper once a day and leave out bots and your own team. Attributed orders are paid orders for the promoted item (or your shop) by signed-in shoppers within {attributionDays} days of clicking — for information only, never used to charge you. Figures updated {formatWat(generatedAt)}.
        </p>
      </CardSection>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-sand px-2 py-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
