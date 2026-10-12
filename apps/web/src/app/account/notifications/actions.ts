'use server';

import { setFollowDrops, updateNotificationPreferences } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function savePreferencesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => updateNotificationPreferences(ctx, formObject(form)), 'Preferences saved.');
}

export async function followDropsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => setFollowDrops(ctx, formObject(form)), 'Saved.');
}
