'use server';

import { cancelOrderBySeller } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function sellerCancelAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => cancelOrderBySeller(ctx, formObject(form)), 'Order cancelled. The buyer is being refunded in full.');
}
