'use server';

import { replayWebhook, retryOutboxEvent } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function retryOutboxAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => retryOutboxEvent(ctx, formObject(form)), 'Queued for retry.');
}

export async function replayWebhookAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => replayWebhook(ctx, formObject(form)), 'Queued for replay.');
}
