import { createPool, loadEnvFile, many, one, type Pool } from '@thrift/database';
import { isDomainError } from '@thrift/domain';
import { InMemoryStorage } from '@thrift/providers';
import { createAuction } from '../auctions/commands';
import { searchListings } from '../discovery/search';
import { startCheckout } from '../checkout/checkout';
import type { UserActor } from '../core/context';
import { createServices, DEV_APP_SECRET } from '../core/services';
import { createSession } from '../identity/sessions';
import { hashPassword } from '../identity/passwords';
import { initialiseStock } from '../inventory/authority';

/**
 * T17 load tool (revision-bound scripts for the proposed staging gate in docs/qa/test-plan.md). Not a benchmark:
 * numbers from a laptop or a CI container say nothing about staging capacity.
 *
 *   pnpm --filter @thrift/application load fixtures --listings 100000
 *   pnpm --filter @thrift/application load reads    --base http://localhost:3000 --rate 200 --duration 3600
 *   pnpm --filter @thrift/application load bids     --base http://localhost:3000 --auctions 50 --bidders 200 --rate 50 --duration 300
 *   pnpm --filter @thrift/application load hot-item --buyers 200
 *   pnpm --filter @thrift/application load search   --runs 30      # in-process search timings (text, typos, price-sorted categories)
 *
 * Writes synthetic users, listings and auctions, so it refuses any database not named *_dev, *_e2e, *_load or *_staging.
 */

loadEnvFile();
const args = process.argv.slice(2);
const scenario = args[0] ?? '';
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const flagText = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const TARGETS = { readP95Ms: 500, mutationP95Ms: 1000, errorRate: 0.01 };

// ---------------------------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------------------------

class Stats {
  private readonly groups = new Map<string, { ms: number[]; statuses: Map<string, number> }>();
  record(group: string, ms: number, status: string): void {
    let g = this.groups.get(group);
    if (!g) this.groups.set(group, (g = { ms: [], statuses: new Map() }));
    g.ms.push(ms);
    g.statuses.set(status, (g.statuses.get(status) ?? 0) + 1);
  }
  report(kind: 'read' | 'mutation', expected: (status: string) => boolean): boolean {
    const target = kind === 'read' ? TARGETS.readP95Ms : TARGETS.mutationP95Ms;
    let total = 0;
    let unexpected = 0;
    let worstP95 = 0;
    console.log(`\n${'group'.padEnd(18)} ${'n'.padStart(7)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)}  statuses`);
    for (const [name, g] of [...this.groups.entries()].sort()) {
      const s = [...g.ms].sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
      worstP95 = Math.max(worstP95, q(0.95));
      total += s.length;
      for (const [st, n] of g.statuses) if (!expected(st)) unexpected += n;
      const sts = [...g.statuses.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`${name.padEnd(18)} ${String(s.length).padStart(7)} ${q(0.5).toFixed(0).padStart(7)} ${q(0.95).toFixed(0).padStart(7)} ${q(0.99).toFixed(0).padStart(7)} ${s[s.length - 1]!.toFixed(0).padStart(7)}  ${sts}`);
    }
    const rate = total ? unexpected / total : 0;
    const ok = worstP95 <= target && rate < TARGETS.errorRate;
    console.log(`\nworst p95 ${worstP95.toFixed(0)} ms (target ≤ ${target}); unexpected ${(rate * 100).toFixed(2)}% (target < ${TARGETS.errorRate * 100}%) → ${ok ? 'within' : 'OUTSIDE'} the proposed targets`);
    return ok;
  }
}

/** Open-loop arrivals: starts `rate` requests per second regardless of how slowly earlier ones finish. */
async function openLoop(rate: number, durationS: number, fire: (i: number) => Promise<void>): Promise<{ started: number; seconds: number }> {
  const start = performance.now();
  const inflight = new Set<Promise<void>>();
  let started = 0;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const elapsed = (performance.now() - start) / 1000;
      if (elapsed >= durationS) {
        clearInterval(timer);
        resolve();
        return;
      }
      const due = Math.floor(elapsed * rate) - started;
      for (let k = 0; k < due; k++) {
        const p = fire(started++).catch(() => undefined);
        inflight.add(p);
        void p.finally(() => inflight.delete(p));
      }
    }, 5);
  });
  await Promise.all(inflight);
  return { started, seconds: (performance.now() - start) / 1000 };
}

