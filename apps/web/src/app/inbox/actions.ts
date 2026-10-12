'use server';

import { createHash } from 'node:crypto';
import { redirect } from 'next/navigation';
import { blockConversationParty, makeOffer, respondToOffer, sendMessage, unblockConversationParty, uploadImage, type OfferResult } from '@thrift/application';
import { DomainError } from '@thrift/domain';
import { routes } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Sends a chat message, optionally with one photo (stored as a restricted chat image). */
export async function sendMessageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const fields = formObject(form);
  const photo = form.get('photo');
  return runAction(async (ctx) => {
    let mediaId: string | null = null;
    if (photo instanceof File && photo.size > 0) {
      if (photo.size > MAX_PHOTO_BYTES) throw new DomainError('VALIDATION_FAILED', 'Photos can be up to 10 MB.', { fieldErrors: { photo: 'Choose a smaller photo.' } });
      const asset = await uploadImage(ctx, { purpose: 'message', data: Buffer.from(await photo.arrayBuffer()), altText: 'Chat photo' });
      mediaId = asset.id;
    }
    return sendMessage(ctx, { conversationId: fields.conversationId, body: fields.body ?? '', mediaId, clientKey: fields.clientKey });
  });
}

/** Accept / decline / counter / withdraw an offer from a conversation or the seller's offers page. */
export async function respondToOfferAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => respondToOffer(ctx, formObject(form)));
  if (state.status === 'success') {
    const r = state.data as OfferResult;
    return { status: r.status === 'unavailable' ? 'error' : 'success', message: r.message, data: r } as ActionState;
  }
  return state;
}

export async function blockAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => blockConversationParty(ctx, formObject(form)), 'Blocked. Neither of you can send messages or offers here until you unblock.');
}

export async function unblockAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => unblockConversationParty(ctx, formObject(form)), 'Unblocked.');
}

/** Buyer makes an offer; on success go to the conversation where the offer card appears. */
export async function makeOfferAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const fields = formObject(form);
  // The same form submitted twice with the same content is one offer; a new amount after an auto-decline is a new one.
  const content = createHash('sha256').update(`${fields.amount ?? ''}|${fields.note ?? ''}`).digest('hex').slice(0, 16);
  const idempotencyKey = fields.idempotencyKey ? `${fields.idempotencyKey.slice(0, 80)}_${content}` : undefined;
  const state = await runAction((ctx) => makeOffer(ctx, { ...fields, idempotencyKey }));
  if (state.status !== 'success') return state;
  const r = state.data as OfferResult;
  if (r.status === 'auto_declined') return { status: 'error', code: 'OFFER_TOO_LOW', message: r.message, fieldErrors: { amount: r.message } };
  redirect(r.conversationId ? `${routes.conversation(r.conversationId)}?sent=offer` : routes.inbox);
}
