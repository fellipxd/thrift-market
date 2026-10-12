'use server';

import { setFollow } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function followShopAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const follow = form.get('follow') === 'true';
  return runAction((ctx) => setFollow(ctx, formObject(form)), follow ? 'You’re following this shop.' : 'Unfollowed.');
}
