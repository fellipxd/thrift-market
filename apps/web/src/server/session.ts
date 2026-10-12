import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { resolveSession, SESSION_COOKIE, type Actor, type AppContext, type UserActor } from '@thrift/application';
import { routes } from '@/lib/routes';
import { services } from './services';

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]?.trim() : null) ?? h.get('x-real-ip') ?? null;
}

/** Resolves the signed-in actor once per request. */
export const getActor = cache(async (): Promise<Actor> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const user = await resolveSession(services().pool, token, new Date());
  return user ?? { kind: 'guest' };
});

export const getUser = cache(async (): Promise<UserActor | null> => {
  const actor = await getActor();
  return actor.kind === 'user' ? actor : null;
});

/** Per-request application context for server components, actions and route handlers. */
export const getCtx = cache(async (): Promise<AppContext> => {
  const actor = await getActor();
  const h = await headers();
  return services().context(actor, { ip: await clientIp(), requestId: h.get('x-request-id') ?? undefined });
});

/** For pages that need a signed-in user: redirects to sign-in with a return path. */
export async function requireUserPage(nextPath: string): Promise<UserActor> {
  const user = await getUser();
  if (!user) redirect(routes.auth.signIn(nextPath));
  return user;
}

/** For pages that need a verified contact (messaging, offers, bids, checkout). */
export async function requireVerifiedPage(nextPath: string): Promise<UserActor> {
  const user = await requireUserPage(nextPath);
  if (!user.contactVerified) redirect(routes.auth.verify(nextPath));
  return user;
}

/**
 * For staff console pages (each page checks for itself — layouts and pages render in parallel): non-staff get a
 * 404 with no hint that the console exists; staff without a recent second factor on this session confirm it first.
 */
export async function requireStaffPage(nextPath: string): Promise<UserActor> {
  const user = await requireUserPage(nextPath);
  if (user.roles.length === 0) notFound();
  if (!user.mfaVerified) redirect(routes.verifyMfa(nextPath));
  return user;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  store.delete(SESSION_COOKIE);
  return token;
}
