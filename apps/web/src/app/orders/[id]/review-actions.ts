'use server';

import { submitReview } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function submitReviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => submitReview(ctx, formObject(form)), 'Thanks for your review.');
}
