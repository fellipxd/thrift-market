'use server';

import { decideVerification } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function decideVerificationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => decideVerification(ctx, formObject(form)), 'Decision recorded and the seller has been notified.');
}
