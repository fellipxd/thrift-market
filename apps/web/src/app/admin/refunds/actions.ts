'use server';

import { requestStaffRefund } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function requestStaffRefundAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => requestStaffRefund(ctx, formObject(form)), 'Refund requested. A different finance team member must approve it on the Finance page.');
}
