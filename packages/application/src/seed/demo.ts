import { randomUUID } from 'node:crypto';
import { processImage } from '@thrift/providers';
import { one, type Pool } from '@thrift/database';
import type { ObjectStorage } from '@thrift/providers';
import { hashPassword } from '../identity/passwords';
import { encryptSecret } from '../identity/totp';
import { illustration, type IllustrationShape } from './illustrations';

/**
 * Demo data for local development and E2E tests. All names, shops and items are ILLUSTRATIVE.
 * Credentials (development only): password "thrift-demo-pass" for every demo account.
 */
export const DEMO_PASSWORD = 'thrift-demo-pass';
/**
 * Development only: demo staff accounts are pre-enrolled in two-step verification with this published secret so
 * local runs and E2E tests can sign in as staff (add it to any authenticator app). Never used outside dev/test.
 */
export const DEMO_MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const DEMO_ACCOUNTS = {
  admin: 'admin@demo.thrift.test',
  finance: 'finance@demo.thrift.test',
  support: 'support@demo.thrift.test',
  buyer: 'buyer@demo.thrift.test',
  buyer2: 'buyer2@demo.thrift.test',
} as const;

interface DemoItem {
  title: string;
  category: string;
  shape: IllustrationShape;
  colour: string;
  priceNaira: number;
  saleMode: 'fixed' | 'negotiable' | 'auction';
  condition: 'unworn' | 'excellent' | 'good' | 'worn';
  sizeSystem: string | null;
  sizeLabel: string | null;
  brand?: string;
  colourName: string;
  material?: string;
  description: string;
  measurements?: Record<string, number>;
  flaws?: { description: string; location: string; severity: 'minor' | 'moderate' | 'major' }[];
  quantity?: number;
  minOfferNaira?: number;
}

interface DemoShop {
  slug: string;
  name: string;
  owner: string;
  ownerEmail: string;
  city: string;
  state: string;
  area: string;
  lat: number;
  lng: number;
  bio: string;
  verified: boolean;
  coverage: { scope: 'local' | 'states' | 'national'; states: string[]; integrated: boolean; pickup: boolean };
  items: DemoItem[];
}

