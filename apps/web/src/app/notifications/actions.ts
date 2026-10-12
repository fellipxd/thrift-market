'use server';

import { redirect } from 'next/navigation';
import { markAllNotificationsRead, markNotificationRead } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

/** Opens a notification: marks it read, then follows its (same-site) link. */
export async function openNotificationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => markNotificationRead(ctx, formObject(form)));
  if (state.status === 'success') {
    const link = (state.data as { link: string | null }).link;
    if (link) redirect(link);
  }
  return state;
}

export async function markAllReadAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  return runAction((ctx) => markAllNotificationsRead(ctx), 'All caught up.');
}
