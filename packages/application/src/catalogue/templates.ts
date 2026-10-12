import { DomainError, type SaleMode } from '@thrift/domain';
import { many, maybeOne, one } from '@thrift/database';
import { requireOwnShop, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { parseInput } from '../core/validation';
import { getCategory } from './categories';
import { templateIdInput, templateInput } from './inputs';
import { loadOwnListing } from './internal';

/**
 * Reusable listing templates (social-transition tooling): the parts of a listing that repeat across pieces —
 * category, sale mode, title pattern, description boilerplate, brand/material, price, size system,
 * delivery narrowing. Size, measurements, condition, photos and flaws are per piece and never templated.
 */
export interface TemplateData {
  categoryId: string;
  saleMode: SaleMode;
  title: string;
  description: string;
  brand: string | null;
  colour: string | null;
  material: string | null;
  sizeSystem: string | null;
  attributes: Record<string, string>;
  priceMinor: number | null;
  quantityMode: 'unique' | 'equivalent';
  deliveryStates: string[] | null;
  weightGrams: number | null;
}

export interface TemplateSummary {
  id: string;
  name: string;
  categoryName: string | null;
  saleMode: SaleMode;
  priceMinor: number | null;
  createdAt: string;
}

export async function saveAsTemplate(ctx: AppContext, raw: unknown): Promise<{ templateId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(templateInput, raw);
  await enforceRateLimit(ctx.pool, `template-create:${user.userId}`, 60, 3600);
  const l = await loadOwnListing(ctx.pool, ctx, input.listingId);
  const count = await one<{ n: number }>(ctx.pool, `SELECT count(*)::int AS n FROM listing_templates WHERE shop_id = $1`, [l.shop_id]);
  if (count.n >= 50) throw new DomainError('VALIDATION_FAILED', 'You can keep up to 50 templates. Delete one you no longer use.');
  const data: TemplateData = {
    categoryId: l.category_id,
    saleMode: l.sale_mode,
    title: l.title,
    description: l.description,
    brand: l.brand,
    colour: l.colour,
    material: l.material,
    sizeSystem: l.size_system,
    attributes: l.attributes ?? {},
    priceMinor: l.price_minor,
    quantityMode: l.quantity_mode,
    deliveryStates: l.delivery_states,
    weightGrams: l.weight_grams,
  };
  const t = await one<{ id: string }>(ctx.pool, `INSERT INTO listing_templates (shop_id, name, data) VALUES ($1, $2, $3) RETURNING id`, [
    l.shop_id,
    input.name,
    JSON.stringify(data),
  ]);
  return { templateId: t.id };
}

export async function listTemplates(ctx: AppContext): Promise<TemplateSummary[]> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const rows = await many<{ id: string; name: string; data: TemplateData; created_at: Date; category_name: string | null }>(
    ctx.pool,
    `SELECT t.id, t.name, t.data, t.created_at, c.name AS category_name
       FROM listing_templates t LEFT JOIN categories c ON c.id = (t.data->>'categoryId')::uuid
      WHERE t.shop_id = $1 ORDER BY t.created_at DESC`,
    [shop.id],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    categoryName: r.category_name,
    saleMode: r.data.saleMode,
    priceMinor: r.data.priceMinor,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function deleteTemplate(ctx: AppContext, raw: unknown): Promise<{ deleted: boolean }> {
  const input = parseInput(templateIdInput, raw);
  const shop = await requireOwnShop(ctx.pool, ctx);
  const res = await ctx.pool.query(`DELETE FROM listing_templates WHERE id = $1 AND shop_id = $2`, [input.templateId, shop.id]);
  if (!res.rowCount) throw new DomainError('NOT_FOUND', 'Template not found.');
  return { deleted: true };
}

/** New draft from a template. Uses the category's latest schema version; unknown attributes are dropped. */
export async function createFromTemplate(ctx: AppContext, raw: unknown): Promise<{ listingId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(templateIdInput, raw);
  await enforceRateLimit(ctx.pool, `listing-create:${user.userId}`, 300, 3600);
  const shop = await requireOwnShop(ctx.pool, ctx);
  if (shop.status === 'suspended') throw new DomainError('INVALID_STATE', 'This shop is suspended. Contact support.');
  const t = await maybeOne<{ data: TemplateData }>(ctx.pool, `SELECT data FROM listing_templates WHERE id = $1 AND shop_id = $2`, [input.templateId, shop.id]);
  if (!t) throw new DomainError('NOT_FOUND', 'Template not found.');
  const d = t.data;
  let cat;
  try {
    cat = await getCategory(ctx.pool, d.categoryId);
  } catch {
    throw new DomainError('INVALID_STATE', 'The template’s category no longer exists. Start a new listing instead.');
  }
  if (!cat.active) throw new DomainError('INVALID_STATE', 'The template’s category is no longer available. Start a new listing instead.');
  const attributes = Object.fromEntries(Object.entries(d.attributes ?? {}).filter(([k]) => cat.schema.attributes.some((a) => a.key === k)));
  const sizeSystem = d.sizeSystem && cat.schema.allowedSizeSystems.includes(d.sizeSystem as never) ? d.sizeSystem : null;
  const row = await one<{ id: string }>(
    ctx.pool,
    `INSERT INTO listings (shop_id, category_id, schema_version_id, status, sale_mode, title, description, brand, colour, material,
                           size_system, attributes, quantity_mode, initial_quantity, price_minor, delivery_states, weight_grams)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $14, $15) RETURNING id`,
    [
      shop.id,
      cat.id,
      cat.schemaVersionId,
      d.saleMode,
      d.title.slice(0, 90),
      d.description ?? '',
      d.brand,
      d.colour,
      d.material,
      sizeSystem,
      JSON.stringify(attributes),
      d.saleMode === 'auction' ? 'unique' : d.quantityMode,
      d.saleMode === 'auction' ? null : d.priceMinor,
      d.deliveryStates && d.deliveryStates.length > 0 ? d.deliveryStates : null,
      d.weightGrams,
    ],
  );
  return { listingId: row.id };
}
