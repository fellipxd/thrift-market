'use server';

import { redirect } from 'next/navigation';
import {
  addOrReplacePayoutAccount,
  createShop,
  pauseShop,
  publishShop,
  resumeShop,
  updateDeliveryCoverage,
  updateShopProfile,
} from '@thrift/application';
import { routes } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';

/** Multi-select fields (states) arrive as repeated form keys; join them for the contracts' list parser. */
function formWithLists(form: FormData, lists: string[]): Record<string, string> {
  const obj = formObject(form);
  for (const key of lists) obj[key] = form.getAll(key).map(String).join(',');
  return obj;
}

export async function createShopAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => createShop(ctx, formObject(form)));
  if (state.status === 'success') redirect(`${routes.sell.settings}?welcome=1#coverage`);
  return state;
}

export async function updateProfileAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => updateShopProfile(ctx, formObject(form)), 'Shop profile saved.');
}

export async function updateCoverageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => updateDeliveryCoverage(ctx, formWithLists(form, ['states', 'excludedStates'])), 'Delivery coverage saved.');
}

export async function payoutAccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => addOrReplacePayoutAccount(ctx, formObject(form)), 'Payout account saved.');
}

export async function publishShopAction(_prev: ActionState): Promise<ActionState> {
  return runAction((ctx) => publishShop(ctx), 'Your shop is open. Publish your first piece!');
}

export async function pauseShopAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => pauseShop(ctx, formObject(form)), 'Shop paused. Existing orders continue as normal.');
}

export async function resumeShopAction(_prev: ActionState): Promise<ActionState> {
  return runAction((ctx) => resumeShop(ctx), 'Shop resumed.');
}
