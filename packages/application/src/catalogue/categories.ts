import { z } from 'zod';
import { DomainError, MEDIA_ROLES, SIZE_SYSTEMS, type AttributeSchema, type CategoryKind } from '@thrift/domain';
import { isUniqueViolation, many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireStaff } from '../core/authz';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { boolish, intField, optionalText, optionalUuid, requiredText, uuidField } from './form-fields';
import { attributeSchemaShape, DEFAULT_SCHEMAS, readAttributeSchema } from './schema';

export interface CategoryNode {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  kind: CategoryKind;
  restricted: boolean;
  active: boolean;
  sortOrder: number;
  schemaVersion: number | null;
  schemaVersionId: string | null;
  listingCount?: number;
  children: CategoryNode[];
}

interface CategoryRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name: string;
  kind: CategoryKind;
  restricted: boolean;
  active: boolean;
  sort_order: number;
  schema_version: number | null;
  schema_version_id: string | null;
  listing_count?: number;
  [k: string]: unknown;
}

/** Category tree with each category's current (latest) schema version. Inactive categories are admin-only. */
export async function listCategoryTree(db: Queryable, opts: { includeInactive?: boolean; withCounts?: boolean } = {}): Promise<CategoryNode[]> {
  const rows = await many<CategoryRow>(
    db,
    `SELECT c.id, c.parent_id, c.slug, c.name, c.kind, c.restricted, c.active, c.sort_order,
            v.version AS schema_version, v.id AS schema_version_id
            ${opts.withCounts ? `, (SELECT count(*)::int FROM listings l WHERE l.category_id = c.id AND l.status <> 'removed') AS listing_count` : ''}
       FROM categories c
       LEFT JOIN LATERAL (SELECT id, version FROM attribute_schema_versions WHERE category_id = c.id ORDER BY version DESC LIMIT 1) v ON true
      ${opts.includeInactive ? '' : 'WHERE c.active'}
      ORDER BY c.sort_order, c.name`,
  );
  const nodes = new Map<string, CategoryNode>();
  for (const r of rows) {
    nodes.set(r.id, {
      id: r.id,
      parentId: r.parent_id,
      slug: r.slug,
      name: r.name,
      kind: r.kind,
      restricted: r.restricted,
      active: r.active,
      sortOrder: r.sort_order,
      schemaVersion: r.schema_version,
      schemaVersionId: r.schema_version_id,
      ...(opts.withCounts ? { listingCount: r.listing_count ?? 0 } : {}),
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else if (!n.parentId) roots.push(n);
  }
  return roots;
}

export interface CategoryDetail {
  id: string;
  parentId: string | null;
  parentName: string | null;
  slug: string;
  name: string;
  kind: CategoryKind;
  restricted: boolean;
  active: boolean;
  sortOrder: number;
  isLeaf: boolean;
  schemaVersionId: string;
  schemaVersion: number;
  schema: AttributeSchema;
}

export async function getCategory(db: Queryable, idOrSlug: string): Promise<CategoryDetail> {
  const byId = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  const r = await maybeOne<CategoryRow & { parent_name: string | null; schema: unknown; has_children: boolean }>(
    db,
    `SELECT c.id, c.parent_id, p.name AS parent_name, c.slug, c.name, c.kind, c.restricted, c.active, c.sort_order,
            v.id AS schema_version_id, v.version AS schema_version, v.schema,
            EXISTS (SELECT 1 FROM categories ch WHERE ch.parent_id = c.id AND ch.active) AS has_children
       FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
       LEFT JOIN LATERAL (SELECT id, version, schema FROM attribute_schema_versions WHERE category_id = c.id ORDER BY version DESC LIMIT 1) v ON true
      WHERE ${byId ? 'c.id = $1' : 'c.slug = $1'}`,
    [idOrSlug],
  );
  if (!r || !r.schema_version_id) throw new DomainError('NOT_FOUND', 'Category not found.');
  return {
    id: r.id,
    parentId: r.parent_id,
    parentName: r.parent_name,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    restricted: r.restricted,
    active: r.active,
    sortOrder: r.sort_order,
    isLeaf: !r.has_children,
    schemaVersionId: r.schema_version_id,
    schemaVersion: r.schema_version ?? 1,
    schema: readAttributeSchema(r.schema),
  };
}

export async function getSchemaVersion(db: Queryable, schemaVersionId: string): Promise<{ id: string; categoryId: string; version: number; schema: AttributeSchema }> {
  const r = await maybeOne<{ id: string; category_id: string; version: number; schema: unknown }>(
    db,
    `SELECT id, category_id, version, schema FROM attribute_schema_versions WHERE id = $1`,
    [schemaVersionId],
  );
  if (!r) throw new DomainError('NOT_FOUND', 'Schema version not found.');
  return { id: r.id, categoryId: r.category_id, version: r.version, schema: readAttributeSchema(r.schema) };
}

export interface SchemaVersionSummary {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string | null;
  listingCount: number;
  schema: AttributeSchema;
}

export async function listSchemaVersions(ctx: AppContext, categoryId: string): Promise<SchemaVersionSummary[]> {
  requireStaff(ctx, 'admin');
  if (!/^[0-9a-f-]{36}$/i.test(categoryId)) throw new DomainError('NOT_FOUND', 'Category not found.');
  const rows = await many<{ id: string; version: number; created_at: Date; created_by_name: string | null; listing_count: number; schema: unknown }>(
    ctx.pool,
    `SELECT v.id, v.version, v.created_at, u.display_name AS created_by_name, v.schema,
            (SELECT count(*)::int FROM listings l WHERE l.schema_version_id = v.id AND l.status <> 'removed') AS listing_count
       FROM attribute_schema_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.category_id = $1 ORDER BY v.version DESC`,
    [categoryId],
  );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    createdAt: new Date(r.created_at).toISOString(),
    createdBy: r.created_by_name,
    listingCount: r.listing_count,
    schema: readAttributeSchema(r.schema),
  }));
}

