import Link from 'next/link';
import { nearbyShops, type NearbyResult } from '@thrift/application';
import { MIN_RATING_OPTIONS, RADIUS_OPTIONS } from '@thrift/contracts';
import { isDomainError } from '@thrift/domain';
import { LocationBar } from '@/components/discovery/LocationBar';
import { ShopCard } from '@/components/discovery/ShopCard';
import { UseMyLocationButton } from '@/components/discovery/UseMyLocationButton';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { getLocationPreference } from '@/server/location';
import { recordSponsoredImpressions } from '@/server/promotions';
import { getCtx } from '@/server/session';

export const metadata = { title: 'Nearby shops' };

type SP = Record<string, string | string[] | undefined>;

function nextHref(sp: SP, cursor: string): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && k !== 'cursor') q.set(k, v);
  q.set('cursor', cursor);
  return `/nearby?${q.toString()}`;
}

export default async function NearbyPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const location = await getLocationPreference();
  const input = { ...sp, place: sp.place ?? location?.placeId };
  let res: NearbyResult | null = null;
  let error: string | null = null;
  try {
    res = await nearbyShops(await getCtx(), input);
  } catch (err) {
    if (isDomainError(err) && err.code === 'VALIDATION_FAILED') error = err.message;
    else throw err;
  }
  await recordSponsoredImpressions('nearby', res?.sponsored.map((s) => s.id) ?? []);
  const radius = typeof sp.radius === 'string' ? sp.radius : '25';
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 xl:px-12">
      <PageHeader title="Nearby shops" description="Shops near you, with approximate distances and where they actually deliver. Exact addresses are never shown." />
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <LocationBar location={location} />
        {!location && <UseMyLocationButton />}
      </div>
      {error && <Alert tone="error" className="mb-4">{error} <Link href="/nearby" className="underline">Reset</Link></Alert>}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] bg-surface p-3">
        <label className="text-sm">
          <span className="mb-1 block font-semibold">Distance</span>
          <select name="radius" defaultValue={radius} className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2">
            {RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>{r === 'national' ? 'Anywhere in Nigeria' : `Within ${r} km`}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-semibold">Rating</span>
          <select name="minRating" defaultValue={typeof sp.minRating === 'string' ? sp.minRating : ''} className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2">
            <option value="">Any</option>
            {MIN_RATING_OPTIONS.map((r) => (
              <option key={r} value={r}>{r}+ stars</option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="verified" value="1" defaultChecked={sp.verified === '1'} className="size-4 accent-[var(--color-primary)]" /> Identity-checked only
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="delivers" value="1" defaultChecked={sp.delivers === '1'} className="size-4 accent-[var(--color-primary)]" /> Delivers to me
        </label>
        <button className="min-h-11 rounded-[var(--radius-control)] bg-primary px-4 font-semibold text-white">Update</button>
      </form>
      {res && (
        <>
          <p className="mb-4 text-sm text-muted">
            {res.location ? `Around ${res.location.label}${res.radiusKm ? `, within ${res.radiusKm} km` : ''}` : 'Choose a location to sort by distance. Showing shops across Nigeria.'}
          </p>
          {res.sponsored.length > 0 && (
            <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {res.sponsored.map((s) => (
                <ShopCard key={`sp-${s.id}`} shop={s} sponsoredPlacement="nearby" />
              ))}
            </div>
          )}
          {res.shops.length === 0 ? (
            <EmptyState title="No shops found nearby" action={<ButtonLink href="/nearby?radius=national" variant="secondary">Search all of Nigeria</ButtonLink>}>
              Try a wider distance — many shops deliver nationwide.
            </EmptyState>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {res.shops.map((s) => (
                <ShopCard key={s.id} shop={s} />
              ))}
            </div>
          )}
          {res.nextCursor && (
            <div className="mt-8 flex justify-center">
              <ButtonLink href={nextHref(sp, res.nextCursor)} variant="secondary">More shops</ButtonLink>
            </div>
          )}
          <p className="mt-8 text-xs text-muted">A map view is planned; distances are approximate and based on each shop’s area, never a home address.</p>
        </>
      )}
    </div>
  );
}