const SHOPS: DemoShop[] = [
  {
    slug: 'abuja-wardrobe',
    name: 'Abuja Wardrobe',
    owner: 'Amina Bello',
    ownerEmail: 'amina@demo.thrift.test',
    city: 'Abuja',
    state: 'FCT',
    area: 'Wuse',
    lat: 9.06,
    lng: 7.47,
    bio: 'Demo shop (illustrative). Hand-picked shirts, dresses and bags. Every flaw photographed.',
    verified: true,
    coverage: { scope: 'national', states: [], integrated: true, pickup: true },
    items: [
      { title: 'Relaxed linen shirt', category: 'shirts-tops', shape: 'shirt', colour: '#E8DCC4', priceNaira: 8500, saleMode: 'negotiable', minOfferNaira: 7000, condition: 'good', sizeSystem: 'intl_letter', sizeLabel: 'M', brand: 'Unbranded', colourName: 'Natural', material: 'Linen', description: 'Breathable relaxed-fit linen shirt. Small mark on left cuff — close-up in photo 3. No missing buttons.', measurements: { pit_to_pit_cm: 56, length_cm: 74 }, flaws: [{ description: 'Small mark on left cuff', location: 'Left cuff', severity: 'minor' }] },
      { title: 'Green midi wrap dress', category: 'dresses', shape: 'dress', colour: '#2F6B55', priceNaira: 14500, saleMode: 'fixed', condition: 'excellent', sizeSystem: 'uk', sizeLabel: '12', colourName: 'Green', material: 'Viscose', description: 'Flowing wrap dress, worn twice. No visible wear.', measurements: { pit_to_pit_cm: 48, length_cm: 118 } },
      { title: 'Vintage leather shoulder bag', category: 'handbags', shape: 'bag', colour: '#7A4A2A', priceNaira: 14000, saleMode: 'auction', condition: 'good', sizeSystem: 'one_size', sizeLabel: 'One size', colourName: 'Brown', material: 'Leather', description: 'Structured vintage shoulder bag. Light scuffs on the base corners, lining intact, zip works smoothly.', measurements: { width_cm: 30, height_cm: 22, depth_cm: 10 }, flaws: [{ description: 'Light scuffs on base corners', location: 'Base', severity: 'minor' }] },
      { title: 'Striped cotton shirt', category: 'shirts-tops', shape: 'shirt', colour: '#9DB4C8', priceNaira: 6000, saleMode: 'fixed', condition: 'excellent', sizeSystem: 'intl_letter', sizeLabel: 'L', colourName: 'Blue stripe', material: 'Cotton', description: 'Crisp striped cotton shirt.', measurements: { pit_to_pit_cm: 60, length_cm: 77 } },
      { title: 'Plain white tees (bundle stock)', category: 'shirts-tops', shape: 'shirt', colour: '#F6F4EF', priceNaira: 3500, saleMode: 'fixed', condition: 'unworn', sizeSystem: 'intl_letter', sizeLabel: 'M', colourName: 'White', material: 'Cotton', description: 'Unworn plain tees, all identical size M with tags. Equivalent units.', quantity: 5, measurements: { pit_to_pit_cm: 52, length_cm: 70 } },
    ],
  },
  {
    slug: 'yaba-vintage-drops',
    name: 'Yaba Vintage Drops',
    owner: 'Tunde Adeyemi',
    ownerEmail: 'tunde@demo.thrift.test',
    city: 'Lagos',
    state: 'Lagos',
    area: 'Yaba',
    lat: 6.51,
    lng: 3.37,
    bio: 'Demo shop (illustrative). Weekly vintage drops — jackets, denim and caps.',
    verified: true,
    coverage: { scope: 'states', states: ['Ogun', 'Oyo', 'FCT'], integrated: true, pickup: true },
    items: [
      { title: 'Denim trucker jacket', category: 'jackets-coats', shape: 'jacket', colour: '#46637F', priceNaira: 18000, saleMode: 'negotiable', minOfferNaira: 15000, condition: 'good', sizeSystem: 'intl_letter', sizeLabel: 'L', brand: 'Levi’s (unverified)', colourName: 'Mid blue', material: 'Denim', description: 'Classic trucker jacket with natural fading. Brand label present; authenticity not verified.', measurements: { pit_to_pit_cm: 58, length_cm: 64 }, flaws: [{ description: 'Fading at the cuffs', location: 'Both cuffs', severity: 'minor' }] },
      { title: 'High-waist mom jeans', category: 'trousers-jeans', shape: 'trousers', colour: '#5C7896', priceNaira: 9500, saleMode: 'fixed', condition: 'excellent', sizeSystem: 'waist_inches', sizeLabel: '28', colourName: 'Light wash', material: 'Denim', description: 'Rigid denim mom jeans.', measurements: { waist_cm: 71, length_cm: 102 } },
      { title: 'Corduroy bucket hat', category: 'hats-caps', shape: 'hat', colour: '#B08A4E', priceNaira: 4000, saleMode: 'fixed', condition: 'unworn', sizeSystem: 'one_size', sizeLabel: 'One size', colourName: 'Mustard', material: 'Corduroy', description: 'Unworn corduroy bucket hat.' },
      { title: 'Retro running sneakers', category: 'sneakers', shape: 'sneaker', colour: '#D9D2C3', priceNaira: 22000, saleMode: 'auction', condition: 'good', sizeSystem: 'eu', sizeLabel: '42', colourName: 'Off-white', material: 'Suede/mesh', description: 'Retro runners with moderate sole wear (photo 4). Clean uppers.', measurements: { insole_cm: 27 }, flaws: [{ description: 'Moderate wear on outer heel', location: 'Soles', severity: 'moderate' }] },
    ],
  },
  {
    slug: 'ph-sole-republic',
    name: 'PH Sole Republic',
    owner: 'Ebi Douglas',
    ownerEmail: 'ebi@demo.thrift.test',
    city: 'Port Harcourt',
    state: 'Rivers',
    area: 'GRA',
    lat: 4.82,
    lng: 7.03,
    bio: 'Demo shop (illustrative). Pre-loved shoes, cleaned and photographed sole-up.',
    verified: false,
    coverage: { scope: 'national', states: [], integrated: true, pickup: false },
    items: [
      { title: 'Black block heels', category: 'heels', shape: 'heel', colour: '#262626', priceNaira: 12000, saleMode: 'fixed', condition: 'good', sizeSystem: 'eu', sizeLabel: '39', colourName: 'Black', material: 'Faux leather', description: 'Comfortable block heels. Small crease on the left toe.', measurements: { insole_cm: 25 }, flaws: [{ description: 'Crease on left toe', location: 'Left toe', severity: 'minor' }] },
      { title: 'White leather sneakers', category: 'sneakers', shape: 'sneaker', colour: '#F2F0EA', priceNaira: 16500, saleMode: 'negotiable', minOfferNaira: 13000, condition: 'excellent', sizeSystem: 'eu', sizeLabel: '44', colourName: 'White', material: 'Leather', description: 'Barely worn leather sneakers, freshly cleaned.', measurements: { insole_cm: 28.5 } },
      { title: 'Woven leather belt', category: 'belts', shape: 'belt', colour: '#6B4426', priceNaira: 3000, saleMode: 'fixed', condition: 'worn', sizeSystem: 'one_size', sizeLabel: 'One size', colourName: 'Tan', material: 'Leather', description: 'Woven belt with visible wear near the buckle holes.', flaws: [{ description: 'Wear near buckle holes', location: 'Strap', severity: 'moderate' }] },
    ],
  },
  {
    slug: 'kano-kaftan-house',
    name: 'Kano Kaftan House',
    owner: 'Musa Abdullahi',
    ownerEmail: 'musa@demo.thrift.test',
    city: 'Kano',
    state: 'Kano',
    area: 'Sabon Gari',
    lat: 12.0,
    lng: 8.53,
    bio: 'Demo shop (illustrative). Traditional wear, scarves and accessories.',
    verified: false,
    coverage: { scope: 'local', states: [], integrated: false, pickup: true },
    items: [
      { title: 'Embroidered kaftan', category: 'traditional-wear', shape: 'dress', colour: '#E7E1D2', priceNaira: 20000, saleMode: 'fixed', condition: 'excellent', sizeSystem: 'intl_letter', sizeLabel: 'XL', colourName: 'Cream', material: 'Cotton', description: 'Hand-embroidered neckline. Worn once for an event.', measurements: { pit_to_pit_cm: 66, length_cm: 140 } },
      { title: 'Silk-blend head wrap', category: 'scarves-headwraps', shape: 'scarf', colour: '#A8442F', priceNaira: 2500, saleMode: 'fixed', condition: 'unworn', sizeSystem: 'one_size', sizeLabel: 'One size', colourName: 'Rust', material: 'Silk blend', description: 'Unworn head wrap.' },
      { title: 'Classic analogue watch', category: 'watches', shape: 'watch', colour: '#3B3B3B', priceNaira: 15000, saleMode: 'negotiable', minOfferNaira: 12000, condition: 'good', sizeSystem: 'one_size', sizeLabel: 'One size', colourName: 'Black', material: 'Steel/leather', description: 'Keeps time. Light scratches on the glass (photo 3). Strap replaced.', flaws: [{ description: 'Light scratches on glass', location: 'Face', severity: 'minor' }] },
    ],
  },
];

