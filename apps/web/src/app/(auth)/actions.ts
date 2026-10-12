'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { login, register, resendVerificationCode, revokeSession, verifyContact } from '@thrift/application';
import { safeNext, routes } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';
import { services } from '@/server/services';
import { clearSessionCookie, setSessionCookie } from '@/server/session';

export async function signUpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ua = (await headers()).get('user-agent');
  const state = await runAction(async (ctx) => {
    const res = await register(ctx, formObject(form), { userAgent: ua });
    await setSessionCookie(res.token, res.expiresAt);
  });
  if (state.status === 'success') redirect(routes.auth.verify(safeNext(String(form.get('next') ?? ''), '/')));
  return state;
}

export async function signInAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ua = (await headers()).get('user-agent');
  const state = await runAction(async (ctx) => {
    const res = await login(ctx, formObject(form), { userAgent: ua });
    await setSessionCookie(res.token, res.expiresAt);
  });
  if (state.status === 'success') redirect(safeNext(String(form.get('next') ?? ''), '/'));
  return state;
}

export async function verifyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => verifyContact(ctx, formObject(form)));
  if (state.status === 'success') redirect(safeNext(String(form.get('next') ?? ''), '/'));
  return state;
}

export async function resendCodeAction(_prev: ActionState): Promise<ActionState> {
  return runAction((ctx) => resendVerificationCode(ctx), 'A new code is on its way.');
}

export async function signOutAction(): Promise<void> {
  const token = await clearSessionCookie();
  if (token) await revokeSession(services().pool, token);
  redirect('/');
}
