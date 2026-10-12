'use server';

import { redirect } from 'next/navigation';
import { confirmMfaEnrolment, startMfaEnrolment, verifyMfa } from '@thrift/application';
import { safeNext } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function confirmEnrolmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => confirmMfaEnrolment(ctx, formObject(form)), 'Two-step verification is on.');
}

export async function restartEnrolmentAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  return runAction((ctx) => startMfaEnrolment(ctx, { restart: true }), 'New setup code generated. Scan it again.');
}

export async function verifyMfaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const fields = formObject(form);
  const state = await runAction((ctx) => verifyMfa(ctx, fields));
  if (state.status === 'success') redirect(safeNext(fields.next, '/admin'));
  return state;
}