// ---------------------------------------------------------------------------
// Admin mutations (role: admin)
// ---------------------------------------------------------------------------

const KINDS = ['clothes', 'shoes', 'bags', 'accessories'] as const;

const createCategoryInput = z.object({
  name: requiredText('Name', 2, 60),
  slug: optionalText('Slug', 60).refine((v) => v === null || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v), 'Use lowercase letters, numbers and hyphens.'),
  parentId: optionalUuid,
  kind: z.union([z.enum(KINDS), z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
  restricted: boolish,
  sortOrder: z.union([intField('Sort order', 0, 999), z.literal('')]).optional().transform((v) => (typeof v === 'number' ? v : 0)),
});

function categorySlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Creates a category (or subcategory) with schema version 1 copied from its parent or the kind default. */
export async function createCategory(ctx: AppContext, raw: unknown): Promise<{ categoryId: string; slug: string; schemaVersionId: string }> {
  requireStaff(ctx, 'admin');
  const input = parseInput(createCategoryInput, raw);
  const slug = input.slug ?? categorySlug(input.name);
  if (!slug || slug.length < 2) throw new DomainError('VALIDATION_FAILED', 'Add a slug using letters and numbers.', { fieldErrors: { slug: 'Add a slug.' } });
  try {
    return await withTransaction(ctx.pool, async (tx) => {
      let kind: CategoryKind;
      let schema: AttributeSchema;
      if (input.parentId) {
        const parent = await maybeOne<{ id: string; kind: CategoryKind; parent_id: string | null }>(
          tx,
          `SELECT id, kind, parent_id FROM categories WHERE id = $1 FOR UPDATE`,
          [input.parentId],
        );
        if (!parent) throw new DomainError('NOT_FOUND', 'Parent category not found.', { fieldErrors: { parentId: 'Choose a parent category.' } });
        if (parent.parent_id) throw new DomainError('VALIDATION_FAILED', 'Subcategories can only be added to a top-level category.', { fieldErrors: { parentId: 'Choose a top-level category.' } });
        kind = parent.kind;
        const pv = await maybeOne<{ schema: unknown }>(tx, `SELECT schema FROM attribute_schema_versions WHERE category_id = $1 ORDER BY version DESC LIMIT 1`, [parent.id]);
        schema = pv ? readAttributeSchema(pv.schema) : DEFAULT_SCHEMAS[kind];
      } else {
        if (!input.kind) throw new DomainError('VALIDATION_FAILED', 'Choose what kind of items this category holds.', { fieldErrors: { kind: 'Choose a kind.' } });
        kind = input.kind;
        schema = DEFAULT_SCHEMAS[kind];
      }
      const c = await one<{ id: string }>(
        tx,
        `INSERT INTO categories (parent_id, slug, name, kind, sort_order, restricted) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.parentId, slug, input.name, kind, input.sortOrder, input.restricted],
      );
      const user = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
      const v = await one<{ id: string }>(
        tx,
        `INSERT INTO attribute_schema_versions (category_id, version, schema, created_by) VALUES ($1, 1, $2, $3) RETURNING id`,
        [c.id, JSON.stringify(schema), user],
      );
      await recordAudit(tx, ctx, { action: 'category.created', targetKind: 'category', targetId: c.id, data: { slug, parentId: input.parentId, kind, restricted: input.restricted } });
      return { categoryId: c.id, slug, schemaVersionId: v.id };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'categories_slug_key')) {
      throw new DomainError('CONFLICT', 'A category with this slug already exists.', { fieldErrors: { slug: 'Choose a different slug.' } });
    }
    throw err;
  }
}

const updateCategoryInput = z.object({
  categoryId: uuidField('category'),
  name: requiredText('Name', 2, 60),
  restricted: boolish,
  active: boolish,
  sortOrder: z.union([intField('Sort order', 0, 999), z.literal('')]).optional().transform((v) => (typeof v === 'number' ? v : 0)),
});

/** Renames / reorders / restricts / deactivates. Kind and parent are fixed so existing listings stay consistent. */
export async function updateCategory(ctx: AppContext, raw: unknown): Promise<{ categoryId: string }> {
  requireStaff(ctx, 'admin');
  const input = parseInput(updateCategoryInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const c = await maybeOne<{ id: string; name: string; restricted: boolean; active: boolean }>(
      tx,
      `SELECT id, name, restricted, active FROM categories WHERE id = $1 FOR UPDATE`,
      [input.categoryId],
    );
    if (!c) throw new DomainError('NOT_FOUND', 'Category not found.');
    await tx.query(`UPDATE categories SET name = $2, restricted = $3, active = $4, sort_order = $5 WHERE id = $1`, [
      c.id,
      input.name,
      input.restricted,
      input.active,
      input.sortOrder,
    ]);
    await recordAudit(tx, ctx, {
      action: 'category.updated',
      targetKind: 'category',
      targetId: c.id,
      data: { before: { name: c.name, restricted: c.restricted, active: c.active }, after: { name: input.name, restricted: input.restricted, active: input.active } },
    });
    return { categoryId: c.id };
  });
}

const publishSchemaInput = z.object({ categoryId: uuidField('category'), schema: z.unknown() });

/**
 * Publishes schema version N+1. Existing listings keep their own schema_version_id and are always rendered
 * with it; new drafts use the latest version.
 */
export async function publishSchemaVersion(ctx: AppContext, raw: unknown): Promise<{ schemaVersionId: string; version: number }> {
  const staff = requireStaff(ctx, 'admin');
  const input = parseInput(publishSchemaInput, raw);
  const schema = parseInput(attributeSchemaShape, input.schema);
  return withTransaction(ctx.pool, async (tx) => {
    const c = await maybeOne<{ id: string }>(tx, `SELECT id FROM categories WHERE id = $1 FOR UPDATE`, [input.categoryId]);
    if (!c) throw new DomainError('NOT_FOUND', 'Category not found.');
    const cur = await maybeOne<{ version: number; schema: unknown }>(
      tx,
      `SELECT version, schema FROM attribute_schema_versions WHERE category_id = $1 ORDER BY version DESC LIMIT 1`,
      [c.id],
    );
    const normalised: AttributeSchema = {
      sizeRequired: schema.sizeRequired,
      allowedSizeSystems: schema.allowedSizeSystems,
      measurements: schema.measurements,
      recommendedPhotoRoles: schema.recommendedPhotoRoles,
      attributes: schema.attributes.map((a) => ({ ...a, options: a.type === 'select' ? (a.options ?? []) : undefined })),
    };
    if (cur && JSON.stringify(readAttributeSchema(cur.schema)) === JSON.stringify(readAttributeSchema(normalised))) {
      throw new DomainError('VALIDATION_FAILED', 'Nothing changed — the new version would be identical to the current one.');
    }
    const version = (cur?.version ?? 0) + 1;
    const v = await one<{ id: string }>(
      tx,
      `INSERT INTO attribute_schema_versions (category_id, version, schema, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [c.id, version, JSON.stringify(normalised), staff.userId],
    );
    await recordAudit(tx, ctx, { action: 'category.schema_published', targetKind: 'category', targetId: c.id, data: { version, schemaVersionId: v.id } });
    return { schemaVersionId: v.id, version };
  });
}

/** Builds a schema object from the JSON-free admin form (indexed rows + checkboxes). */
export function schemaFromForm(form: Record<string, string | string[]>): unknown {
  const val = (k: string) => {
    const v = form[k];
    return Array.isArray(v) ? v[0] ?? '' : (v ?? '');
  };
  const list = (k: string) => {
    const v = form[k];
    return Array.isArray(v) ? v : v ? [v] : [];
  };
  const on = (k: string) => ['on', 'true', '1'].includes(val(k));
  const measurements: { key: string; label: string; required: boolean }[] = [];
  const attributes: { key: string; label: string; type: 'text' | 'select'; options?: string[]; required: boolean }[] = [];
  for (let i = 0; i < 20; i++) {
    const key = val(`m.${i}.key`).trim();
    const label = val(`m.${i}.label`).trim();
    if (key || label) measurements.push({ key, label, required: on(`m.${i}.required`) });
    const akey = val(`a.${i}.key`).trim();
    const alabel = val(`a.${i}.label`).trim();
    if (akey || alabel) {
      const type = val(`a.${i}.type`) === 'select' ? 'select' : 'text';
      const options = val(`a.${i}.options`)
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      attributes.push({ key: akey, label: alabel, type, ...(type === 'select' ? { options } : {}), required: on(`a.${i}.required`) });
    }
  }
  return {
    sizeRequired: on('sizeRequired'),
    allowedSizeSystems: list('allowedSizeSystems').filter((s) => (SIZE_SYSTEMS as readonly string[]).includes(s)),
    measurements,
    recommendedPhotoRoles: list('recommendedPhotoRoles').filter((s) => (MEDIA_ROLES as readonly string[]).includes(s)),
    attributes,
  };
}
