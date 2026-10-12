import { DEFAULT_SETTINGS, NIGERIAN_STATES, REFERENCE_PLACES, statePlace, type AttributeSchema, type CategoryKind } from '@thrift/domain';
import { sandboxCourierQuote } from '@thrift/providers';
import type { Pool } from '@thrift/database';

const SETTING_DESCRIPTIONS: Record<string, string> = {
  checkout_hold_minutes: 'Draft: minutes a checkout reservation holds stock.',
  payment_grace_minutes: 'Draft: extra minutes a hold waits for an unresolved payment before reconciliation.',
  offer_expiry_hours: 'Draft: hours before an unanswered offer expires.',
  offer_acceptance_hold_minutes: 'Draft: minutes an accepted offer holds stock for the buyer to pay.',
  max_active_reservations_per_buyer: 'Abuse control: concurrent holds per buyer.',
  max_offers_per_thread_per_day: 'Abuse control: offers per negotiation per day.',
  winner_payment_hours: 'Draft: hours an auction winner has to pay.',
  second_chance_hours: 'Draft: hours a runner-up has to accept a second-chance offer.',
  dispute_window_days_after_delivery: 'Draft (D06): days after delivery to open a dispute.',
  seller_response_hours: 'Draft (D06): hours a seller has to respond to a dispute.',
  payout_release_hours_after_confirmation: 'Draft (D06): delay after buyer confirmation before payout eligibility.',
  payout_release_hours_after_courier_delivery: 'Draft (D06/D09): delay after courier-verified delivery (no buyer action) before payout eligibility.',
  payout_account_cooling_off_hours: 'Security: hours before a changed payout account can receive payouts.',
  review_window_days: 'Days after delivery a buyer can review.',
  commission_bps: 'Owner decision D05 pending. Commission in basis points (0 = none).',
  buyer_fee_bps: 'Owner decision D05 pending. Buyer service fee in basis points.',
  buyer_fee_flat_minor: 'Owner decision D05 pending. Flat buyer service fee in kobo.',
  max_upload_bytes: 'Upload size limit in bytes.',
  max_listing_photos: 'Maximum photos per listing.',
};

export async function seedSettings(pool: Pool): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value), SETTING_DESCRIPTIONS[key] ?? ''],
    );
  }
}

const POLICIES = [
  {
    kind: 'checkout_terms',
    version: '2026-10-draft-1',
    title: 'Checkout terms (draft)',
    body: 'Prices, delivery costs and any fees are shown before payment. Adding to a basket does not reserve an item; starting checkout holds it for a short time. Payment is confirmed only when the payment provider verifies it.',
  },
  {
    kind: 'buyer_protection',
    version: '2026-10-draft-1',
    title: 'Payment and delivery protection (draft — not yet in force)',
    body: 'DRAFT pending provider and legal confirmation (decision D04/D06). Sellers are paid after delivery is confirmed by the buyer or verified by a courier and no dispute is open. Seller-reported delivery alone does not release payment.',
  },
  {
    kind: 'auction_rules',
    version: '2026-10-draft-1',
    title: 'Auction rules (draft)',
    body: 'Manual ascending bids. The opening price is the seller’s minimum. Each bid must be at least the current bid plus the stated increment. A valid bid in the final 2 minutes extends the end to 2 minutes after that bid, up to 10 minutes of extension in total. Server time decides validity. The highest valid bid wins and must be paid within 24 hours; a bid is a commitment, not a payment. Sellers cannot bid on their own auctions.',
  },
  {
    kind: 'seller_terms',
    version: '2026-10-draft-1',
    title: 'Seller terms (draft)',
    body: 'List only items you own and can deliver, with real photos and every known flaw described. Counterfeit, stolen and prohibited goods are not allowed. Mark items sold elsewhere promptly.',
  },
  {
    kind: 'promotion_terms',
    version: '2026-10-draft-1',
    title: 'Promotion terms (draft)',
    body: 'Promoted placements are always labelled “Sponsored”. Promotion never buys verification or reputation. If a promoted item sells or becomes unavailable, it leaves the placement; unused days are refunded pro rata (draft policy, D10).',
  },
];

