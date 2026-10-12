'use server';

import { submitReport } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function submitReportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => submitReport(ctx, formObject(form)), 'Thanks — our trust & safety team will review this. We may not be able to tell you the outcome.');
}
