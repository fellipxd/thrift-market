import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, getBatch, listBatches } from '@thrift/application';
import { formatNaira, formatWat } from '@thrift/domain';
import { ListingStatusBadge } from '@/components/catalogue/ListingStatusBadge';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextAreaField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { createBatchAction, deleteBatchAction, updateBatchAction } from './actions';

export const metadata = { title: 'Batches and drops' };

/** WAT datetime-local value ("2026-10-15T18:00") for an ISO instant. */
function toWatLocal(iso: string | null): string {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + 3_600_000).toISOString().slice(0, 16);
}

export default async function BatchesPage({ searchParams }: { searchParams: Promise<{ batch?: string }> }) {
  const user = await requireUserPage(routes.sell.batches);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const { batch } = await searchParams;
  const ctx = await getCtx();
  const batches = await listBatches(ctx);
  const selected = batch && batches.some((b) => b.id === batch) ? await getBatch(ctx, batch) : null;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Batches and drops"
        description="Group a stock intake or announce a drop. Every piece keeps its own photos, condition and stock — a batch never merges different pieces."
      />
      <CardSection title="New batch">
        <ActionForm action={createBatchAction} className="space-y-3" resetOnSuccess>
          <TextField label="Name" name="name" required maxLength={80} placeholder="e.g. Friday denim drop" />
          <TextAreaField label="Note (private)" name="note" rows={2} maxLength={500} />
          <TextField label="Drop time (WAT, optional)" name="dropAt" type="datetime-local" hint="Pieces you publish into this batch stay hidden until the drop, then go live together. Followers who opted in are notified once." />
          <SubmitButton pendingText="Creating…">Create batch</SubmitButton>
        </ActionForm>
      </CardSection>
      {batches.length === 0 ? (
        <EmptyState title="No batches yet">Batches are optional — use them for bale intakes or scheduled drops.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {batches.map((b) => (
            <li key={b.id} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Link href={withQuery(routes.sell.batches, { batch: b.id })} className="font-semibold hover:underline">{b.name}</Link>
                  <p className="text-sm text-muted">
                    {b.pieces} {b.pieces === 1 ? 'piece' : 'pieces'} · {b.onSale} on sale{b.scheduled ? ` · ${b.scheduled} scheduled` : ''}
                  </p>
                </div>
                {b.dropAt && (b.dropAnnouncedAt ? <Badge tone="success">Dropped {formatWat(b.dropAnnouncedAt)}</Badge> : <Badge tone="info">Drops {formatWat(b.dropAt)}</Badge>)}
              </div>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <CardSection title={`Batch: ${selected.name}`}>
          <ActionForm action={updateBatchAction} className="space-y-3">
            <input type="hidden" name="batchId" value={selected.id} />
            <TextField label="Name" name="name" defaultValue={selected.name} required maxLength={80} />
            <TextAreaField label="Note (private)" name="note" defaultValue={selected.note} rows={2} maxLength={500} />
            <TextField
              label="Drop time (WAT)"
              name="dropAt"
              type="datetime-local"
              defaultValue={toWatLocal(selected.dropAt)}
              disabled={Boolean(selected.dropAnnouncedAt)}
              hint={selected.dropAnnouncedAt ? 'This drop has gone live; its time is fixed.' : 'Clear it to put scheduled pieces on sale now.'}
            />
            {selected.dropAnnouncedAt && <input type="hidden" name="dropAt" value={selected.dropAt ?? ''} />}
            <SubmitButton pendingText="Saving…">Save batch</SubmitButton>
          </ActionForm>
          <h3 className="mt-6 font-semibold">Pieces</h3>
          {selected.listings.length === 0 ? (
            <p className="text-sm text-muted">No pieces yet. Choose this batch in a listing’s “Price, quantity and delivery” section.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {selected.listings.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link href={routes.sell.listing(l.id)} className="hover:underline">{l.title}{l.sizeLabel ? ` · ${l.sizeLabel}` : ''}</Link>
                  <span className="flex items-center gap-2">
                    {l.priceMinor ? formatNaira(l.priceMinor) : ''}
                    <ListingStatusBadge status={l.status} label={l.statusLabel} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {selected.pieces === 0 && (
            <ActionForm action={deleteBatchAction} className="mt-4" successRedirect={routes.sell.batches}>
              <input type="hidden" name="batchId" value={selected.id} />
              <SubmitButton variant="ghost" size="sm" pendingText="…">Delete empty batch</SubmitButton>
            </ActionForm>
          )}
        </CardSection>
      )}
    </div>
  );
}
