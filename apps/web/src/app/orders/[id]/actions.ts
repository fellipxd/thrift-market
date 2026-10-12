'use server';

import { addDisputeEntry, appealDispute, confirmReceipt, openDispute, respondToPartialOffer, withdrawDispute } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';
import { uploadFormImages } from '@/server/uploads';

export async function confirmReceiptAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => confirmReceipt(ctx, formObject(form)), 'Thanks — delivery confirmed. You can now review the seller.');
}

export async function openDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const evidenceMediaIds = await uploadFormImages(ctx, form, 'photos', 'dispute_evidence', 6);
    return openDispute(ctx, { ...formObject(form), evidenceMediaIds });
  }, 'Problem reported. The seller has been asked to respond, and the payout is on hold.');
}

export async function partialOfferAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => respondToPartialOffer(ctx, formObject(form)), 'Response recorded.');
}

export async function withdrawDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => withdrawDispute(ctx, formObject(form)), 'Dispute withdrawn.');
}

export async function appealDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => appealDispute(ctx, formObject(form)), 'Appeal sent. A different support team member will review it.');
}

export async function disputeMessageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const evidenceMediaIds = await uploadFormImages(ctx, form, 'photos', 'dispute_evidence', 6);
    return addDisputeEntry(ctx, { ...formObject(form), evidenceMediaIds });
  }, 'Added.');
}
