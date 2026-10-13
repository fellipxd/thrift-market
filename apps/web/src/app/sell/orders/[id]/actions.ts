'use server';

import { cancelOrderBySeller, cancelOrderItemsBySeller } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function sellerCancelAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => cancelOrderBySeller(ctx, formObject(form)), 'Order cancelled. The buyer is being refunded in full.');
}

/** Cancels the ticked pieces (checkboxes named orderItemIds) and refunds them; the rest of the order still ships. */
export async function sellerCancelItemsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderItemIds = form.getAll('orderItemIds').filter((v): v is string => typeof v === 'string');
  const state = await runAction((ctx) => cancelOrderItemsBySeller(ctx, { ...formObject(form), orderItemIds }));
  if (state.status !== 'success') return state;
  const whole = (state.data as { wholeOrder: boolean }).wholeOrder;
  return { ...state, message: whole ? 'Every piece was cancelled, so the whole order is cancelled and refunded.' : 'Pieces cancelled. The buyer is being refunded for them; send the rest as usual.' };
}
