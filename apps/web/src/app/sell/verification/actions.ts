'use server';

import { submitVerification } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function submitVerificationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const input = { ...formObject(form), evidenceMediaIds: form.getAll('evidenceMediaIds').map(String).join(',') };
  return runAction((ctx) => submitVerification(ctx, input), 'Submitted. We’ll review your documents and notify you.');
}
