import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getListingForEdit, getSettings, listListableCategories, type ListingEditView } from '@thrift/application';
import { CONDITION_GRADES, CONDITION_INFO, formatWat, isDomainError, minorToMajorString, NIGERIAN_STATES, SIZE_SYSTEM_LABEL, stateLabel } from '@thrift/domain';
import { ListingStatusBadge } from '@/components/catalogue/ListingStatusBadge';
import { PhotoManager } from '@/components/catalogue/PhotoManager';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { CardSection } from '@/components/ui/Card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { addFlawAction, listingCommandAction, removeFlawAction, savePhotosAction, updateListingAction } from '../actions';

export const metadata = { title: 'Edit listing' };

function Command({ listingId, command, label, variant = 'secondary', extra }: { listingId: string; command: string; label: string; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; extra?: React.ReactNode }) {
  return (
    <ActionForm action={listingCommandAction} showSuccess>
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="command" value={command} />
      {extra}
      <SubmitButton variant={variant} size="sm" pendingText="Working…">{label}</SubmitButton>
    </ActionForm>
  );
}

function Locked({ reason }: { reason?: string }) {
  return reason ? <p className="text-sm text-warning">🔒 {reason}</p> : null;
}

export default async function EditListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireUserPage(routes.sell.listing(id));
  const ctx = await getCtx();
  let l: ListingEditView;
  try {
    l = await getListingForEdit(ctx, id);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  const settings = await getSettings(ctx.pool);
  const categories = l.isDraft ? await listListableCategories(ctx.pool) : [];
  const editable = !['sold', 'removed'].includes(l.status);
  const photoOptions = l.photos.map((p, i) => ({ value: p.mediaId, label: `Photo ${i + 1} (${p.role})` }));

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-muted"><Link href={routes.sell.listings} className="hover:underline">Listings</Link> / {l.isDraft ? 'Draft' : 'Edit'}</p>
          <h1 className="display text-[2.25rem] text-ink md:text-5xl">{l.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ListingStatusBadge status={l.status} label={l.statusLabel} />
            <span className="text-sm text-muted">{l.categoryName} · version {l.version}</span>
            {l.stock && l.quantityMode === 'equivalent' && <span className="text-sm text-muted">{l.stock.available} available · {l.stock.reserved} reserved · {l.stock.sold} sold</span>}
          </div>
        </div>
        {!l.isDraft && l.status !== 'removed' && <ButtonLink href={routes.item(l.id)} variant="ghost" size="sm">View public page</ButtonLink>}
      </div>

      {l.hasActiveReservation && <Alert tone="warning" title="Reserved for a buyer">Price, condition, photos and quantity are locked until the reservation finishes.</Alert>}
      {l.auction && <Alert tone="info" title={`Auction: ${l.auction.status.replace('_', ' ')}`}>{l.auction.bidCount > 0 ? 'Terms and item details are locked after the first bid.' : 'Manage the schedule from the auctions page.'} <Link className="font-semibold underline" href={routes.auction(l.auction.id)}>Open auction</Link></Alert>}

      <CardSection title="Actions">
        <div className="flex flex-wrap gap-2">
          {l.isDraft && l.saleMode !== 'auction' && <Command listingId={l.id} command="publish" label="Publish" variant="primary" />}
          {l.isDraft && l.saleMode === 'auction' && <ButtonLink href={routes.sell.newAuction(l.id)} size="sm">Schedule auction</ButtonLink>}
          {['active', 'scheduled'].includes(l.status) && !l.auction && <Command listingId={l.id} command="pause" label="Pause" />}
          {l.status === 'paused' && <Command listingId={l.id} command="resume" label="Resume" variant="primary" />}
          {['active', 'paused', 'scheduled'].includes(l.status) && !l.auction && (
            <Command listingId={l.id} command="sold_elsewhere" label="Mark sold elsewhere" extra={l.quantityMode === 'equivalent' ? <input type="hidden" name="quantity" value="1" /> : null} />
          )}
          {l.quantityMode === 'equivalent' && !l.isDraft && l.status !== 'removed' && (
            <ActionForm action={listingCommandAction} className="flex items-end gap-2">
              <input type="hidden" name="listingId" value={l.id} />
              <input type="hidden" name="command" value="restock" />
              <label className="text-sm">
                <span className="sr-only">Units to add</span>
                <input name="quantity" type="number" min={1} max={500} defaultValue={1} className="w-20 rounded-lg border border-line-strong px-2 py-1.5" />
              </label>
              <SubmitButton size="sm" variant="secondary" pendingText="…">Restock</SubmitButton>
            </ActionForm>
          )}
          <Command listingId={l.id} command="duplicate" label="Duplicate" variant="ghost" />
          <ActionForm action={listingCommandAction} className="flex items-end gap-2">
            <input type="hidden" name="listingId" value={l.id} />
            <input type="hidden" name="command" value="template" />
            <label className="text-sm">
              <span className="sr-only">Template name</span>
              <input name="name" placeholder="Template name" maxLength={80} className="w-40 rounded-lg border border-line-strong px-2 py-1.5" />
            </label>
            <SubmitButton size="sm" variant="ghost" pendingText="…">Save as template</SubmitButton>
          </ActionForm>
          {l.status !== 'sold' && l.status !== 'removed' && <Command listingId={l.id} command="remove" label="Remove" variant="danger" />}
        </div>
        {l.isDraft && l.publishIssues.length > 0 && (
          <div className="mt-4 rounded-[var(--radius-control)] bg-warning-soft p-3 text-sm">
            <p className="font-semibold text-warning">Before you can publish:</p>
            <ul className="mt-1 list-disc pl-5 text-ink">
              {l.publishIssues.map((i) => (
                <li key={`${i.field}-${i.message}`}>{i.message}</li>
              ))}
            </ul>
          </div>
        )}
        {l.isDraft && l.publishIssues.length === 0 && <p className="mt-3 text-sm text-success">Ready to publish.</p>}
      </CardSection>

      <CardSection title="Photos">
        <PhotoManager
          listingId={l.id}
          initial={l.photos.map((p) => ({ mediaId: p.mediaId, role: p.role, caption: p.caption, thumbUrl: p.thumbUrl }))}
          maxPhotos={settings.max_listing_photos}
          lockedReason={!editable ? 'This listing can no longer be edited.' : l.locked.photos}
          recommendedRoles={l.schema.recommendedPhotoRoles}
          action={savePhotosAction}
        />
      </CardSection>

      <CardSection title="Details">
        <ActionForm action={updateListingAction} className="space-y-4">
          <input type="hidden" name="listingId" value={l.id} />
          {l.isDraft && (
            <SelectField
              label="Category"
              name="categoryId"
              defaultValue={l.categoryId}
              options={categories.map((c) => ({ value: c.id, label: `${c.parentName} › ${c.name}${c.restricted ? ' (restricted)' : ''}` }))}
              hint="Changing category may clear measurements that don’t apply."
            />
          )}
          {l.isDraft && <input type="hidden" name="restrictedAcknowledged" value={l.categoryRestricted ? 'true' : ''} />}
          <TextField label="Title" name="title" defaultValue={l.title} required maxLength={90} disabled={!editable} />
          <TextAreaField label="Description" name="description" defaultValue={l.description} rows={5} maxLength={4000} disabled={!editable} hint="Fit, feel, styling ideas and anything a buyer usually asks in DMs." />
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label="Brand (if known)" name="brand" defaultValue={l.brand ?? ''} maxLength={60} disabled={!editable} />
            <TextField label="Colour" name="colour" defaultValue={l.colour ?? ''} maxLength={40} disabled={!editable} />
            <TextField label="Material" name="material" defaultValue={l.material ?? ''} maxLength={60} disabled={!editable} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Size system"
              name="sizeSystem"
              defaultValue={l.sizeSystem ?? ''}
              placeholder="Choose"
              disabled={!editable || Boolean(l.locked.condition)}
              options={(l.schema.allowedSizeSystems.length ? l.schema.allowedSizeSystems : (Object.keys(SIZE_SYSTEM_LABEL) as (keyof typeof SIZE_SYSTEM_LABEL)[])).map((s) => ({ value: s, label: SIZE_SYSTEM_LABEL[s] }))}
            />
            <TextField label="Size" name="sizeLabel" defaultValue={l.sizeLabel ?? ''} maxLength={20} disabled={!editable || Boolean(l.locked.condition)} hint={l.schema.sizeRequired ? 'Required for this category.' : undefined} />
          </div>
          {l.schema.measurements.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Measurements (cm, measured flat)</legend>
              <div className="grid gap-4 sm:grid-cols-3">
                {l.schema.measurements.map((m) => (
                  <TextField
                    key={m.key}
                    label={`${m.label}${m.required ? ' *' : ''}`}
                    name={`measurements.${m.key}`}
                    inputMode="decimal"
                    defaultValue={l.measurements[m.key] !== undefined ? String(l.measurements[m.key]) : ''}
                    disabled={!editable || Boolean(l.locked.condition)}
                  />
                ))}
              </div>
              <p className="text-xs text-muted">Measurements help buyers when brand sizes don’t match.</p>
            </fieldset>
          )}
          {l.schema.attributes.map((a) =>
            a.type === 'select' ? (
              <SelectField key={a.key} label={a.label} name={`attributes.${a.key}`} defaultValue={l.attributes[a.key] ?? ''} placeholder="Choose" options={(a.options ?? []).map((o) => ({ value: o, label: o }))} disabled={!editable} />
            ) : (
              <TextField key={a.key} label={a.label} name={`attributes.${a.key}`} defaultValue={l.attributes[a.key] ?? ''} maxLength={60} disabled={!editable} />
            ),
          )}
          <Locked reason={l.locked.condition} />
          {editable && <SubmitButton pendingText="Saving…">Save details</SubmitButton>}
        </ActionForm>
      </CardSection>

      <CardSection title="Condition and flaws">
        <ActionForm action={updateListingAction} className="space-y-4">
          <input type="hidden" name="listingId" value={l.id} />
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Condition grade</legend>
            {CONDITION_GRADES.map((g) => (
              <label key={g} className="flex min-h-11 items-start gap-2 rounded-[var(--radius-control)] border border-line p-3">
                <input type="radio" name="condition" value={g} defaultChecked={l.condition === g} disabled={!editable || Boolean(l.locked.condition)} className="mt-1 size-4 accent-[var(--color-primary)]" />
                <span>
                  <span className="font-medium">{CONDITION_INFO[g].label}</span>
                  <span className="block text-sm text-muted">{CONDITION_INFO[g].summary} e.g. {CONDITION_INFO[g].examples}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Known flaws</legend>
            <label className="flex min-h-10 items-center gap-2">
              <input type="radio" name="flawsDeclaration" value="none_known" defaultChecked={l.flawsDeclaration === 'none_known'} disabled={!editable || Boolean(l.locked.condition)} className="size-4 accent-[var(--color-primary)]" />
              I’ve checked carefully — no known flaws
            </label>
            <label className="flex min-h-10 items-center gap-2">
              <input type="radio" name="flawsDeclaration" value="described" defaultChecked={l.flawsDeclaration === 'described'} disabled={!editable || Boolean(l.locked.condition)} className="size-4 accent-[var(--color-primary)]" />
              Yes — described below, each with a photo
            </label>
          </fieldset>
          <Locked reason={l.locked.condition} />
          {editable && !l.locked.condition && <SubmitButton pendingText="Saving…">Save condition</SubmitButton>}
        </ActionForm>
        {l.flaws.length > 0 && (
          <ul className="mt-4 divide-y divide-line rounded-[var(--radius-control)] border border-line">
            {l.flaws.map((f) => {
              const idx = l.photos.findIndex((p) => p.mediaId === f.mediaId);
              return (
                <li key={f.id} className="flex items-start justify-between gap-3 p-3 text-sm">
                  <div>
                    <p><span className="font-medium capitalize">{f.severity}:</span> {f.description}{f.location ? ` (${f.location})` : ''}</p>
                    <p className={idx >= 0 ? 'text-muted' : 'text-error'}>{idx >= 0 ? `Shown in photo ${idx + 1}` : 'Needs a photo before publishing'}</p>
                  </div>
                  {editable && !l.locked.condition && (
                    <ActionForm action={removeFlawAction} showSuccess={false}>
                      <input type="hidden" name="listingId" value={l.id} />
                      <input type="hidden" name="flawId" value={f.id} />
                      <SubmitButton variant="ghost" size="sm" pendingText="…">Remove</SubmitButton>
                    </ActionForm>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {editable && !l.locked.condition && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-semibold text-primary">Add a flaw</summary>
            <ActionForm action={addFlawAction} className="mt-3 space-y-3" resetOnSuccess>
              <input type="hidden" name="listingId" value={l.id} />
              <TextField label="What is it?" name="description" required maxLength={300} placeholder="e.g. Small mark on left cuff" />
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField label="Where" name="location" maxLength={80} placeholder="Left cuff" />
                <SelectField label="How noticeable" name="severity" defaultValue="minor" options={[{ value: 'minor', label: 'Minor' }, { value: 'moderate', label: 'Moderate' }, { value: 'major', label: 'Major' }]} />
                <SelectField label="Photo showing it" name="mediaId" defaultValue="" placeholder={photoOptions.length ? 'Choose a photo' : 'Add photos first'} options={photoOptions} />
              </div>
              <SubmitButton size="sm" pendingText="Adding…">Add flaw</SubmitButton>
            </ActionForm>
          </details>
        )}
      </CardSection>

      <CardSection title="Price, quantity and delivery">
        <ActionForm action={updateListingAction} className="space-y-4">
          <input type="hidden" name="listingId" value={l.id} />
          <input type="hidden" name="__section" value="pricing" />
          <SelectField
            label="Sale mode"
            name="saleMode"
            defaultValue={l.saleMode}
            disabled={!editable || Boolean(l.locked.saleMode)}
            options={[{ value: 'fixed', label: 'Fixed price' }, { value: 'negotiable', label: 'Negotiable (accept offers)' }, { value: 'auction', label: 'Auction (scheduled)' }]}
          />
          <Locked reason={l.locked.saleMode} />
          {l.saleMode !== 'auction' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Price (₦)" name="price" inputMode="decimal" defaultValue={l.priceMinor ? minorToMajorString(l.priceMinor) : ''} disabled={!editable || Boolean(l.locked.price)} />
              {l.saleMode === 'negotiable' && (
                <TextField
                  label="Private minimum (₦, optional)"
                  name="minOffer"
                  inputMode="decimal"
                  defaultValue={l.minOfferMinor ? minorToMajorString(l.minOfferMinor) : ''}
                  disabled={!editable || Boolean(l.locked.price)}
                  hint="Never shown to buyers. Offers below it are declined automatically without revealing the amount."
                />
              )}
            </div>
          )}
          <Locked reason={l.locked.price} />
          <fieldset className="space-y-2" disabled={!l.isDraft}>
            <legend className="text-sm font-semibold">Quantity</legend>
            <label className="flex min-h-10 items-start gap-2">
              <input type="radio" name="quantityMode" value="unique" defaultChecked={l.quantityMode === 'unique'} className="mt-1 size-4 accent-[var(--color-primary)]" />
              <span>Unique piece (quantity 1)</span>
            </label>
            <label className="flex min-h-10 items-start gap-2">
              <input type="radio" name="quantityMode" value="equivalent" defaultChecked={l.quantityMode === 'equivalent'} className="mt-1 size-4 accent-[var(--color-primary)]" />
              <span>Identical units — only if size, colour, condition and delivery are genuinely the same. Different pieces from one bale need their own listings.</span>
            </label>
            <TextField label="Number of identical units" name="quantity" inputMode="numeric" defaultValue={String(l.quantity)} disabled={!l.isDraft} />
          </fieldset>
          <Locked reason={l.isDraft ? undefined : l.locked.quantity} />
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-primary">Limit delivery for this piece ({l.deliveryStates.length ? `${l.deliveryStates.length} states` : 'uses shop coverage'})</summary>
            <div className="mt-2 grid max-h-56 grid-cols-2 gap-1 overflow-y-auto rounded-[var(--radius-control)] border border-line p-3 sm:grid-cols-3">
              {NIGERIAN_STATES.map((s) => (
                <label key={s} className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="deliveryStates" value={s} defaultChecked={l.deliveryStates.includes(s)} className="size-4 accent-[var(--color-primary)]" />
                  {stateLabel(s)}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">Leave all unticked to use your shop’s coverage. Ticked states must be within your coverage.</p>
          </details>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Packed weight (grams, optional)" name="weightGrams" inputMode="numeric" defaultValue={l.weightGrams ? String(l.weightGrams) : ''} hint="Helps courier quotes." />
            <SelectField
              label="Batch / drop (optional)"
              name="batchId"
              defaultValue={l.batchId ?? ''}
              placeholder="No batch"
              options={l.batches.map((b) => ({ value: b.id, label: `${b.name}${b.dropAt ? ` · drops ${formatWat(b.dropAt)}` : ''}` }))}
            />
          </div>
          {editable && <SubmitButton pendingText="Saving…">Save price and delivery</SubmitButton>}
        </ActionForm>
      </CardSection>
    </div>
  );
}
