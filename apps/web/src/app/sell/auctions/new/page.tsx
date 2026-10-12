import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, getAuctionScheduleContext } from '@thrift/application';
import { toWatDateTimeLocal } from '@thrift/contracts';
import { formatNaira, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardSection } from '@/components/ui/Card';
import { CheckboxField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Photo } from '@/components/ui/Photo';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { scheduleAuctionAction } from '../actions';

export const metadata = { title: 'Schedule an auction' };
export const dynamic = 'force-dynamic';

export default async function NewAuctionPage({ searchParams }: { searchParams: Promise<{ listing?: string; relist?: string }> }) {
  const sp = await searchParams;
  const user = await requireUserPage(withQuery('/sell/auctions/new', sp));
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  let c;
  try {
    c = await getAuctionScheduleContext(await getCtx(), { listingId: sp.listing, relistAuctionId: sp.relist });
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') redirect(routes.sell.auctions);
    throw err;
  }
  const s = c.selected;
  const now = new Date();
  const defaultStart = toWatDateTimeLocal(new Date(Math.ceil((now.getTime() + 60 * 60_000) / 900_000) * 900_000));
  const defaultEnd = toWatDateTimeLocal(new Date(Math.ceil((now.getTime() + 25 * 60 * 60_000) / 900_000) * 900_000));
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={c.relist ? 'Relist at auction' : 'Schedule an auction'} description="An auction sells one identified piece. Bidders see these rules before they bid." />
      {!c.relist && (
        <CardSection title="1. Choose the piece">
          {c.candidates.length === 0 ? (
            <p className="text-sm text-muted">
              You have no draft single pieces. <Link href={routes.sell.newListing} className="font-semibold underline">Add an item</Link> as a draft (choose “Auction” as the sale type), then come back.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {c.candidates.map((l) => (
                <li key={l.id}>
                  <Link
                    href={withQuery('/sell/auctions/new', { listing: l.id })}
                    aria-current={s?.id === l.id ? 'true' : undefined}
                    className={cx('flex items-center gap-2 rounded-[var(--radius-card)] border-2 p-2 text-sm', s?.id === l.id ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:border-primary')}
                  >
                    <span className="h-12 w-10 flex-none overflow-hidden rounded bg-sand">{l.photoUrl && <Photo src={l.photoUrl} alt="" className="h-full w-full" />}</span>
                    <span className="line-clamp-2">{l.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardSection>
      )}
      {s && (
        <CardSection title={c.relist ? `Relisting “${s.title}”` : '2. Set the terms'}>
          {s.issues.length > 0 ? (
            <Alert tone="warning" title="Finish the listing before scheduling">
              <ul className="list-disc pl-5">
                {s.issues.map((i) => (
                  <li key={`${i.field}-${i.message}`}>{i.message}</li>
                ))}
              </ul>
              <ButtonLink href={routes.sell.listing(s.id)} size="sm" variant="secondary" className="mt-2">Edit listing</ButtonLink>
            </Alert>
          ) : (
            <ActionForm action={scheduleAuctionAction} refreshOnSuccess={false} className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="listingId" value={s.id} />
              {c.relist && <input type="hidden" name="relistAuctionId" value={c.relist.auctionId} />}
              <TextField label="Starts (WAT)" name="startsAt" type="datetime-local" defaultValue={defaultStart} hint="West Africa Time." />
              <TextField label="Ends (WAT)" name="endsAt" type="datetime-local" required defaultValue={defaultEnd} hint="Between 15 minutes and 7 days after the start." />
              <CheckboxField label="Start now instead" name="startNow" className="sm:col-span-2" />
              <TextField
                label="Opening price (₦)"
                name="openingPrice"
                inputMode="numeric"
                required
                defaultValue={s.referencePriceMinor ? String(s.referencePriceMinor / 100) : ''}
                hint="The lowest price you’ll accept. There is no hidden reserve."
              />
              <TextField label="Bid increment (₦)" name="increment" inputMode="numeric" required defaultValue={String(s.suggestedIncrementMinor / 100)} hint={`Suggested: ${formatNaira(s.suggestedIncrementMinor)}.`} />
              <Card className="bg-sand p-3 text-sm sm:col-span-2">
                <p className="font-semibold">Rules bidders will see</p>
                <ul className="mt-1 list-disc pl-5 text-muted">
                  <li>A bid in the final {c.rules.extensionWindowSeconds / 60} minutes extends the end to {c.rules.extensionSeconds / 60} minutes after that bid, up to {c.rules.maxExtensionSeconds / 60} minutes in total.</li>
                  <li>The winner pays within {c.rules.winnerPaymentHours} hours. If they don’t, you can offer the runner-up a second chance or relist.</li>
                  <li>You can cancel only before the first bid. After that, terms and item details are locked.</li>
                </ul>
              </Card>
              <div className="sm:col-span-2">
                <SubmitButton size="lg" pendingText="Scheduling…">{c.relist ? 'Relist auction' : 'Schedule auction'}</SubmitButton>
              </div>
            </ActionForm>
          )}
        </CardSection>
      )}
    </div>
  );
}
