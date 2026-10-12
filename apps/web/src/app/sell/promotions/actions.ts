'use server';

import { redirect } from 'next/navigation';
import { bookPromotion, cancelPromotion, payForPromotion, type PromotionPaymentStart } from '@thrift/application';
import { routes } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';

/** Send the seller to the provider's payment page (or back to promotions if the provider call is still uncertain). */
function goToPayment(started: PromotionPaymentStart): never {
  redirect(started.authorizationUrl ?? `${routes.sell.promotions}?payment=uncertain`);
}

export async function bookPromotionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => bookPromotion(ctx, formObject(form)));
  if (state.status === 'success') goToPayment(state.data as PromotionPaymentStart);
  return state;
}

export async function payPromotionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => payForPromotion(ctx, formObject(form)));
  if (state.status === 'success') goToPayment(state.data as PromotionPaymentStart);
  return state;
}

export async function cancelPromotionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => cancelPromotion(ctx, formObject(form)), 'Promotion cancelled. Any payment is refunded in full.');
}
