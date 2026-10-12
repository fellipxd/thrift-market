import { addressInput } from '@thrift/contracts';
import { DomainError, isNigerianState } from '@thrift/domain';
import { many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { parseInput } from '../core/validation';

/** Buyer delivery addresses are private. Sellers see a snapshot only after an order is paid. */
export interface AddressView {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  line1: string;
  line2: string | null;
  area: string | null;
  city: string;
  state: string;
  landmark: string | null;
  isDefault: boolean;
}

interface AddressRow {
  id: string;
  label: string;
  recipient_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  area: string | null;
  city: string;
  state: string;
  landmark: string | null;
  is_default: boolean;
  [k: string]: unknown;
}

function toView(r: AddressRow): AddressView {
  return {
    id: r.id,
    label: r.label,
    recipientName: r.recipient_name,
    phone: r.phone,
    line1: r.line1,
    line2: r.line2,
    area: r.area,
    city: r.city,
    state: r.state,
    landmark: r.landmark,
    isDefault: r.is_default,
  };
}

export async function listAddresses(ctx: AppContext): Promise<AddressView[]> {
  const user = requireUser(ctx);
  const rows = await many<AddressRow>(
    ctx.pool,
    `SELECT * FROM addresses WHERE user_id = $1 AND archived_at IS NULL ORDER BY is_default DESC, created_at DESC`,
    [user.userId],
  );
  return rows.map(toView);
}

/** Loads one of the caller's own active addresses (others → NOT_FOUND). */
export async function getOwnAddress(db: Queryable, userId: string, addressId: string): Promise<AddressView> {
  if (!/^[0-9a-f-]{36}$/i.test(addressId)) throw new DomainError('NOT_FOUND', 'Choose one of your delivery addresses.');
  const r = await maybeOne<AddressRow>(db, `SELECT * FROM addresses WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`, [addressId, userId]);
  if (!r) throw new DomainError('NOT_FOUND', 'Choose one of your delivery addresses.', { fieldErrors: { addressId: 'Choose one of your delivery addresses.' } });
  return toView(r);
}

export async function createAddress(ctx: AppContext, raw: unknown): Promise<AddressView> {
  const user = requireUser(ctx);
  const input = parseInput(addressInput, raw);
  if (!isNigerianState(input.state)) throw new DomainError('VALIDATION_FAILED', 'Choose a Nigerian state.', { fieldErrors: { state: 'Choose a state.' } });
  await enforceRateLimit(ctx.pool, `address:${user.userId}`, 30, 3600);
  return withTransaction(ctx.pool, async (tx) => {
    const count = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM addresses WHERE user_id = $1 AND archived_at IS NULL`, [user.userId]);
    if (count.n >= 20) throw new DomainError('VALIDATION_FAILED', 'You can keep up to 20 addresses. Remove one first.');
    const makeDefault = input.isDefault || count.n === 0;
    if (makeDefault) await tx.query(`UPDATE addresses SET is_default = false WHERE user_id = $1`, [user.userId]);
    const r = await one<AddressRow>(
      tx,
      `INSERT INTO addresses (user_id, label, recipient_name, phone, line1, line2, area, city, state, landmark, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [user.userId, input.label, input.recipientName, input.phone, input.line1, input.line2 ?? null, input.area ?? null, input.city, input.state, input.landmark ?? null, makeDefault],
    );
    return toView(r);
  });
}

export async function setDefaultAddress(ctx: AppContext, raw: unknown): Promise<void> {
  const user = requireUser(ctx);
  const addressId = String((raw as { addressId?: unknown })?.addressId ?? '');
  await withTransaction(ctx.pool, async (tx) => {
    await getOwnAddress(tx, user.userId, addressId);
    await tx.query(`UPDATE addresses SET is_default = (id = $2) WHERE user_id = $1`, [user.userId, addressId]);
  });
}

/** Addresses are archived, never deleted, so past order records stay intact (orders keep their own snapshot). */
export async function archiveAddress(ctx: AppContext, raw: unknown): Promise<void> {
  const user = requireUser(ctx);
  const addressId = String((raw as { addressId?: unknown })?.addressId ?? '');
  await withTransaction(ctx.pool, async (tx) => {
    const a = await getOwnAddress(tx, user.userId, addressId);
    await tx.query(`UPDATE addresses SET archived_at = now(), is_default = false WHERE id = $1`, [a.id]);
    if (a.isDefault) {
      await tx.query(
        `UPDATE addresses SET is_default = true WHERE id = (SELECT id FROM addresses WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1)`,
        [user.userId],
      );
    }
  });
}
