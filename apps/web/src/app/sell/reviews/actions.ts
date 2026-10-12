'use server';

import { replyToReview } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function replyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => replyToReview(ctx, formObject(form)), 'Reply saved.');
}
