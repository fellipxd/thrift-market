'use server';

import { setSaved } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function saveItemAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const saved = form.get('saved') === 'true';
  return runAction((ctx) => setSaved(ctx, formObject(form)), saved ? 'Saved. Find it under Saved.' : 'Removed from Saved.');
}
