'use server';

import { requestPromotionRefund, reviewPromotion, staffEndPromotion } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function reviewPromotionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const input = formObject(form);
  return runAction((ctx) => reviewPromotion(ctx, input), input.decision === 'approve' ? 'Approved — the promotion is live.' : 'Rejected — the seller is refunded in full.');
}

export async function endPromotionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => staffEndPromotion(ctx, formObject(form)), 'Promotion stopped. The seller was notified.');
}

export async function requestPromotionRefundAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => requestPromotionRefund(ctx, formObject(form)), 'Refund requested — a different finance team member must approve it in Finance.');
}
