'use server';

import { addDisputeEntry, confirmReturnReceived, decideDispute, staffVerifyDelivery } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function decideDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => decideDispute(ctx, formObject(form)), 'Decision recorded. Both parties have been notified.');
}

export async function staffNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => addDisputeEntry(ctx, formObject(form)), 'Note added.');
}

export async function staffConfirmReturnAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => confirmReturnReceived(ctx, formObject(form)), 'Return confirmed and refund started.');
}

export async function staffVerifyDeliveryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => staffVerifyDelivery(ctx, formObject(form)), 'Delivery verified.');
}
