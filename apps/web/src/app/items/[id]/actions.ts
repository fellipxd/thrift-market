'use server';

import { saveToBag, setSaved } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function saveItemAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const saved = form.get('saved') === 'true';
  return runAction((ctx) => setSaved(ctx, formObject(form)), saved ? 'Saved. Find it under Saved.' : 'Removed from Saved.');
}

export async function addToBagAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => saveToBag(ctx, formObject(form)), 'Added to your bag.');
}
