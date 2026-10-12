'use server';

import { redirect } from 'next/navigation';
import {
  addFlaw,
  bulkListingAction,
  createDraft,
  createFromTemplate,
  deleteTemplate,
  duplicateListing,
  markSoldElsewhere,
  pauseListing,
  publishListing,
  removeFlaw,
  removeListing,
  restockListing,
  resumeListing,
  saveAsTemplate,
  setListingPhotos,
  updateListing,
} from '@thrift/application';
import { routes } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';

/** Turns "measurements.chest_cm" / "attributes.fit" form keys into nested objects; repeated keys into lists. */
function listingForm(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const measurements: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  let hasM = false;
  let hasA = false;
  for (const [k, v] of form.entries()) {
    if (typeof v !== 'string' || k.startsWith('$ACTION')) continue;
    if (k.startsWith('measurements.')) {
      measurements[k.slice(13)] = v;
      hasM = true;
    } else if (k.startsWith('attributes.')) {
      attributes[k.slice(11)] = v;
      hasA = true;
    } else if (k === 'deliveryStates') {
      out.deliveryStates = form.getAll('deliveryStates').map(String).join(',');
    } else if (k !== '__section') out[k] = v;
  }
  if (form.get('__section') === 'pricing' && !form.has('deliveryStates')) out.deliveryStates = '';
  if (hasM) out.measurements = measurements;
  if (hasA) out.attributes = attributes;
  return out;
}

export async function createDraftAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => createDraft(ctx, formObject(form)));
  if (state.status === 'success') redirect(routes.sell.listing((state.data as { listingId: string }).listingId));
  return state;
}

export async function createFromTemplateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => createFromTemplate(ctx, formObject(form)));
  if (state.status === 'success') redirect(routes.sell.listing((state.data as { listingId: string }).listingId));
  return state;
}

export async function deleteTemplateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => deleteTemplate(ctx, formObject(form)), 'Template deleted.');
}

export async function updateListingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => updateListing(ctx, listingForm(form)), 'Saved.');
}

export async function savePhotosAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => setListingPhotos(ctx, formObject(form)), 'Photos saved.');
}

export async function addFlawAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => addFlaw(ctx, formObject(form)), 'Flaw added.');
}

export async function removeFlawAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => removeFlaw(ctx, formObject(form)), 'Flaw removed.');
}

export async function listingCommandAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const command = String(form.get('command') ?? '');
  const input = formObject(form);
  if (command === 'duplicate' || command === 'remove') {
    const state = await runAction((ctx) => (command === 'duplicate' ? duplicateListing(ctx, input) : removeListing(ctx, input)));
    if (state.status === 'success') {
      redirect(command === 'duplicate' ? routes.sell.listing((state.data as { listingId: string }).listingId) : routes.sell.listings);
    }
    return state;
  }
  const state = await runAction(async (ctx) => {
    switch (command) {
      case 'publish': {
        const r = await publishListing(ctx, input);
        return r.status === 'scheduled' ? 'Published — scheduled for the batch drop.' : 'Published. It’s live in your shop.';
      }
      case 'pause':
        await pauseListing(ctx, input);
        return 'Paused. It’s hidden from buyers.';
      case 'resume':
        await resumeListing(ctx, input);
        return 'Back on sale.';
      case 'sold_elsewhere':
        await markSoldElsewhere(ctx, input);
        return 'Marked as sold elsewhere.';
      case 'restock':
        await restockListing(ctx, input);
        return 'Units added.';
      case 'template':
        await saveAsTemplate(ctx, input);
        return 'Saved as a template.';
      default:
        return 'Nothing to do.';
    }
  });
  if (state.status === 'success') return { status: 'success', message: String(state.data) };
  return state;
}

export async function bulkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const listingIds = form.getAll('listingIds').map(String);
  const state = await runAction((ctx) => bulkListingAction(ctx, { action: form.get('action'), listingIds }));
  if (state.status !== 'success') return state;
  const r = state.data as { succeeded: number; failed: number; results: { ok: boolean; message: string }[] };
  const failures = r.results.filter((x) => !x.ok).map((x) => x.message);
  const message = `${r.succeeded} updated${r.failed ? `; ${r.failed} not changed (${[...new Set(failures)].join(' ')})` : ''}.`;
  return r.failed && !r.succeeded ? { status: 'error', message } : { status: 'success', message };
}
