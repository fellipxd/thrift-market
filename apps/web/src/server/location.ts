import 'server-only';
import { cookies } from 'next/headers';
import { LOCATION_COOKIE, LOCATION_COOKIE_MAX_AGE_SECONDS, parseLocationCookie, serializeLocationCookie, type LocationPreference } from '@thrift/application';

/** The buyer's chosen delivery location (a reference place only — never device coordinates). */
export async function getLocationPreference(): Promise<LocationPreference | null> {
  return parseLocationCookie((await cookies()).get(LOCATION_COOKIE)?.value);
}

export async function setLocationPreference(loc: LocationPreference | null): Promise<void> {
  const store = await cookies();
  if (!loc) {
    store.delete(LOCATION_COOKIE);
    return;
  }
  store.set(LOCATION_COOKIE, serializeLocationCookie(loc), {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: LOCATION_COOKIE_MAX_AGE_SECONDS,
  });
}
