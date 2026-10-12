'use server';

import { decideRefund } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function decideRefundAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => decideRefund(ctx, formObject(form)), 'Decision recorded.');
}