export async function seedPolicies(pool: Pool): Promise<void> {
  for (const p of POLICIES) {
    await pool.query(
      `INSERT INTO policy_versions (kind, version, title, body) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, version) DO NOTHING`,
      [p.kind, p.version, p.title, p.body],
    );
  }
}

export async function seedPlaces(pool: Pool): Promise<void> {
  for (const p of REFERENCE_PLACES) {
    await pool.query(
      `INSERT INTO places (name, state, kind, location, population_rank)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6) ON CONFLICT DO NOTHING`,
      [p.name, p.state, p.kind, p.lng, p.lat, p.rank],
    );
  }
  for (const s of NIGERIAN_STATES) {
    const c = statePlace(s);
    if (!c) continue;
    await pool.query(
      `INSERT INTO places (name, state, kind, location, population_rank)
       VALUES ($1, $1, 'state', ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 0) ON CONFLICT DO NOTHING`,
      [s, c.lng, c.lat],
    );
  }
}

const CLOTHES_SCHEMA: AttributeSchema = {
  sizeRequired: true,
  allowedSizeSystems: ['uk', 'us', 'eu', 'intl_letter', 'waist_inches', 'ng', 'one_size'],
  measurements: [
    { key: 'pit_to_pit_cm', label: 'Pit to pit (cm)', required: false },
    { key: 'length_cm', label: 'Length (cm)', required: false },
    { key: 'waist_cm', label: 'Waist (cm)', required: false },
  ],
  recommendedPhotoRoles: ['front', 'back', 'label', 'detail'],
  attributes: [{ key: 'fit', label: 'Fit', type: 'select', options: ['Slim', 'Regular', 'Relaxed', 'Oversized'], required: false }],
};
const SHOES_SCHEMA: AttributeSchema = {
  sizeRequired: true,
  allowedSizeSystems: ['eu', 'uk', 'us'],
  measurements: [{ key: 'insole_cm', label: 'Insole length (cm)', required: false }],
  recommendedPhotoRoles: ['front', 'sole', 'detail', 'label'],
  attributes: [],
};
const BAGS_SCHEMA: AttributeSchema = {
  sizeRequired: false,
  allowedSizeSystems: ['one_size', 'other'],
  measurements: [
    { key: 'width_cm', label: 'Width (cm)', required: false },
    { key: 'height_cm', label: 'Height (cm)', required: false },
    { key: 'depth_cm', label: 'Depth (cm)', required: false },
  ],
  recommendedPhotoRoles: ['front', 'back', 'lining', 'closure'],
  attributes: [],
};
const ACCESSORIES_SCHEMA: AttributeSchema = {
  sizeRequired: false,
  allowedSizeSystems: ['one_size', 'intl_letter', 'other'],
  measurements: [],
  recommendedPhotoRoles: ['front', 'detail'],
  attributes: [],
};

const SCHEMAS: Record<CategoryKind, AttributeSchema> = {
  clothes: CLOTHES_SCHEMA,
  shoes: SHOES_SCHEMA,
  bags: BAGS_SCHEMA,
  accessories: ACCESSORIES_SCHEMA,
};

export const CATEGORY_TREE: { slug: string; name: string; kind: CategoryKind; children: { slug: string; name: string; restricted?: boolean }[] }[] = [
  {
    slug: 'clothes',
    name: 'Clothes',
    kind: 'clothes',
    children: [
      { slug: 'shirts-tops', name: 'Shirts & tops' },
      { slug: 'dresses', name: 'Dresses' },
      { slug: 'skirts', name: 'Skirts' },
      { slug: 'trousers-jeans', name: 'Trousers & jeans' },
      { slug: 'jackets-coats', name: 'Jackets & coats' },
      { slug: 'traditional-wear', name: 'Traditional wear' },
      { slug: 'activewear', name: 'Activewear' },
      { slug: 'intimates-swimwear', name: 'Intimates & swimwear', restricted: true },
    ],
  },
  {
    slug: 'shoes',
    name: 'Shoes',
    kind: 'shoes',
    children: [
      { slug: 'sneakers', name: 'Sneakers' },
      { slug: 'heels', name: 'Heels' },
      { slug: 'flats-sandals', name: 'Flats & sandals' },
      { slug: 'boots', name: 'Boots' },
      { slug: 'formal-shoes', name: 'Formal shoes' },
    ],
  },
  {
    slug: 'bags',
    name: 'Bags',
    kind: 'bags',
    children: [
      { slug: 'handbags', name: 'Handbags' },
      { slug: 'totes', name: 'Totes' },
      { slug: 'backpacks', name: 'Backpacks' },
      { slug: 'clutches', name: 'Clutches & evening bags' },
    ],
  },
  {
    slug: 'accessories',
    name: 'Accessories',
    kind: 'accessories',
    children: [
      { slug: 'belts', name: 'Belts' },
      { slug: 'jewellery', name: 'Jewellery' },
      { slug: 'watches', name: 'Watches' },
      { slug: 'hats-caps', name: 'Hats & caps' },
      { slug: 'scarves-headwraps', name: 'Scarves & head wraps' },
      { slug: 'sunglasses', name: 'Sunglasses' },
    ],
  },
];

