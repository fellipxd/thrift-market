import { many, withTransaction } from '@thrift/database';
import type { AppContext } from '../core/context';

/** Sends pending email/SMS messages through the configured sender (sandbox in development). */
export async function sendPendingOutboundMessages(ctx: AppContext, batchSize = 50): Promise<{ sent: number; failed: number }> {
  const batch = await withTransaction(ctx.pool, (tx) =>
    many<{ id: string; channel: 'email' | 'sms'; destination: string; subject: string | null; body: string }>(
      tx,
      `UPDATE outbound_messages SET attempts = attempts + 1
        WHERE id IN (SELECT id FROM outbound_messages WHERE status = 'pending' AND attempts < 5
                      ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, channel, destination, subject, body`,
      [batchSize],
    ),
  );
  let sent = 0;
  let failed = 0;
  for (const m of batch) {
    const res = await ctx.providers.messages.send({ channel: m.channel, destination: m.destination, subject: m.subject, body: m.body }).catch((err: Error) => ({
      status: 'failed' as const,
      providerMessageId: null,
      error: err.message,
    }));
    if (res.status === 'sent') {
      sent++;
      await ctx.pool.query(`UPDATE outbound_messages SET status = 'sent', sent_at = now(), provider = $2 WHERE id = $1`, [m.id, ctx.providers.messages.name]);
    } else {
      failed++;
      await ctx.pool.query(
        `UPDATE outbound_messages SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END, last_error = $2 WHERE id = $1`,
        [m.id, res.error ?? 'send failed'],
      );
    }
  }
  return { sent, failed };
}
