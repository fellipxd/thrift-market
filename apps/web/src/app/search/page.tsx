import type { Metadata } from 'next';
import Link from 'next/link';
import { discoveryCategories, searchListings, sizeFacets, type SearchResult } from '@thrift/application';
import { SEARCH_SORT_LABEL, SEARCH_SORTS } from '@thrift/contracts';
import { CONDITION_GRADES, CONDITION_INFO, formatNaira, isDomainError, NIGERIAN_STATES, SALE_MODE_LABEL, SALE_MODES, stateLabel } from '@thrift/domain';
import { LocationBar } from '@/components/discovery/LocationBar';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListingGrid } from '@/components/ui/ListingCard';
import { routes } from '@/lib/routes';
import { getLocationPreference } from '@/server/location';
import { recordSponsoredImpressions } from '@/server/promotions';
import { getCtx } from '@/server/session';

type SP = Record<string, string | string[] | undefined>;

export async function generateMetadata({ searchParams }: { searchParams: Promise<SP> }): Promise<Metadata> {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q : '';
  return { title: q ? `“${q}”` : 'Browse' };
}

function list(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.split(',')).filter(Boolean);
}

/** Builds a search URL from current params with changes applied (null removes a key or a single value). */
function href(sp: SP, change: Record<string, string | null>, removeValue?: { key: string; value: string }): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === 'cursor' || v === undefined) continue;
    for (const one of list(v)) {
      if (removeValue && removeValue.key === k && removeValue.value === one) continue;
      q.append(k, one);
    }
  }
  for (const [k, v] of Object.entries(change)) {
    q.delete(k);
    if (v !== null) q.set(k, v);
  }
  const s = q.toString();
  return s ? `/search?${s}` : '/search';
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const location = await getLocationPreference();
  let result: SearchResult | null = null;
  let error: string | null = null;
  try {
    result = await searchListings(ctx, sp);
  } catch (err) {
    if (isDomainError(err) && err.code === 'VALIDATION_FAILED') error = err.message;
    else throw err;
  }
  const [categories, sizes] = await Promise.all([
    discoveryCategories(ctx),
    sizeFacets(ctx, { category: typeof sp.category === 'string' ? sp.category : null }),
    recordSponsoredImpressions('search_results', result?.sponsored.map((i) => i.id) ?? []),
  ]);
  const f = result?.filters;
  const chips: { label: string; href: string }[] = [];
  if (f) {
    if (f.q) chips.push({ label: `“${f.q}”`, href: href(sp, { q: null }) });
    if (f.category) chips.push({ label: f.category.name, href: href(sp, { category: null }) });
    for (const s of f.sizes) chips.push({ label: `Size ${s}`, href: href(sp, {}, { key: 'size', value: s }) });
    for (const c of f.conditions) chips.push({ label: CONDITION_INFO[c].label, href: href(sp, {}, { key: 'condition', value: c }) });
    for (const m of f.saleModes) chips.push({ label: SALE_MODE_LABEL[m], href: href(sp, {}, { key: 'saleMode', value: m }) });
    if (f.minPriceMinor !== null) chips.push({ label: `From ${formatNaira(f.minPriceMinor)}`, href: href(sp, { minPrice: null }) });
    if (f.maxPriceMinor !== null) chips.push({ label: `Up to ${formatNaira(f.maxPriceMinor)}`, href: href(sp, { maxPrice: null }) });
    if (f.shop) chips.push({ label: f.shop.name, href: href(sp, { shop: null }) });
    if (f.deliverTo) chips.push({ label: `Delivers to ${stateLabel(f.deliverTo.state)}`, href: href(sp, { deliverTo: null, city: null }) });
    if (f.near) chips.push({ label: `Near ${f.near.label}${f.radiusKm ? ` (${f.radiusKm} km)` : ''}`, href: href(sp, { near: null, radius: null, lat: null, lng: null }) });
    if (f.verifiedOnly) chips.push({ label: 'Identity-checked sellers', href: href(sp, { verified: null }) });
  }
  const selSizes = list(sp.size);
  const selCond = list(sp.condition);
  const selModes = list(sp.saleMode);

  const filters = (
    <form method="get" action="/search" className="space-y-5">
      {f?.q && <input type="hidden" name="q" value={f.q} />}
      {f?.shop && <input type="hidden" name="shop" value={f.shop.slug} />}
      {typeof sp.sort === 'string' && <input type="hidden" name="sort" value={sp.sort} />}
      <div>
        <label htmlFor="f-category" className="mb-1 block text-sm font-semibold">Category</label>
        <select id="f-category" name="category" defaultValue={typeof sp.category === 'string' ? sp.category : ''} className="w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2">
          <option value="">All categories</option>
          {categories.map((c) => (
            <optgroup key={c.slug} label={c.name}>
              <option value={c.slug}>All {c.name.toLowerCase()}</option>
              {c.children.map((ch) => (
                <option key={ch.slug} value={ch.slug}>{ch.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {sizes.length > 0 && (
        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Size</legend>
          <div className="flex flex-wrap gap-2">
            {sizes.slice(0, 16).map((s) => (
              <label key={s.label} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 text-sm">
                <input type="checkbox" name="size" value={s.label} defaultChecked={selSizes.some((x) => x.toLowerCase() === s.label.toLowerCase())} className="size-4 accent-[var(--color-primary)]" />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-1 text-sm font-semibold">Price (₦)</legend>
        <div className="flex gap-2">
          <label className="flex-1 text-sm"><span className="sr-only">Minimum price</span><input name="minPrice" inputMode="numeric" placeholder="Min" defaultValue={typeof sp.minPrice === 'string' ? sp.minPrice : ''} className="w-full rounded-[var(--radius-control)] border border-line-strong px-3 py-2" /></label>
          <label className="flex-1 text-sm"><span className="sr-only">Maximum price</span><input name="maxPrice" inputMode="numeric" placeholder="Max" defaultValue={typeof sp.maxPrice === 'string' ? sp.maxPrice : ''} className="w-full rounded-[var(--radius-control)] border border-line-strong px-3 py-2" /></label>
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-sm font-semibold">Condition</legend>
        {CONDITION_GRADES.map((c) => (
          <label key={c} className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" name="condition" value={c} defaultChecked={selCond.includes(c)} className="size-4 accent-[var(--color-primary)]" />
            {CONDITION_INFO[c].label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-sm font-semibold">How it’s sold</legend>
        {SALE_MODES.map((m) => (
          <label key={m} className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" name="saleMode" value={m} defaultChecked={selModes.includes(m)} className="size-4 accent-[var(--color-primary)]" />
            {SALE_MODE_LABEL[m]}
          </label>
        ))}
      </fieldset>
      <div>
        <label htmlFor="f-deliver" className="mb-1 block text-sm font-semibold">Delivers to</label>
        <select id="f-deliver" name="deliverTo" defaultValue={typeof sp.deliverTo === 'string' ? sp.deliverTo : ''} className="w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2">
          <option value="">Anywhere</option>
          {location && <option value={location.state}>My location ({stateLabel(location.state)})</option>}
          {NIGERIAN_STATES.map((s) => (
            <option key={s} value={s}>{stateLabel(s)}</option>
          ))}
        </select>
        {location?.city && <input type="hidden" name="city" value={location.city} />}
      </div>
      {location && (
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="near" value={location.placeId} defaultChecked={typeof sp.near === 'string'} className="size-4 accent-[var(--color-primary)]" />
          Only shops near {location.name}
        </label>
      )}
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <input type="checkbox" name="verified" value="1" defaultChecked={sp.verified === '1'} className="size-4 accent-[var(--color-primary)]" />
        Identity-checked sellers only
      </label>
      <div className="flex gap-2">
        <button type="submit" className="min-h-11 flex-1 rounded-[var(--radius-control)] bg-primary px-4 font-semibold text-white">Show results</button>
        <Link href={f?.q ? `/search?q=${encodeURIComponent(f.q)}` : '/search'} className="flex min-h-11 items-center rounded-[var(--radius-control)] px-3 font-semibold text-primary underline">Clear</Link>
      </div>
    </form>
  );

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 xl:px-12">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="display text-[2.25rem] text-ink md:text-5xl">{f?.q ? `Results for “${f.q}”` : f?.category ? f.category.name : 'Browse everything'}</h1>
          {result?.total && (
            <p className="text-sm text-muted" aria-live="polite">
              {result.total.capped ? `${result.total.count}+` : result.total.count} {result.total.count === 1 ? 'piece' : 'pieces'}
            </p>
          )}
          {result?.correctedQuery && (
            <p className="text-sm text-muted">
              Including results for <span className="font-semibold text-ink">“{result.correctedQuery}”</span>
            </p>
          )}
        </div>
        <LocationBar location={location} />
      </div>
      {error && (
        <Alert tone="error" className="mt-4" title="We couldn’t use those filters">
          {error} <Link href="/search" className="font-semibold underline">Start a new search</Link>
        </Alert>
      )}
      <div className="mt-4 lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-8">
        <aside className="hidden lg:block" aria-label="Filters">{filters}</aside>
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <details className="lg:hidden">
              <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-[var(--radius-control)] border-2 border-primary px-4 font-semibold text-primary">
                Filters{chips.length ? ` (${chips.length})` : ''}
              </summary>
              <div className="mt-3 rounded-[var(--radius-card)] border border-line bg-surface p-4">{filters}</div>
            </details>
            <form method="get" action="/search" className="ml-auto flex min-w-0 max-w-full items-center gap-2">
              {Object.entries(sp).flatMap(([k, v]) => (k === 'sort' || k === 'cursor' ? [] : list(v).map((one, i) => <input key={`${k}-${i}`} type="hidden" name={k} value={one} />)))}
              <label htmlFor="sort" className="text-sm text-muted">Sort</label>
              <select id="sort" name="sort" defaultValue={result?.sort ?? 'newest'} className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2 text-sm">
                {SEARCH_SORTS.filter((s) => (s !== 'relevance' || f?.q) && (s !== 'nearest' || f?.near)).map((s) => (
                  <option key={s} value={s}>{SEARCH_SORT_LABEL[s]}</option>
                ))}
              </select>
              <button type="submit" className="min-h-11 shrink-0 rounded-[var(--radius-control)] border border-ink px-3 text-sm font-semibold">Apply</button>
            </form>
          </div>
          {chips.length > 0 && (
            <ul className="mb-4 flex flex-wrap gap-2" aria-label="Active filters">
              {chips.map((c) => (
                <li key={c.label}>
                  <Link href={c.href} className="inline-flex min-h-11 items-center gap-2 border border-ink px-3 text-sm font-medium text-ink hover:bg-ink hover:text-canvas" aria-label={`Remove filter ${c.label}`}>
                    {c.label} <span aria-hidden="true">×</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {result && result.sponsored.length > 0 && (
            <section aria-label="Sponsored" className="mb-6">
              <ListingGrid items={result.sponsored} placement="search_results" />
              <p className="mt-2 text-xs text-muted">Sponsored placements are paid and always labelled. They don’t affect search ranking or seller reputation.</p>
            </section>
          )}
          {result && result.items.length === 0 ? (
            <EmptyState title="No pieces match yet" action={<ButtonLink href="/search" variant="secondary">Clear filters</ButtonLink>}>
              Try fewer filters, a different size, or check another delivery state. New drops arrive daily.
            </EmptyState>
          ) : (
            result && <ListingGrid items={result.items} />
          )}
          {result?.nextCursor && (
            <div className="mt-8 flex justify-center">
              <ButtonLink href={href(sp, { cursor: result.nextCursor })} variant="secondary">Load more</ButtonLink>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