async function ensureUser(pool: Pool, email: string, name: string, passwordHash: string): Promise<string> {
  const row = await one<{ id: string }>(
    pool,
    `INSERT INTO users (display_name, email, password_hash, email_verified_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    [name, email, passwordHash],
  );
  await pool.query(
    `INSERT INTO notification_preferences (user_id, topic, channel, opted_in, consented_at, source)
     VALUES ($1, 'transactional', 'in_app', true, now(), 'seed'), ($1, 'messages', 'in_app', true, now(), 'seed')
     ON CONFLICT DO NOTHING`,
    [row.id],
  );
  return row.id;
}

async function storeImage(pool: Pool, storage: ObjectStorage, ownerId: string, buf: Buffer, alt: string): Promise<{ id: string; key: string }> {
  const processed = await processImage(buf, { maxBytes: 10 * 1024 * 1024 });
  const id = randomUUID();
  const key = `listing/seed/${id}.webp`;
  await storage.put(key, processed.main, processed.mime);
  await storage.put(`${key}.thumb`, processed.thumb, processed.mime);
  await pool.query(
    `INSERT INTO media_assets (id, owner_user_id, purpose, storage_key, mime_type, bytes, width, height, sha256, alt_text)
     VALUES ($1, $2, 'listing', $3, $4, $5, $6, $7, $8, $9)`,
    [id, ownerId, key, processed.mime, processed.bytes, processed.width, processed.height, processed.sha256, alt],
  );
  return { id, key };
}

export async function seedDemo(pool: Pool, storage: ObjectStorage, categories: Map<string, { categoryId: string; schemaVersionId: string }>, log: (m: string) => void, opts: { appSecret?: string } = {}): Promise<void> {
  const existing = await pool.query(`SELECT 1 FROM shops WHERE slug = 'abuja-wardrobe'`);
  if (existing.rowCount) {
    log('demo data already present; skipping');
    return;
  }
  const pw = await hashPassword(DEMO_PASSWORD);
  const adminId = await ensureUser(pool, DEMO_ACCOUNTS.admin, 'Ada Admin (demo)', pw);
  const financeId = await ensureUser(pool, DEMO_ACCOUNTS.finance, 'Femi Finance (demo)', pw);
  const supportId = await ensureUser(pool, DEMO_ACCOUNTS.support, 'Sade Support (demo)', pw);
  await ensureUser(pool, DEMO_ACCOUNTS.buyer, 'Bola Buyer (demo)', pw);
  await ensureUser(pool, DEMO_ACCOUNTS.buyer2, 'Chidi Buyer (demo)', pw);
  if (opts.appSecret && process.env.NODE_ENV !== 'production') {
    const encrypted = encryptSecret(opts.appSecret, DEMO_MFA_SECRET);
    await pool.query(`UPDATE users SET mfa_secret = $2, mfa_enabled_at = now() WHERE id = ANY($1::uuid[])`, [[adminId, financeId, supportId], encrypted]);
  }
  for (const [uid, roles] of [
    [adminId, ['admin', 'trust_safety']],
    [financeId, ['finance']],
    [supportId, ['support']],
  ] as const) {
    for (const role of roles) {
      await pool.query(`INSERT INTO role_grants (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [uid, role]);
    }
  }

  const auctionPolicy = await pool.query<{ id: string }>(`SELECT id FROM policy_versions WHERE kind = 'auction_rules' ORDER BY effective_at DESC LIMIT 1`);
  let auctionIndex = 0;
  for (const s of SHOPS) {
    const ownerId = await ensureUser(pool, s.ownerEmail, `${s.owner} (demo)`, pw);
    const shop = await one<{ id: string }>(
      pool,
      `INSERT INTO shops (slug, name, bio, owner_user_id, status, city, state, area, location, location_precision, returns_policy, dispatch_days,
                          verification_status, verified_at, verification_label, published_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography, 'area',
               'Returns accepted for undisclosed defects reported within 3 days of delivery.', 2, $10, $11, $12, now() - interval '60 days')
       RETURNING id`,
      [
        s.slug, s.name, s.bio, ownerId, s.city, s.state, s.area, s.lng, s.lat,
        s.verified ? 'approved' : 'unverified',
        s.verified ? new Date(Date.now() - 20 * 86_400_000) : null,
        s.verified ? 'Identity checked (demo record)' : null,
      ],
    );
    await pool.query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, 'owner')`, [shop.id, ownerId]);
    await pool.query(
      `INSERT INTO delivery_coverage (shop_id, scope, states, offers_pickup, offers_seller_arranged, offers_integrated)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [shop.id, s.coverage.scope, s.coverage.states, s.coverage.pickup, s.coverage.integrated],
    );
    await pool.query(
      `INSERT INTO payout_accounts (shop_id, bank_code, bank_name, account_number_last4, account_name, provider_recipient_code, status, name_match, created_by)
       VALUES ($1, '058', 'Sandbox Bank', '4321', $2, $3, 'verified', true, $4)`,
      [shop.id, `${s.owner} (demo)`, `RCP_sandbox_${s.slug}`, ownerId],
    );
    if (s.verified) {
      await pool.query(
        `INSERT INTO verification_cases (shop_id, kind, status, legal_name, id_type, id_number_last4, submitted_by, decided_by, decided_at, decision_reason)
         VALUES ($1, 'identity', 'approved', $2, 'nin', '0000', $3, $4, now() - interval '20 days', 'Demo record: identity documents matched account holder.')`,
        [shop.id, s.owner, ownerId, adminId],
      );
    }
    const batch = await one<{ id: string }>(pool, `INSERT INTO batches (shop_id, name, note) VALUES ($1, 'October drop', 'Demo batch') RETURNING id`, [shop.id]);
    let idx = 0;
    for (const item of s.items) {
      const cat = categories.get(item.category);
      if (!cat) throw new Error(`Unknown category ${item.category}`);
      const quantity = item.quantity ?? 1;
      const listing = await one<{ id: string }>(
        pool,
        `INSERT INTO listings (shop_id, category_id, schema_version_id, batch_id, status, sale_mode, title, description, brand, colour, material,
                               size_system, size_label, measurements, condition, flaws_declaration, flaws_affirmed_at, quantity_mode,
                               price_minor, min_offer_minor, weight_grams, published_at, created_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), $16, $17, $18, 800,
                 now() - ($19 || ' hours')::interval, now() - ($19 || ' hours')::interval)
         RETURNING id`,
        [
          shop.id, cat.categoryId, cat.schemaVersionId, batch.id, item.saleMode, item.title, item.description, item.brand ?? null,
          item.colourName, item.material ?? null, item.sizeSystem, item.sizeLabel, JSON.stringify(item.measurements ?? {}), item.condition,
          item.flaws?.length ? 'described' : 'none_known', quantity > 1 ? 'equivalent' : 'unique',
          item.saleMode === 'auction' ? null : item.priceNaira * 100, item.minOfferNaira ? item.minOfferNaira * 100 : null, String(idx * 7 + 2),
        ],
      );
      const photoCount = 3 + (item.flaws?.length ? 1 : 0);
      const media: { id: string; key: string }[] = [];
      for (let p = 0; p < photoCount; p++) {
        const img = await illustration(item.shape, item.colour, p);
        media.push(await storeImage(pool, storage, ownerId, img, `${item.title} — illustrative photo ${p + 1}`));
      }
      const roles = ['front', 'back', 'detail', 'flaw'];
      for (const [pos, m] of media.entries()) {
        await pool.query(`INSERT INTO listing_media (listing_id, media_id, position, role) VALUES ($1, $2, $3, $4)`, [listing.id, m.id, pos, roles[pos] ?? 'general']);
      }
      for (const f of item.flaws ?? []) {
        await pool.query(
          `INSERT INTO listing_flaws (listing_id, description, location, severity, media_id) VALUES ($1, $2, $3, $4, $5)`,
          [listing.id, f.description, f.location, f.severity, media[media.length - 1]!.id],
        );
      }
      await pool.query(`INSERT INTO inventory_stock (listing_id, quantity_total, quantity_available) VALUES ($1, $2, $2)`, [listing.id, quantity]);
      await pool.query(`INSERT INTO inventory_movements (listing_id, kind, quantity, reason) VALUES ($1, 'stock_in', $2, 'seed')`, [listing.id, quantity]);
      const snapshot = {
        title: item.title,
        description: item.description,
        condition: item.condition,
        sizeSystem: item.sizeSystem,
        sizeLabel: item.sizeLabel,
        measurements: item.measurements ?? {},
        flaws: item.flaws ?? [],
        priceMinor: item.saleMode === 'auction' ? null : item.priceNaira * 100,
        saleMode: item.saleMode,
        media: media.map((m) => m.key),
      };
      await pool.query(`INSERT INTO listing_versions (listing_id, version, snapshot) VALUES ($1, 1, $2)`, [listing.id, JSON.stringify(snapshot)]);
      if (item.saleMode === 'auction') {
        const live = auctionIndex++ === 0;
        const startsAt = live ? new Date(Date.now() - 3_600_000) : new Date(Date.now() + 86_400_000);
        const endsAt = live ? new Date(Date.now() + 3 * 3_600_000) : new Date(Date.now() + 2 * 86_400_000);
        await pool.query(
          `INSERT INTO auctions (listing_id, shop_id, status, starts_at, ends_at, original_ends_at, opening_price_minor, increment_minor, policy_version_id)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
          [listing.id, shop.id, live ? 'live' : 'scheduled', startsAt, endsAt, item.priceNaira * 100, 50_000, auctionPolicy.rows[0]?.id ?? null],
        );
      }
      idx++;
    }
    log(`shop ${s.name}: ${s.items.length} listings`);
  }
}
