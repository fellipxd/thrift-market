import { DomainError } from '@thrift/domain';
import { many, maybeOne } from '@thrift/database';
import { SANDBOX_SIGNATURE_HEADER, signSandboxPayload } from '@thrift/providers';
import { recordAudit } from '../core/audit';
import type { AppContext } from '../core/context';
import { applyVerifiedPayment } from './apply';
import { findAttemptByReference } from './attempts';

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  inboxId: string | null;
}

/**
 * Webhook ingress: authenticate the raw body with the provider signature, persist it durably (deduplicated by the
 * provider's event identity) and only then acknowledge. Processing happens after acceptance and is retried by the
 * worker, so a crash after the 200 never loses an event.
 */
export async function ingestPaymentWebhook(
  ctx: AppContext,
  providerName: string,
  rawBody: string,
  headers: Headers | Record<string, string | undefined>,
): Promise<IngestResult> {
  const provider = ctx.providers.payments;
  if (provider.name !== providerName) throw new DomainError('NOT_FOUND', 'Unknown webhook endpoint.');
  if (rawBody.length > 200_000) throw new DomainError('VALIDATION_FAILED', 'Payload too large.');
  if (!provider.verifyWebhookSignature(rawBody, headers)) {
    await recordAudit(ctx.pool, ctx, { action: 'webhook.signature_rejected', targetKind: 'webhook', targetId: providerName, data: { bytes: rawBody.length } });
    return { accepted: false, duplicate: false, inboxId: null };
  }
  let event;
  try {
    event = provider.parseWebhook(rawBody);
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'Malformed webhook payload.');
  }
  const row = await maybeOne<{ id: string }>(
    ctx.pool,
    `INSERT INTO webhook_inbox (provider, dedupe_key, event_type, payload, signature_valid)
     VALUES ($1, $2, $3, $4, true) ON CONFLICT (provider, dedupe_key) DO NOTHING RETURNING id`,
    [providerName, event.dedupeKey, event.type, rawBody],
  );
  return { accepted: true, duplicate: !row, inboxId: row?.id ?? null };
}

/**
 * Processes one inbox row: claim it with a short lease (attempts + next_attempt_at), do the work outside any
 * transaction (provider verification), then mark it processed. Failures back off and dead-letter after 8 attempts.
 */
export async function processWebhookRow(ctx: AppContext, inboxId: string): Promise<'processed' | 'ignored' | 'retry' | 'skipped'> {
  const claimed = await maybeOne<{ id: string; event_type: string; payload: { data?: { reference?: string; transaction_reference?: string } }; attempts: number }>(
    ctx.pool,
    `UPDATE webhook_inbox SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
      WHERE id = (SELECT id FROM webhook_inbox WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED)
      RETURNING id, event_type, payload, attempts`,
    [inboxId],
  );
  if (!claimed) return 'skipped';
  try {
    const reference = claimed.payload?.data?.reference ?? claimed.payload?.data?.transaction_reference ?? null;
    let outcome: 'processed' | 'ignored' = 'ignored';
    if ((claimed.event_type === 'charge.success' || claimed.event_type === 'charge.failed') && reference) {
      // Never trust the payload: re-verify with the provider and apply idempotently.
      if (await findAttemptByReference(ctx.pool, reference)) {
        await applyVerifiedPayment(ctx, reference);
        outcome = 'processed';
      }
    }
    await ctx.pool.query(`UPDATE webhook_inbox SET status = $2, processed_at = now(), last_error = NULL WHERE id = $1`, [claimed.id, outcome]);
    return outcome;
  } catch (err) {
    const dead = claimed.attempts >= 8;
    await ctx.pool.query(
      `UPDATE webhook_inbox SET status = $2, last_error = $3, next_attempt_at = now() + ($4 || ' seconds')::interval WHERE id = $1`,
      [claimed.id, dead ? 'failed' : 'pending', String((err as Error).message ?? err).slice(0, 1000), String(Math.min(3600, 2 ** claimed.attempts * 10))],
    );
    return 'retry';
  }
}

/** Worker: processes due inbox rows (backstop for inline processing). */
export async function processWebhookInbox(ctx: AppContext, batchSize = 50): Promise<{ processed: number }> {
  const due = await many<{ id: string }>(
    ctx.pool,
    `SELECT id FROM webhook_inbox WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY received_at LIMIT $1`,
    [batchSize],
  );
  let processed = 0;
  for (const r of due) if ((await processWebhookRow(ctx, r.id)) === 'processed') processed++;
  return { processed };
}

/**
 * Sandbox only: simulates the buyer completing (or failing) payment on the provider's hosted page. Updates the
 * simulated provider record and delivers a signed webhook through the real ingestion path.
 */
export async function simulateSandboxPayment(
  ctx: AppContext,
  args: { reference: string; outcome: 'succeeded' | 'failed' | 'abandoned' },
  store: { get(reference: string): Promise<{ reference: string; amountMinor: number; currency: string; status: string; transactionId: string } | null>; put(rec: never): Promise<void> },
): Promise<{ delivered: boolean }> {
  if (!ctx.providers.payments.isSandbox || ctx.providers.payments.name !== 'sandbox' || ctx.config.env === 'production') {
    throw new DomainError('NOT_FOUND', 'Not available.');
  }
  const rec = await store.get(args.reference);
  if (!rec) throw new DomainError('NOT_FOUND', 'Unknown payment reference.');
  if (rec.status === 'succeeded') return { delivered: false };
  await store.put({ ...rec, status: args.outcome, paidAt: args.outcome === 'succeeded' ? new Date() : null } as never);
  if (args.outcome === 'abandoned') return { delivered: false };
  const body = JSON.stringify({
    id: `evt_${args.reference}_${args.outcome}`,
    event: args.outcome === 'succeeded' ? 'charge.success' : 'charge.failed',
    data: { reference: args.reference },
  });
  const res = await ingestPaymentWebhook(ctx, 'sandbox', body, { [SANDBOX_SIGNATURE_HEADER]: signSandboxPayload(ctx.config.appSecret, body) });
  if (res.inboxId) await processWebhookRow(ctx, res.inboxId);
  return { delivered: res.accepted };
}
