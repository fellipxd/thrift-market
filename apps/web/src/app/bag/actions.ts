'use server';

import { removeFromBag, saveToBag } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function removeFromBagAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => removeFromBag(ctx, formObject(form)), 'Removed from your bag.');
}

export async function setBagQuantityAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => saveToBag(ctx, formObject(form)), 'Quantity updated.');
}