export async function seedCategories(pool: Pool): Promise<Map<string, { categoryId: string; schemaVersionId: string }>> {
  const out = new Map<string, { categoryId: string; schemaVersionId: string }>();
  let order = 0;
  for (const top of CATEGORY_TREE) {
    const parent = await pool.query<{ id: string }>(
      `INSERT INTO categories (slug, name, kind, sort_order) VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [top.slug, top.name, top.kind, order++],
    );
    const parentId = parent.rows[0]!.id;
    const pv = await pool.query<{ id: string }>(
      `INSERT INTO attribute_schema_versions (category_id, version, schema) VALUES ($1, 1, $2)
       ON CONFLICT (category_id, version) DO UPDATE SET schema = attribute_schema_versions.schema RETURNING id`,
      [parentId, JSON.stringify(SCHEMAS[top.kind])],
    );
    out.set(top.slug, { categoryId: parentId, schemaVersionId: pv.rows[0]!.id });
    let childOrder = 0;
    for (const child of top.children) {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO categories (slug, name, kind, parent_id, sort_order, restricted) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [child.slug, child.name, top.kind, parentId, childOrder++, child.restricted ?? false],
      );
      const v = await pool.query<{ id: string }>(
        `INSERT INTO attribute_schema_versions (category_id, version, schema) VALUES ($1, 1, $2)
         ON CONFLICT (category_id, version) DO UPDATE SET schema = attribute_schema_versions.schema RETURNING id`,
        [c.rows[0]!.id, JSON.stringify(SCHEMAS[top.kind])],
      );
      out.set(child.slug, { categoryId: c.rows[0]!.id, schemaVersionId: v.rows[0]!.id });
    }
  }
  return out;
}

export async function seedCourierRoutes(pool: Pool): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  for (const o of NIGERIAN_STATES) {
    for (const d of NIGERIAN_STATES) {
      const q = sandboxCourierQuote(o, d, 1000);
      const i = params.length;
      values.push(`('sandbox_courier', $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6})`);
      params.push(o, d, q.available, q.available ? q.feeMinor : 0, q.transitDaysMin, q.transitDaysMax);
    }
  }
  await pool.query(
    `INSERT INTO courier_routes (provider, origin_state, destination_state, active, base_fee_minor, transit_days_min, transit_days_max)
     VALUES ${values.join(',')} ON CONFLICT (provider, origin_state, destination_state) DO NOTHING`,
    params,
  );
}

export async function seedAdPackages(pool: Pool): Promise<void> {
  // Draft sandbox pricing only — commercial ad pricing is owner decision D05/D10.
  const packages = [
    ['listing-home-3d', 'Listing boost · Home feed · 3 days (draft price)', 'listing', 'home_feed', 3, 150_000],
    ['listing-search-7d', 'Listing boost · Search results · 7 days (draft price)', 'listing', 'search_results', 7, 300_000],
    ['shop-nearby-7d', 'Shop spotlight · Nearby shops · 7 days (draft price)', 'shop', 'nearby', 7, 500_000],
  ] as const;
  for (const [code, name, target, placement, days, price] of packages) {
    await pool.query(
      `INSERT INTO ad_packages (code, name, target_kind, placement, duration_days, price_minor) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING`,
      [code, name, target, placement, days, price],
    );
  }
}
