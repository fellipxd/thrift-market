'use server';

import { redirect } from 'next/navigation';
import { cancelPendingOrder, retryPayment, startBagCheckout, startCheckout, startCheckoutForReservation, type CheckoutStarted } from '@thrift/application';
import { routes } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';

/** After an order and payment attempt exist, send the buyer to the provider's page (or the order's payment page). */
function goToPayment(started: CheckoutStarted): never {
  redirect(started.authorizationUrl ?? routes.checkout.order(started.orderId));
}

export async function startCheckoutAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const input = formObject(form);
  const state = await runAction((ctx) => (input.reservationId ? startCheckoutForReservation(ctx, input) : startCheckout(ctx, input)));
  if (state.status === 'success') goToPayment(state.data as CheckoutStarted);
  return state;
}

/** Bag checkout: each confirmed piece arrives as an `item` field "listingId:quantity:unitPriceMinor" (what the buyer saw). */
export async function startBagCheckoutAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { item: _item, ...rest } = formObject(form);
  const items = form
    .getAll('item')
    .filter((v): v is string => typeof v === 'string')
    .map((v) => {
      const [listingId, quantity, expectedUnitPriceMinor] = v.split(':');
      return { listingId, quantity, expectedUnitPriceMinor };
    });
  const state = await runAction((ctx) => startBagCheckout(ctx, { ...rest, items }));
  if (state.status === 'success') goToPayment(state.data as CheckoutStarted);
  return state;
}

export async function retryPaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => retryPayment(ctx, formObject(form)));
  if (state.status === 'success') goToPayment(state.data as CheckoutStarted);
  return state;
}

export async function cancelPendingOrderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const input = formObject(form);
  const state = await runAction((ctx) => cancelPendingOrder(ctx, input));
  if (state.status === 'success') redirect(routes.order(input.orderId!));
  return state;
}
