import { DomainError } from '@thrift/domain';
import { many, maybeOne, type Queryable } from '@thrift/database';

export type LedgerAccount =
  | 'provider_clearing'
  | 'seller_payable'
  | 'platform_commission'
  | 'platform_fees'
  | 'courier_payable'
  | 'refunds_payable'
  | 'ad_revenue'
  | 'suspense';

export type LedgerKind = 'payment_captured' | 'refund_issued' | 'payout_released' | 'payout_reversed' | 'ad_payment' | 'adjustment' | 'late_payment_refund';

export interface LedgerLine {
  account: LedgerAccount;
  /** Positive = debit, negative = credit. */
  amountMinor: number;
  shopId?: string | null;
}

/**
 * Posts a balanced, append-only ledger transaction. Idempotent on idempotencyKey: a repeat returns the existing
 * transaction id without posting again. Zero lines are dropped; the remaining lines must sum to zero
 * (the database enforces the same rule with a deferred trigger).
 */
export async function postLedgerTransaction(
  tx: Queryable,
  args: { kind: LedgerKind; orderId?: string | null; description: string; idempotencyKey: string; createdBy?: string | null; lines: LedgerLine[] },
): Promise<{ transactionId: string; posted: boolean }> {
  const lines = args.lines.filter((l) => l.amountMinor !== 0);
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amountMinor)) throw new DomainError('VALIDATION_FAILED', 'Ledger amounts must be integer minor units');
  }
  const sum = lines.reduce((s, l) => s + l.amountMinor, 0);
  if (sum !== 0) throw new Error(`Unbalanced ledger transaction ${args.idempotencyKey}: sum=${sum}`);
  if (lines.length === 0) throw new Error(`Empty ledger transaction ${args.idempotencyKey}`);
  const inserted = await maybeOne<{ id: string }>(
    tx,
    `INSERT INTO ledger_transactions (kind, order_id, description, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [args.kind, args.orderId ?? null, args.description, args.idempotencyKey, args.createdBy ?? null],
  );
  if (!inserted) {
    const existing = await maybeOne<{ id: string }>(tx, 'SELECT id FROM ledger_transactions WHERE idempotency_key = $1', [args.idempotencyKey]);
    return { transactionId: existing!.id, posted: false };
  }
  for (const l of lines) {
    await tx.query(`INSERT INTO ledger_entries (transaction_id, account, shop_id, amount_minor) VALUES ($1, $2, $3, $4)`, [
      inserted.id,
      l.account,
      l.shopId ?? null,
      l.amountMinor,
    ]);
  }
  return { transactionId: inserted.id, posted: true };
}

export interface LedgerBalance {
  account: LedgerAccount;
  /** Positive = net debit balance, negative = net credit balance. */
  balanceMinor: number;
  entries: number;
}

export async function ledgerBalances(db: Queryable): Promise<LedgerBalance[]> {
  return (
    await many<{ account: LedgerAccount; balance: number; n: number }>(
      db,
      `SELECT account, coalesce(sum(amount_minor), 0)::bigint AS balance, count(*)::int AS n FROM ledger_entries GROUP BY account ORDER BY account`,
    )
  ).map((r) => ({ account: r.account, balanceMinor: r.balance, entries: r.n }));
}

/** Transactions whose entries do not sum to zero (should always be empty — the trigger forbids them). */
export async function unbalancedLedgerTransactions(db: Queryable): Promise<{ transactionId: string; sumMinor: number }[]> {
  return (
    await many<{ id: string; s: number }>(
      db,
      `SELECT transaction_id AS id, sum(amount_minor)::bigint AS s FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_minor) <> 0`,
    )
  ).map((r) => ({ transactionId: r.id, sumMinor: r.s }));
}

/** Net amount the platform currently owes a shop (credit balance of seller_payable), in minor units. */
export async function sellerPayableBalance(db: Queryable, shopId: string): Promise<number> {
  const r = await maybeOne<{ s: number }>(
    db,
    `SELECT coalesce(-sum(amount_minor), 0)::bigint AS s FROM ledger_entries WHERE account = 'seller_payable' AND shop_id = $1`,
    [shopId],
  );
  return r?.s ?? 0;
}