async function timed(stats: Stats, group: string, run: () => Promise<Response>): Promise<Response | null> {
  const t = performance.now();
  try {
    const res = await run();
    await res.arrayBuffer();
    stats.record(group, performance.now() - t, String(res.status));
    return res;
  } catch (err) {
    stats.record(group, performance.now() - t, (err as Error).name === 'TimeoutError' ? 'timeout' : 'network');
    return null;
  }
}

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

const WORDS = {
  adjective: ['vintage', 'relaxed', 'classic', 'cropped', 'oversized', 'tailored', 'pleated', 'woven', 'embroidered', 'plain', 'striped', 'printed'],
  colour: ['black', 'white', 'cream', 'navy', 'green', 'rust', 'mustard', 'blue', 'brown', 'pink', 'grey', 'red'],
  noun: ['shirt', 'dress', 'jeans', 'jacket', 'skirt', 'trousers', 'sneakers', 'heels', 'bag', 'scarf', 'kaftan', 'cap', 'belt', 'watch', 'blazer', 'tee'],
};

async function syntheticUsers(pool: Pool, n: number, label: string): Promise<{ id: string; token: string; addressId: string; actor: UserActor }[]> {
  const hash = await hashPassword(`load-${Date.now()}-${Math.random()}`);
  const out: { id: string; token: string; addressId: string; actor: UserActor }[] = [];
  for (let i = 0; i < n; i++) {
    const u = await one<{ id: string }>(
      pool,
      `INSERT INTO users (display_name, email, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [`Load ${label} ${i}`, `load_${label}_${Date.now().toString(36)}_${i}@load.invalid`, hash],
    );
    const a = await one<{ id: string }>(
      pool,
      `INSERT INTO addresses (user_id, recipient_name, phone, line1, city, state, is_default) VALUES ($1, 'Load Buyer', '+2348030000000', '1 Load Street', 'Ikeja', 'Lagos', true) RETURNING id`,
      [u.id],
    );
    const s = await createSession(pool, { userId: u.id, now: new Date(), userAgent: 'thrift-load' });
    out.push({
      id: u.id,
      token: s.token,
      addressId: a.id,
      actor: { kind: 'user', userId: u.id, displayName: `Load ${label} ${i}`, contactVerified: true, roles: [], sessionId: s.sessionId, mfaVerified: false },
    });
  }
  return out;
}

async function fixtures(pool: Pool): Promise<void> {
  const n = flag('listings', 10_000);
  const t = performance.now();
  // Copies category/schema from existing active listings so every synthetic piece is a valid, searchable listing.
  const inserted = await many<{ id: string }>(
    pool,
    `WITH src AS (SELECT shop_id, category_id, schema_version_id, size_system, size_label FROM listings WHERE status = 'active' AND sale_mode <> 'auction'),
          srcn AS (SELECT src.*, row_number() OVER () AS rn, count(*) OVER () AS total FROM src)
     INSERT INTO listings (shop_id, category_id, schema_version_id, status, sale_mode, title, description, colour, size_system, size_label,
                           condition, flaws_declaration, flaws_affirmed_at, quantity_mode, price_minor, published_at)
     SELECT s.shop_id, s.category_id, s.schema_version_id, 'active', 'fixed',
            initcap(($2::text[])[1 + floor(random() * array_length($2::text[], 1))::int] || ' ' || ($3::text[])[1 + floor(random() * array_length($3::text[], 1))::int] || ' ' ||
                    ($4::text[])[1 + floor(random() * array_length($4::text[], 1))::int]),
            'Synthetic load-test listing.', ($3::text[])[1 + floor(random() * array_length($3::text[], 1))::int], s.size_system, s.size_label,
            (ARRAY['unworn','excellent','good','worn'])[1 + floor(random() * 4)::int], 'none_known', now(), 'unique',
            (2000 + floor(random() * 48000)::int) * 100, now() - (random() * interval '60 days')
       FROM generate_series(1, $1) g
       JOIN srcn s ON s.rn = 1 + (g % (SELECT max(total) FROM srcn))
     RETURNING id`,
    [n, WORDS.adjective, WORDS.colour, WORDS.noun],
  );
  for (let i = 0; i < inserted.length; i += 1000) {
    const ids = inserted.slice(i, i + 1000).map((r) => r.id);
    await pool.query(
      `INSERT INTO inventory_stock (listing_id, quantity_total, quantity_available) SELECT unnest($1::uuid[]), 1, 1 ON CONFLICT (listing_id) DO NOTHING`,
      [ids],
    );
  }
  await pool.query('ANALYZE listings; ANALYZE inventory_stock');
  console.log(`[load] inserted ${inserted.length} synthetic active listings in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------

async function reads(pool: Pool): Promise<boolean> {
  const base = flagText('base', 'http://localhost:3000');
  const rate = flag('rate', 50);
  const duration = flag('duration', 30);
  const listings = (await many<{ id: string }>(pool, `SELECT id FROM listings WHERE status = 'active' ORDER BY random() LIMIT 2000`)).map((r) => r.id);
  const shops = (await many<{ slug: string }>(pool, `SELECT slug FROM shops WHERE status = 'active'`)).map((r) => r.slug);
  const auctions = (await many<{ id: string }>(pool, `SELECT id FROM auctions WHERE status IN ('live','scheduled') LIMIT 200`)).map((r) => r.id);
  const categories = (await many<{ slug: string }>(pool, `SELECT slug FROM categories WHERE parent_id IS NOT NULL LIMIT 50`)).map((r) => r.slug);
  if (listings.length === 0) throw new Error('No active listings: run the seed (and optionally `load fixtures`) first.');
  const mix: [number, string, () => string][] = [
    [25, 'search:text', () => `/search?q=${encodeURIComponent(`${pick(WORDS.colour)} ${pick(WORDS.noun)}`)}`],
    [15, 'search:filters', () => `/search?category=${pick(categories)}&sort=${pick(['newest', 'price_asc', 'price_desc'])}`],
    [25, 'item', () => `/items/${pick(listings)}`],
    [10, 'home', () => '/'],
    [10, 'shop', () => `/shops/${pick(shops)}`],
    [10, 'auction:poll', () => (auctions.length ? `/api/v1/auctions/${pick(auctions)}` : '/auctions')],
    [5, 'auctions', () => '/auctions'],
  ];
  const weights = mix.reduce((a, [w]) => a + w, 0);
  const stats = new Stats();
  console.log(`[load] reads: ${rate} req/s for ${duration} s against ${base} (${listings.length} listing ids sampled)`);
  const run = await openLoop(rate, duration, async () => {
    let r = Math.random() * weights;
    const entry = mix.find(([w]) => (r -= w) < 0) ?? mix[0]!;
    await timed(stats, entry[1], () => fetch(base + entry[2](), { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'thrift-load' } }));
  });
  console.log(`[load] started ${run.started} requests in ${run.seconds.toFixed(1)} s (${(run.started / run.seconds).toFixed(1)} req/s achieved)`);
  return stats.report('read', (s) => /^[23]\d\d$|^404$/.test(s));
}

async function bids(pool: Pool): Promise<boolean> {
  const base = flagText('base', 'http://localhost:3000');
  const rate = flag('rate', 10);
  const duration = flag('duration', 30);
  const auctionCount = flag('auctions', 10);
  const bidderCount = flag('bidders', 40);
  const svc = createServices({ databaseUrl: process.env.DATABASE_URL!, baseUrl: base, appSecret: process.env.APP_SECRET ?? DEV_APP_SECRET, env: 'development', storage: new InMemoryStorage(), poolMax: 4, applicationName: 'thrift-load' });
  try {
    // Live auctions: copies of a seeded auction piece (with its photos and flaws), scheduled through the real use case.
    const src = await one<{ id: string; owner: string; display_name: string }>(
      pool,
      `SELECT l.id, s.owner_user_id AS owner, u.display_name FROM listings l JOIN shops s ON s.id = l.shop_id JOIN users u ON u.id = s.owner_user_id
        WHERE l.sale_mode = 'auction' AND s.status = 'active' AND EXISTS (SELECT 1 FROM listing_media lm WHERE lm.listing_id = l.id) LIMIT 1`,
    );
    const seller: UserActor = { kind: 'user', userId: src.owner, displayName: src.display_name, contactVerified: true, roles: [], sessionId: null, mfaVerified: false };
    const sellerCtx = svc.context(seller);
    const auctionIds: string[] = [];
    for (let i = 0; i < auctionCount; i++) {
      const copy = await one<{ id: string }>(
        pool,
        `INSERT INTO listings (shop_id, category_id, schema_version_id, status, sale_mode, title, description, brand, colour, material, size_system, size_label,
                               measurements, attributes, condition, flaws_declaration, flaws_affirmed_at, quantity_mode, weight_grams)
         SELECT shop_id, category_id, schema_version_id, 'draft', 'auction', left('Load auction ' || $2 || ' · ' || title, 90), description, brand, colour, material,
                size_system, size_label, measurements, attributes, condition, flaws_declaration, now(), 'unique', weight_grams
           FROM listings WHERE id = $1 RETURNING id`,
        [src.id, i + 1],
      );
      await pool.query(`INSERT INTO listing_media (listing_id, media_id, position, caption, role) SELECT $2, media_id, position, caption, role FROM listing_media WHERE listing_id = $1`, [src.id, copy.id]);
      await pool.query(`INSERT INTO listing_flaws (listing_id, description, location, severity, media_id) SELECT $2, description, location, severity, media_id FROM listing_flaws WHERE listing_id = $1`, [src.id, copy.id]);
      await initialiseStock(pool, copy.id, 1);
      // Ends in 4 hours, written as a WAT (UTC+1) wall-clock time like the seller form.
      const endsAtWat = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 16);
      const a = await createAuction(sellerCtx, { listingId: copy.id, startsAt: 'now', endsAt: endsAtWat, openingPrice: '5000', increment: '100' });
      auctionIds.push(a.auctionId);
    }
    const bidders = await syntheticUsers(pool, bidderCount, 'bidder');
    console.log(`[load] bids: ${auctionIds.length} live auctions, ${bidders.length} bidders, ${rate} bids/s for ${duration} s against ${base}`);
    const next = new Map<string, number>(auctionIds.map((id) => [id, 5000]));
    const stats = new Stats();
    const run = await openLoop(rate, duration, async (i) => {
      const auctionId = pick(auctionIds);
      const bidder = pick(bidders);
      const amount = next.get(auctionId)!;
      const res = await timed(stats, 'bid', () =>
        fetch(`${base}/api/v1/auctions/${auctionId}/bids`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bidder.token}`, 'user-agent': 'thrift-load' },
          body: JSON.stringify({ amount: String(amount), idempotencyKey: `load_${Date.now().toString(36)}_${i}` }),
        }),
      );
      if (res?.status === 200) next.set(auctionId, Math.max(next.get(auctionId)!, amount + 100));
      else if (res && res.status < 500) next.set(auctionId, next.get(auctionId)! + 100);
    });
    console.log(`[load] started ${run.started} bids in ${run.seconds.toFixed(1)} s`);
    // Correctness: per auction, the bid sequence is gap-free (1..n) and accepted amounts rise strictly with it.
    const bad = await many<{ auction_id: string }>(
      pool,
      `SELECT auction_id FROM (
         SELECT auction_id, seq, amount_minor, lag(amount_minor) OVER (PARTITION BY auction_id ORDER BY seq) AS prev,
                row_number() OVER (PARTITION BY auction_id ORDER BY seq) AS rn
           FROM bids WHERE auction_id = ANY($1::uuid[])
       ) b WHERE b.seq <> b.rn OR (b.prev IS NOT NULL AND b.amount_minor <= b.prev) GROUP BY auction_id`,
      [auctionIds],
    );
    const accepted = await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM bids WHERE auction_id = ANY($1::uuid[])', [auctionIds]);
    console.log(`[load] invariant: ${accepted.n} accepted bids; gap-free sequence with strictly rising amounts in every auction → ${bad.length === 0 ? 'holds' : `BROKEN in ${bad.length} auctions`}`);
    // Too-low and rate-limited bids are expected outcomes under contention, not errors.
    return stats.report('mutation', (s) => /^(200|400|409|422|429)$/.test(s)) && bad.length === 0;
  } finally {
    await svc.pool.end();
  }
}

async function hotItem(pool: Pool): Promise<boolean> {
  const buyerCount = flag('buyers', 100);
  const svc = createServices({ databaseUrl: process.env.DATABASE_URL!, baseUrl: 'http://localhost', appSecret: process.env.APP_SECRET ?? DEV_APP_SECRET, env: 'development', storage: new InMemoryStorage(), poolMax: 30, applicationName: 'thrift-load' });
  try {
    const listing = await one<{ id: string }>(
      pool,
      // A shop that delivers nationally, so every synthetic buyer (Lagos) can reach the piece.
      `SELECT l.id FROM listings l JOIN inventory_stock st ON st.listing_id = l.id JOIN shops s ON s.id = l.shop_id
         JOIN delivery_coverage dc ON dc.shop_id = s.id AND dc.scope = 'national' AND dc.offers_seller_arranged
        WHERE l.status = 'active' AND l.sale_mode = 'fixed' AND l.quantity_mode = 'unique' AND st.quantity_available = 1 AND s.status = 'active'
          AND (l.delivery_states IS NULL OR 'Lagos' = ANY(l.delivery_states))
        ORDER BY random() LIMIT 1`,
    );
    const buyers = await syntheticUsers(pool, buyerCount, 'buyer');
    console.log(`[load] hot item: ${buyers.length} buyers check out one unique piece at the same moment (in-process; checkout has no JSON API)`);
    const stats = new Stats();
    await Promise.all(
      buyers.map(async (b, i) => {
        const t = performance.now();
        try {
          await startCheckout(svc.context(b.actor), { listingId: listing.id, addressId: b.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: `load_hot_${Date.now().toString(36)}_${i}` });
          stats.record('checkout', performance.now() - t, 'won');
        } catch (err) {
          stats.record('checkout', performance.now() - t, isDomainError(err) ? err.code : 'error');
        }
      }),
    );
    const orders = await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.listing_id = $1 AND o.status <> 'cancelled'`, [listing.id]);
    const st = await one<{ ok: boolean }>(
      pool,
      `SELECT quantity_total = quantity_available + quantity_reserved + quantity_sold + quantity_withdrawn AND quantity_reserved <= 1 AS ok FROM inventory_stock WHERE listing_id = $1`,
      [listing.id],
    );
    console.log(`[load] invariant: exactly one live order (${orders.n}) and stock balanced (${st.ok}) → ${orders.n === 1 && st.ok ? 'holds' : 'BROKEN'}`);
    return stats.report('mutation', (s) => s === 'won' || s === 'STOCK_CONFLICT' || s === 'RATE_LIMITED') && orders.n === 1 && st.ok;
  } finally {
    await svc.pool.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// Search timings: the application search call in-process (no HTTP), one at a time, so the numbers are query cost only.
// Read-only; run it against a copy of production-like data (staging) for numbers that mean anything.
// ---------------------------------------------------------------------------------------------------------------

async function searchTimings(): Promise<boolean> {
  const svc = createServices({ databaseUrl: process.env.DATABASE_URL!, baseUrl: 'http://localhost', appSecret: process.env.APP_SECRET ?? DEV_APP_SECRET, env: 'development', storage: new InMemoryStorage(), poolMax: 2, applicationName: 'thrift-load' });
  const ctx = svc.context({ kind: 'guest' });
  const runs = flag('runs', 30);
  const category = flagText('category', '');
  const biggest = category || (await one<{ slug: string }>(svc.pool, `SELECT c.slug FROM listings l JOIN categories c ON c.id = l.category_id WHERE l.status = 'active' GROUP BY c.slug ORDER BY count(*) DESC LIMIT 1`)).slug;
  const cases: Record<string, Record<string, string>> = {
    'text: one word': { q: flagText('word', 'shirt') },
    'text: two words': { q: flagText('words', 'black shirt') },
    'text: typo': { q: flagText('typo', 'shrit') },
    'text: no match': { q: 'zzqxvbw' },
    'category newest': { category: biggest },
    'category price asc': { category: biggest, sort: 'price_asc' },
    'category price desc': { category: biggest, sort: 'price_desc' },
    'everything price asc': { sort: 'price_asc' },
  };
  const stats = new Stats();
  try {
    for (const [name, input] of Object.entries(cases)) {
      await searchListings(ctx, input); // warm caches (vocabulary, category tree)
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        const r = await searchListings(ctx, input);
        stats.record(name, performance.now() - t, r.items.length ? 'hits' : 'empty');
        if (i === 0 && r.correctedQuery) console.log(`${name}: "${input.q}" → including results for "${r.correctedQuery}"`);
      }
    }
  } finally {
    await svc.pool.end();
  }
  return stats.report('read', () => true);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const pool = createPool({ connectionString: url, max: 4, application_name: 'thrift-load' });
let ok = true;
try {
  const db = (await one<{ db: string }>(pool, 'SELECT current_database() AS db')).db;
  if (!/(_dev|_e2e|_load|_staging)$/.test(db) || process.env.NODE_ENV === 'production') {
    throw new Error(`Refusing to write load-test data to "${db}" (only *_dev, *_e2e, *_load or *_staging databases).`);
  }
  if (scenario === 'fixtures') await fixtures(pool);
  else if (scenario === 'reads') ok = await reads(pool);
  else if (scenario === 'bids') ok = await bids(pool);
  else if (scenario === 'hot-item') ok = await hotItem(pool);
  else if (scenario === 'search') ok = await searchTimings();
  else {
    console.log('usage: load fixtures|reads|bids|hot-item|search [--base URL] [--rate N] [--duration S] [--listings N] [--auctions N] [--bidders N] [--buyers N]');
    ok = false;
  }
} finally {
  await pool.end();
}
process.exitCode = ok ? 0 : 1;
