'use server';

import { redirect } from 'next/navigation';
import { simulateSandboxPayment } from '@thrift/application';
import { withQuery } from '@/lib/routes';
import { runAction, type ActionState } from '@/server/actions';
import { services } from '@/server/services';
import { sandboxReturnPath } from './return-path';

export async function simulatePaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const reference = String(form.get('reference') ?? '');
  const outcome = String(form.get('outcome') ?? '') as 'succeeded' | 'failed' | 'abandoned';
  if (!['succeeded', 'failed', 'abandoned'].includes(outcome)) return { status: 'error', message: 'Choose an outcome.' };
  const state = await runAction((ctx) => simulateSandboxPayment(ctx, { reference, outcome }, services().sandboxPayments));
  if (state.status === 'success') redirect(withQuery(sandboxReturnPath(String(form.get('returnPath') ?? '')), { reference }));
  return state;
}
