'use server';

import { confirmReturnReceived, markDeliveredBySeller, markDispatched, respondToDispute, type DispatchResult } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';
import { uploadFormImages } from '@/server/uploads';

export async function dispatchAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction(async (ctx) => {
    const [proofMediaId] = await uploadFormImages(ctx, form, 'proof', 'delivery_proof', 1);
    return markDispatched(ctx, { ...formObject(form), proofMediaId });
  });
  if (state.status === 'success') {
    const r = state.data as DispatchResult;
    return {
      status: 'success',
      message: r.bookingPending
        ? 'Courier booking requested. We’ll keep trying and update the order when it’s booked.'
        : r.trackingReference
          ? `Dispatched. Tracking reference ${r.trackingReference}.`
          : 'Marked as dispatched. The buyer has been told.',
    };
  }
  return state;
}

export async function markDeliveredAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => markDeliveredBySeller(ctx, formObject(form)), 'Marked as delivered. The buyer has been asked to confirm — your payout is released after confirmation.');
}

export async function respondDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const evidenceMediaIds = await uploadFormImages(ctx, form, 'photos', 'dispute_evidence', 6);
    return respondToDispute(ctx, { ...formObject(form), evidenceMediaIds });
  }, 'Response sent.');
}

export async function confirmReturnAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => confirmReturnReceived(ctx, formObject(form)), 'Return confirmed. The buyer’s refund has been started.');
}
