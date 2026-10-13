import { DomainError, isDomainError } from '@thrift/domain';
import { maybeOne } from '@thrift/database';
import { requireOwnShop } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { createDraft, updateListing } from './listings';

/**
 * Owned-content import (R24): a seller brings their own existing catalogue in as drafts from a CSV they made
 * (exported from a spreadsheet or another tool they own). Nothing is published: each draft still needs real photos,
 * a flaws declaration and the usual publish checks. No scraping, no stock sync with other channels.
 */

export const IMPORT_COLUMNS = [
  'title',
  'category',
  'sale_mode',
  'price',
  'min_offer',
  'condition',
  'size_system',
  'size',
  'brand',
  'colour',
  'material',
  'description',
  'quantity',
  'weight_grams',
] as const;
export const IMPORT_MAX_ROWS = 200;
export const IMPORT_MAX_BYTES = 1024 * 1024;

export const IMPORT_TEMPLATE_CSV =
  IMPORT_COLUMNS.join(',') +
  '\n' +
  'Relaxed linen shirt,shirts-tops,negotiable,8500,7000,good,intl_letter,M,Unbranded,Natural,Linen,"Breathable relaxed fit. Small mark on left cuff.",1,350\n' +
  'Plain white tees,shirts-tops,fixed,3500,,unworn,intl_letter,M,,White,Cotton,Unworn tees with tags,5,200\n';

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF). Returns rows of raw strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new DomainError('VALIDATION_FAILED', 'The file has a quote that is never closed.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface ImportResult {
  created: { row: number; listingId: string; title: string }[];
  errors: { row: number; title: string | null; message: string }[];
}

function errorText(err: unknown): string {
  if (!isDomainError(err)) return 'Something went wrong with this row.';
  const fields = err.details?.fieldErrors as Record<string, string> | undefined;
  const issues = err.details?.issues as { field: string; message: string }[] | undefined;
  const parts = fields ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`) : issues ? issues.map((i) => `${i.field}: ${i.message}`) : [];
  return parts.length ? `${err.message} (${parts.join('; ')})` : err.message;
}

async function resolveCategory(ctx: AppContext, value: string): Promise<string | null> {
  const v = value.trim();
  if (!v) return null;
  const row = await maybeOne<{ id: string }>(
    ctx.pool,
    `SELECT id FROM categories WHERE active AND (slug = lower($1) OR lower(name) = lower($1)) ORDER BY (slug = lower($1)) DESC LIMIT 1`,
    [v],
  );
  return row?.id ?? null;
}

/** Imports rows as drafts, one at a time; a bad row is reported and never leaves a half-made draft. */
export async function importListingsCsv(ctx: AppContext, args: { csv: string }): Promise<ImportResult> {
  const user = await requireOwnShop(ctx.pool, ctx);
  void user;
  if (Buffer.byteLength(args.csv, 'utf8') > IMPORT_MAX_BYTES) throw new DomainError('VALIDATION_FAILED', 'The file is larger than 1 MB. Split it into smaller files.');
  await enforceRateLimit(ctx.pool, `listing-import:${ctx.actor.kind === 'user' ? ctx.actor.userId : 'x'}`, 10, 3600, 'You have imported several files recently. Try again later.');
  const rows = parseCsv(args.csv);
  if (rows.length < 2) throw new DomainError('VALIDATION_FAILED', 'The file needs a header row and at least one listing row. Download the template to see the columns.');
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const unknown = header.filter((h) => h && !(IMPORT_COLUMNS as readonly string[]).includes(h));
  if (!header.includes('title') || !header.includes('category')) {
    throw new DomainError('VALIDATION_FAILED', 'The header row must include at least "title" and "category". Download the template to see the columns.');
  }
  if (unknown.length) throw new DomainError('VALIDATION_FAILED', `Unknown column(s): ${unknown.join(', ')}. Use the template’s column names.`);
  const body = rows.slice(1);
  if (body.length > IMPORT_MAX_ROWS) throw new DomainError('VALIDATION_FAILED', `At most ${IMPORT_MAX_ROWS} listings per file (this one has ${body.length}).`);

  const result: ImportResult = { created: [], errors: [] };
  for (const [i, cells] of body.entries()) {
    const rowNo = i + 2;
    const get = (col: (typeof IMPORT_COLUMNS)[number]) => {
      const idx = header.indexOf(col);
      return idx >= 0 ? (cells[idx] ?? '').trim() : '';
    };
    const title = get('title') || null;
    const saleMode = get('sale_mode').toLowerCase() || 'fixed';
    if (saleMode === 'auction') {
      result.errors.push({ row: rowNo, title, message: 'Auctions are scheduled from a draft in the seller workspace, not imported.' });
      continue;
    }
    const categoryId = await resolveCategory(ctx, get('category'));
    if (!categoryId) {
      result.errors.push({ row: rowNo, title, message: `Unknown category "${get('category')}". Use a category name or slug from the listing editor.` });
      continue;
    }
    let listingId: string | null = null;
    try {
      listingId = (await createDraft(ctx, { categoryId, saleMode, title: title ?? '' })).listingId;
      const quantity = get('quantity');
      await updateListing(ctx, {
        listingId,
        description: get('description'),
        brand: get('brand'),
        colour: get('colour'),
        material: get('material'),
        sizeSystem: get('size_system'),
        sizeLabel: get('size'),
        condition: get('condition').toLowerCase(),
        price: get('price'),
        ...(saleMode === 'negotiable' ? { minOffer: get('min_offer') } : {}),
        ...(quantity && Number(quantity) > 1 ? { quantityMode: 'equivalent', quantity } : {}),
        ...(get('weight_grams') ? { weightGrams: get('weight_grams') } : {}),
      });
      result.created.push({ row: rowNo, listingId, title: title ?? '' });
    } catch (err) {
      if (listingId) await ctx.pool.query(`DELETE FROM listings WHERE id = $1 AND status = 'draft'`, [listingId]);
      result.errors.push({ row: rowNo, title, message: errorText(err) });
    }
  }
  return result;
}
