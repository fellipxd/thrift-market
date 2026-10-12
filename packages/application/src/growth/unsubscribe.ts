import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@thrift/domain';
import type { AppContext } from '../core/context';
import { NOTIFICATION_TOPICS, type NotificationTopic } from '../notifications/notify';
import type { Channel } from './notifications';

const CHANNELS: Channel[] = ['in_app', 'email', 'sms'];

function sign(secret: string, payload: string): string {
  return createHmac('sha256', `${secret}:unsubscribe`).update(payload).digest('base64url');
}

/** One-click unsubscribe token: HMAC-signed user + topic + channel. Works signed out; never expires (opting out is always allowed). */
export function makeUnsubscribeToken(ctx: AppContext, args: { userId: string; topic: NotificationTopic; channel: Channel }): string {
  const payload = Buffer.from(JSON.stringify([args.userId, args.topic, args.channel])).toString('base64url');
  return `${payload}.${sign(ctx.config.appSecret, payload)}`;
}

export function unsubscribeUrl(ctx: AppContext, args: { userId: string; topic: NotificationTopic; channel: Channel }): string {
  return new URL(`/unsubscribe?token=${encodeURIComponent(makeUnsubscribeToken(ctx, args))}`, ctx.config.baseUrl).toString();
}

function parseToken(ctx: AppContext, token: string): { userId: string; topic: NotificationTopic; channel: Channel } {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || payload.length > 400) throw new DomainError('VALIDATION_FAILED', 'This unsubscribe link is invalid.');
  const expected = sign(ctx.config.appSecret, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError('VALIDATION_FAILED', 'This unsubscribe link is invalid.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'This unsubscribe link is invalid.');
  }
  const [userId, topic, channel] = Array.isArray(parsed) ? parsed : [];
  if (typeof userId !== 'string' || !NOTIFICATION_TOPICS.includes(topic) || !CHANNELS.includes(channel) || topic === 'transactional') {
    throw new DomainError('VALIDATION_FAILED', 'This unsubscribe link is invalid.');
  }
  return { userId, topic, channel };
}

/** Describes what a token would unsubscribe from (for the confirmation page) without changing anything. */
export function describeUnsubscribe(ctx: AppContext, token: string): { topic: NotificationTopic; channel: Channel } {
  const t = parseToken(ctx, token);
  return { topic: t.topic, channel: t.channel };
}

/** Opts the user out of that topic on that channel. Idempotent. */
export async function unsubscribe(ctx: AppContext, token: string): Promise<{ topic: NotificationTopic; channel: Channel }> {
  const t = parseToken(ctx, token);
  await ctx.pool.query(
    `INSERT INTO notification_preferences (user_id, topic, channel, opted_in, consented_at, source, updated_at)
     SELECT $1, $2, $3, false, NULL, 'unsubscribe_link', now() WHERE EXISTS (SELECT 1 FROM users WHERE id = $1)
     ON CONFLICT (user_id, topic, channel) DO UPDATE SET opted_in = false, consented_at = NULL, source = 'unsubscribe_link', updated_at = now()`,
    [t.userId, t.topic, t.channel],
  );
  return { topic: t.topic, channel: t.channel };
}
