import { createHash } from 'node:crypto';
import { DomainError } from '@thrift/domain';
import { TIMESTAMP_KEY_RE } from './sql';

/**
 * Opaque keyset cursors: base64url(JSON) holding the last row's sort key(s) and id plus a short hash of the
 * filters and sort it was issued for. Keys are integers or exact UTC timestamp strings, so pages never skip or
 * repeat rows, even when new rows are inserted between requests. A cursor used with different filters is rejected.
 */
export type CursorKeyKind = 'int' | 'ts';

interface CursorPayload {
  v: 1;
  s: string;
  f: string;
  k: (string | number)[];
  i: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stale(): DomainError {
  return new DomainError('VALIDATION_FAILED', 'This results page link is out of date. Start again from the first page.', {
    fieldErrors: { cursor: 'This results page link is out of date. Start again from the first page.' },
  });
}

/** Stable short hash of the filters a cursor belongs to (order-insensitive object keys). */
export function filterHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 12);
}

export function encodeCursor(args: { sort: string; filters: string; keys: (string | number)[]; id: string }): string {
  const payload: CursorPayload = { v: 1, s: args.sort, f: args.filters, k: args.keys, i: args.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string, expect: { sort: string; filters: string; kinds: CursorKeyKind[] }): { keys: (string | number)[]; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw stale();
  }
  const c = parsed as Partial<CursorPayload> | null;
  if (!c || c.v !== 1 || c.s !== expect.sort || c.f !== expect.filters || typeof c.i !== 'string' || !UUID_RE.test(c.i) || !Array.isArray(c.k)) {
    throw stale();
  }
  if (c.k.length !== expect.kinds.length) throw stale();
  expect.kinds.forEach((kind, idx) => {
    const key = c.k![idx];
    if (kind === 'int' && !(typeof key === 'number' && Number.isSafeInteger(key))) throw stale();
    if (kind === 'ts' && !(typeof key === 'string' && TIMESTAMP_KEY_RE.test(key))) throw stale();
  });
  return { keys: c.k, id: c.i };
}
