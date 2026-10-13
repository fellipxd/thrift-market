'use server';

import { redirect } from 'next/navigation';
import { changePassword, confirmMfaEnrolment, revokeMyOtherSessions, revokeMySession, startMfaEnrolment, verifyMfa } from '@thrift/application';
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

export async function changePasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => changePassword(ctx, formObject(form)));
  if (state.status !== 'success') return state;
  const n = (state.data as { otherSessionsSignedOut: number }).otherSessionsSignedOut;
  return { ...state, message: `Password changed.${n > 0 ? ` Signed out ${n} other ${n === 1 ? 'device' : 'devices'}.` : ''}` };
}

export async function revokeSessionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => revokeMySession(ctx, formObject(form)), 'That device is signed out.');
}

export async function revokeOtherSessionsAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => revokeMyOtherSessions(ctx));
  if (state.status !== 'success') return state;
  const n = (state.data as { revoked: number }).revoked;
  return { ...state, message: n === 0 ? 'No other devices were signed in.' : `Signed out ${n} other ${n === 1 ? 'device' : 'devices'}.` };
}
