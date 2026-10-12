'use server';

import { simulateCourierEvent } from '@thrift/application';
import type { CourierStatus } from '@thrift/providers';
import { runAction, type ActionState } from '@/server/actions';

export async function courierEventAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const reference = String(form.get('reference') ?? '');
  const status = String(form.get('status') ?? '') as CourierStatus;
  const description = String(form.get('description') ?? '') || undefined;
  return runAction((ctx) => simulateCourierEvent(ctx, { reference, status, description }), 'Milestone sent.');
}
