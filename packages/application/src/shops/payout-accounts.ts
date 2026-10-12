import { randomBytes } from 'node:crypto';
import { addHours, DomainError, formatWat } from '@thrift/domain';
import { many, maybeOne, one, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireOwnShop, requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { notifyUser } from '../notifications/notify';
import { payoutAccountInput } from './inputs';

/** Common Nigerian banks and their NIBSS/CBN bank codes (for the payout account form). */
export const NIGERIAN_BANKS: readonly { code: string; name: string }[] = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank (FCMB)' },
  { code: '058', name: 'Guaranty Trust Bank (GTBank)' },
  { code: '030', name: 'Heritage Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '50211', name: 'Kuda Microfinance Bank' },
  { code: '50515', name: 'Moniepoint Microfinance Bank' },
  { code: '999992', name: 'OPay' },
  { code: '999991', name: 'PalmPay' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa (UBA)' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
];

function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\(demo\)/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * SANDBOX name check: compares the account name with the seller's profile name and any approved
 * verification legal name. A real provider resolves the account number to the bank's account name first;
 * the sandbox trusts the typed name. A name match alone is never treated as identity verification (D07).
 */
export function sandboxNameMatch(accountName: string, candidates: string[]): boolean {
  const acct = new Set(nameTokens(accountName));
  return candidates.some((c) => {
    const toks = nameTokens(c);
    if (toks.length === 0) return false;
    const overlap = toks.filter((t) => acct.has(t)).length;
    return overlap >= Math.min(2, toks.length);
  });
}

export interface PayoutAccountView {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumberLast4: string;
  accountName: string;
  status: 'pending' | 'verified' | 'rejected' | 'replaced';
  nameMatch: boolean | null;
  usableAfter: string;
  coolingOff: boolean;
  createdAt: string;
  sandbox: boolean;
}

/**
 * Adds the shop's payout account, or replaces the current one. Only the last 4 digits of the account
 * number are stored. A replacement cannot receive payouts until the cooling-off period has passed,
 * the old row is kept as 'replaced', every change is audited and the seller is notified.
 */
export async function addOrReplacePayoutAccount(ctx: AppContext, raw: unknown): Promise<PayoutAccountView> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(payoutAccountInput, raw);
  const bank = NIGERIAN_BANKS.find((b) => b.code === input.bankCode);
  if (!bank) throw new DomainError('VALIDATION_FAILED', 'Choose your bank from the list.', { fieldErrors: { bankCode: 'Choose your bank from the list.' } });
  await enforceRateLimit(ctx.pool, `payout-account:${user.userId}`, 5, 86_400, 'Too many payout account changes today. Contact support if you need help.');
  const shop = await requireOwnShop(ctx.pool, ctx);
  if (shop.status === 'suspended') throw new DomainError('INVALID_STATE', 'This shop is suspended. Contact support.');
  const settings = await getSettings(ctx.pool);
  const last4 = input.accountNumber.slice(-4);
  const names = await many<{ name: string }>(
    ctx.pool,
    `SELECT display_name AS name FROM users WHERE id = $1
     UNION ALL
     SELECT legal_name FROM verification_cases WHERE shop_id = $2 AND status = 'approved'`,
    [user.userId, shop.id],
  );
  const nameMatch = sandboxNameMatch(input.accountName, names.map((n) => n.name));
  return withTransaction(ctx.pool, async (tx) => {
    // Serialise changes per shop.
    await tx.query(`SELECT id FROM shops WHERE id = $1 FOR UPDATE`, [shop.id]);
    const previous = await maybeOne<{ id: string; bank_code: string; account_number_last4: string }>(
      tx,
      `SELECT id, bank_code, account_number_last4 FROM payout_accounts WHERE shop_id = $1 AND status IN ('pending','verified') FOR UPDATE`,
      [shop.id],
    );
    const now = ctx.now();
    const usableAfter = previous ? addHours(now, settings.payout_account_cooling_off_hours) : now;
    if (previous) {
      await tx.query(`UPDATE payout_accounts SET status = 'replaced' WHERE id = $1`, [previous.id]);
    }
    const row = await one<{ id: string; created_at: Date }>(
      tx,
      `INSERT INTO payout_accounts (shop_id, bank_code, bank_name, account_number_last4, account_name, provider_recipient_code, status, name_match, created_by, usable_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at`,
      [
        shop.id,
        bank.code,
        bank.name,
        last4,
        input.accountName,
        `RCP_sandbox_${randomBytes(6).toString('hex')}`,
        nameMatch ? 'verified' : 'pending',
        nameMatch,
        user.userId,
        usableAfter,
      ],
    );
    await recordAudit(tx, ctx, {
      action: previous ? 'payout_account.replaced' : 'payout_account.added',
      targetKind: 'shop',
      targetId: shop.id,
      data: {
        payoutAccountId: row.id,
        previousPayoutAccountId: previous?.id ?? null,
        bankCode: bank.code,
        last4,
        nameMatch,
        usableAfter: usableAfter.toISOString(),
        sandbox: true,
      },
    });
    await notifyUser(tx, {
      userId: user.userId,
      topic: 'transactional',
      kind: 'payout_account_changed',
      title: previous ? 'Your payout account was changed' : 'Payout account added',
      body: previous
        ? `Payouts will go to ${bank.name} ••••${last4} from ${formatWat(usableAfter)}. If you did not make this change, contact support immediately.`
        : `Payouts will go to ${bank.name} ••••${last4}.`,
      link: '/sell/settings',
      dedupeKey: `payout_account:${row.id}`,
    });
    return {
      id: row.id,
      bankCode: bank.code,
      bankName: bank.name,
      accountNumberLast4: last4,
      accountName: input.accountName,
      status: nameMatch ? 'verified' : 'pending',
      nameMatch,
      usableAfter: usableAfter.toISOString(),
      coolingOff: usableAfter.getTime() > now.getTime(),
      createdAt: new Date(row.created_at).toISOString(),
      sandbox: true,
    };
  });
}

/** The shop's current payout account as the seller sees it (last 4 digits only). */
export async function getOwnPayoutAccount(ctx: AppContext): Promise<PayoutAccountView | null> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const r = await maybeOne<{
    id: string;
    bank_code: string;
    bank_name: string;
    account_number_last4: string;
    account_name: string;
    status: PayoutAccountView['status'];
    name_match: boolean | null;
    usable_after: Date;
    created_at: Date;
    provider_recipient_code: string | null;
  }>(
    ctx.pool,
    `SELECT id, bank_code, bank_name, account_number_last4, account_name, status, name_match, usable_after, created_at, provider_recipient_code
       FROM payout_accounts WHERE shop_id = $1 AND status IN ('pending','verified')`,
    [shop.id],
  );
  if (!r) return null;
  return {
    id: r.id,
    bankCode: r.bank_code,
    bankName: r.bank_name,
    accountNumberLast4: r.account_number_last4,
    accountName: r.account_name,
    status: r.status,
    nameMatch: r.name_match,
    usableAfter: new Date(r.usable_after).toISOString(),
    coolingOff: new Date(r.usable_after).getTime() > ctx.now().getTime(),
    createdAt: new Date(r.created_at).toISOString(),
    sandbox: (r.provider_recipient_code ?? '').startsWith('RCP_sandbox'),
  };
}
