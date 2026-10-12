import { randomUUID } from 'node:crypto';
import { InMemoryStorage } from '@thrift/providers';
import { loadEnvFile, one, type Pool } from '@thrift/database';
import { createServices, type Services } from '../../src/core/services';
import type { Actor, AppContext, StaffRole, UserActor } from '../../src/core/context';
import { hashPassword } from '../../src/identity/passwords';
import { initialiseStock } from '../../src/inventory/authority';

loadEnvFile();

let services: Services | null = null;

/** Shared services bound to the test database with in-memory object storage. */
export function testServices(): Services {
  if (!services) {
    services = createServices({
      databaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://thrift:thrift@localhost:5432/thrift_test',
      baseUrl: 'http://localhost:3000',
      appSecret: 'test-secret-0123456789abcdef0123456789abcdef',
      env: 'test',
      storage: new InMemoryStorage(),
      poolMax: 40,
      applicationName: 'thrift-test',
    });
  }
  return services;
}

export async function closeTestServices(): Promise<void> {
  if (services) {
    await services.pool.end();
    services = null;
  }
}

export function ctxFor(actor: Actor, now?: () => Date): AppContext {
  return testServices().context(actor, { now, ip: '127.0.0.1' });
}

export function guestCtx(): AppContext {
  return ctxFor({ kind: 'guest' });
}

export function systemCtx(now?: () => Date): AppContext {
  return ctxFor({ kind: 'system', name: 'test' }, now);
}

let seq = 0;
function uniq(): string {
  seq++;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

let passwordHashCache: string | null = null;

export interface TestUser {
  id: string;
  actor: UserActor;
  ctx: AppContext;
  email: string;
}

/** Creates a user directly in the database. Verified by default. */
export async function createUser(opts: { verified?: boolean; roles?: StaffRole[]; name?: string; now?: () => Date } = {}): Promise<TestUser> {
  const pool = testServices().pool;
  passwordHashCache ??= await hashPassword('correct-horse-battery');
  const email = `user_${uniq()}@example.test`;
  const verified = opts.verified ?? true;
  const u = await one<{ id: string }>(
    pool,
    `INSERT INTO users (display_name, email, password_hash, email_verified_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [opts.name ?? 'Test User', email, passwordHashCache, verified ? new Date() : null],
  );
  for (const role of opts.roles ?? []) {
    await pool.query('INSERT INTO role_grants (user_id, role) VALUES ($1, $2)', [u.id, role]);
  }
  const actor: UserActor = {
    kind: 'user',
    userId: u.id,
    displayName: opts.name ?? 'Test User',
    contactVerified: verified,
    roles: opts.roles ?? [],
    sessionId: null,
  };
  return { id: u.id, actor, ctx: ctxFor(actor, opts.now), email };
}

export interface TestShop {
  id: string;
  slug: string;
  owner: TestUser;
}

export async function createShop(opts: { owner?: TestUser; city?: string; state?: string; status?: string; coverage?: 'local' | 'states' | 'national' } = {}): Promise<TestShop> {
  const pool = testServices().pool;
  const owner = opts.owner ?? (await createUser({ name: 'Seller' }));
  const slug = `shop-${uniq()}`.slice(0, 38);
  const s = await one<{ id: string }>(
    pool,
    `INSERT INTO shops (slug, name, owner_user_id, status, city, state, location, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint(7.4, 9.07), 4326)::geography, now()) RETURNING id`,
    [slug, `Shop ${slug}`, owner.id, opts.status ?? 'active', opts.city ?? 'Abuja', opts.state ?? 'FCT'],
  );
  await pool.query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, 'owner')`, [s.id, owner.id]);
  await pool.query(`INSERT INTO delivery_coverage (shop_id, scope, offers_seller_arranged, offers_integrated, offers_pickup) VALUES ($1, $2, true, true, true)`, [
    s.id,
    opts.coverage ?? 'national',
  ]);
  return { id: s.id, slug, owner };
}

/** Ensures a basic category + schema exists and returns their ids. */
export async function ensureCategory(pool: Pool = testServices().pool): Promise<{ categoryId: string; schemaVersionId: string }> {
  const existing = await pool.query<{ id: string; schema_id: string }>(
    `SELECT c.id, v.id AS schema_id FROM categories c JOIN attribute_schema_versions v ON v.category_id = c.id WHERE c.slug = 'test-tops' LIMIT 1`,
  );
  if (existing.rows[0]) return { categoryId: existing.rows[0].id, schemaVersionId: existing.rows[0].schema_id };
  const c = await one<{ id: string }>(pool, `INSERT INTO categories (slug, name, kind) VALUES ('test-tops', 'Tops', 'clothes') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
  const v = await one<{ id: string }>(
    pool,
    `INSERT INTO attribute_schema_versions (category_id, version, schema) VALUES ($1, 1, $2)
     ON CONFLICT (category_id, version) DO UPDATE SET schema = EXCLUDED.schema RETURNING id`,
    [c.id, JSON.stringify({ sizeRequired: true, allowedSizeSystems: ['uk', 'intl_letter'], measurements: [], recommendedPhotoRoles: ['front', 'back'], attributes: [] })],
  );
  return { categoryId: c.id, schemaVersionId: v.id };
}

export interface TestListing {
  id: string;
  shop: TestShop;
  priceMinor: number;
}

/** Creates an active (published) listing with stock directly in the database. */
export async function createListing(opts: {
  shop?: TestShop;
  quantity?: number;
  priceMinor?: number;
  saleMode?: 'fixed' | 'negotiable' | 'auction';
  minOfferMinor?: number | null;
  status?: string;
  title?: string;
} = {}): Promise<TestListing> {
  const pool = testServices().pool;
  const shop = opts.shop ?? (await createShop());
  const { categoryId, schemaVersionId } = await ensureCategory(pool);
  const quantity = opts.quantity ?? 1;
  const priceMinor = opts.priceMinor ?? 850_000;
  const l = await one<{ id: string }>(
    pool,
    `INSERT INTO listings (shop_id, category_id, schema_version_id, status, sale_mode, title, description, size_system, size_label,
                           condition, flaws_declaration, flaws_affirmed_at, quantity_mode, price_minor, min_offer_minor, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'A test item', 'uk', '12', 'good', 'none_known', now(), $7, $8, $9, now()) RETURNING id`,
    [
      shop.id,
      categoryId,
      schemaVersionId,
      opts.status ?? 'active',
      opts.saleMode ?? 'fixed',
      opts.title ?? `Linen shirt ${uniq()}`,
      quantity > 1 ? 'equivalent' : 'unique',
      opts.saleMode === 'auction' ? null : priceMinor,
      opts.minOfferMinor ?? null,
    ],
  );
  await pool.query(
    `INSERT INTO listing_versions (listing_id, version, snapshot) VALUES ($1, 1, jsonb_build_object('title', 'Test item'))`,
    [l.id],
  );
  const client = await pool.connect();
  try {
    await initialiseStock(client, l.id, quantity);
  } finally {
    client.release();
  }
  return { id: l.id, shop, priceMinor };
}

export function newId(): string {
  return randomUUID();
}

export { uniq };
