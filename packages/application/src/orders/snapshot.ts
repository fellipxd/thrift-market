import { CONDITION_INFO, DomainError, type ConditionGrade } from '@thrift/domain';
import { many, maybeOne, type Queryable } from '@thrift/database';

/**
 * Immutable record of what the buyer purchased, copied into order_items.snapshot at order creation:
 * the latest published listing version (description, condition, flaws, measurements, photos) plus seller and price.
 * Later listing edits never change it.
 */
export async function buildOrderItemSnapshot(
  db: Queryable,
  args: { listingId: string; unitPriceMinor: number; quantity: number },
): Promise<{ listingVersionId: string | null; snapshot: Record<string, unknown> }> {
  const l = await maybeOne<{
    id: string;
    title: string;
    shop_id: string;
    shop_name: string;
    shop_slug: string;
    sale_mode: string;
    condition: ConditionGrade | null;
    category_name: string;
    [k: string]: unknown;
  }>(
    db,
    `SELECT l.id, l.title, l.shop_id, s.name AS shop_name, s.slug AS shop_slug, l.sale_mode, l.condition, c.name AS category_name
       FROM listings l JOIN shops s ON s.id = l.shop_id JOIN categories c ON c.id = l.category_id WHERE l.id = $1`,
    [args.listingId],
  );
  if (!l) throw new DomainError('NOT_FOUND', 'This item is not available.');
  const version = await maybeOne<{ id: string; version: number; snapshot: Record<string, unknown> }>(
    db,
    `SELECT id, version, snapshot FROM listing_versions WHERE listing_id = $1 ORDER BY version DESC LIMIT 1`,
    [args.listingId],
  );
  // Fallback for safety (published listings always have a version): read current photos/flaws.
  const media = version?.snapshot?.media
    ? (version.snapshot.media as string[])
    : (
        await many<{ storage_key: string }>(
          db,
          `SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = $1 ORDER BY lm.position`,
          [args.listingId],
        )
      ).map((m) => m.storage_key);
  const v = version?.snapshot ?? {};
  const condition = (v.condition as ConditionGrade | undefined) ?? l.condition;
  return {
    listingVersionId: version?.id ?? null,
    snapshot: {
      listingId: l.id,
      listingVersion: version?.version ?? null,
      title: (v.title as string | undefined) ?? l.title,
      description: v.description ?? '',
      categoryName: l.category_name,
      condition,
      conditionLabel: condition ? CONDITION_INFO[condition].label : null,
      flawsDeclaration: v.flawsDeclaration ?? null,
      flaws: v.flaws ?? [],
      sizeSystem: v.sizeSystem ?? null,
      sizeLabel: v.sizeLabel ?? null,
      measurements: v.measurements ?? {},
      attributes: v.attributes ?? {},
      brand: v.brand ?? null,
      colour: v.colour ?? null,
      material: v.material ?? null,
      media,
      saleMode: l.sale_mode,
      unitPriceMinor: args.unitPriceMinor,
      quantity: args.quantity,
      currency: 'NGN',
      shop: { id: l.shop_id, name: l.shop_name, slug: l.shop_slug },
      capturedAt: new Date().toISOString(),
    },
  };
}

/** Latest checkout_terms and buyer_protection policy versions, recorded on every order. */
export async function currentPolicyVersions(db: Queryable): Promise<Record<string, { id: string; version: string; title: string }>> {
  const rows = await many<{ kind: string; id: string; version: string; title: string }>(
    db,
    `SELECT DISTINCT ON (kind) kind, id, version, title FROM policy_versions
      WHERE kind IN ('checkout_terms','buyer_protection','auction_rules') AND effective_at <= now()
      ORDER BY kind, effective_at DESC`,
  );
  return Object.fromEntries(rows.map((r) => [r.kind, { id: r.id, version: r.version, title: r.title }]));
}
