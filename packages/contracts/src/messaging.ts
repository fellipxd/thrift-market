import { z } from 'zod';
import { uuid } from './common';

export const MESSAGE_MAX_LENGTH = 2000;

/** Client-generated key that makes a message send safe to retry (one message per key). */
export const messageClientKey = z
  .string({ message: 'Missing request key. Refresh the page and try again.' })
  .min(8, 'Missing request key. Refresh the page and try again.')
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid request key. Refresh the page and try again.');

const optionalId = z.preprocess((v) => (v === '' || v === undefined ? null : v), uuid.nullable());

export const startConversationInput = z.object({
  listingId: uuid,
});
export type StartConversationInput = z.infer<typeof startConversationInput>;

export const startOrderConversationInput = z.object({
  orderId: uuid,
});
export type StartOrderConversationInput = z.infer<typeof startOrderConversationInput>;

export const sendMessageInput = z
  .object({
    conversationId: uuid,
    body: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : v),
      z.string().max(MESSAGE_MAX_LENGTH, `Messages can be up to ${MESSAGE_MAX_LENGTH.toLocaleString('en-NG')} characters.`),
    ),
    mediaId: optionalId,
    clientKey: messageClientKey,
  })
  .refine((v) => v.body.length > 0 || v.mediaId !== null, { message: 'Write a message or add a photo.', path: ['body'] });
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const conversationIdInput = z.object({
  conversationId: uuid,
});

export const listConversationsInput = z.object({
  as: z.enum(['buyer', 'seller']).default('buyer'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type ListConversationsInput = z.infer<typeof listConversationsInput>;

/** Polling / paging query: `after` and `before` accept an ISO timestamp or a message id. */
export const conversationMessagesQuery = z.object({
  after: z.string().max(64).optional(),
  before: z.string().max(64).optional(),
});
export type ConversationMessagesQuery = z.infer<typeof conversationMessagesQuery>;
