'use server';

import { redirect } from 'next/navigation';
import { acceptSecondChance, declineSecondChance, placeBid, type BidResult } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function placeBidAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => placeBid(ctx, formObject(form)));
  if (state.status === 'success') {
    const r = state.data as BidResult;
    return { status: 'success', message: `Bid of ${formatNaira(r.amountMinor)} placed. You have the highest bid.${r.extended ? ' The end time was extended.' : ''}`, data: r };
  }
  return state;
}

export async function acceptSecondChanceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction((ctx) => acceptSecondChance(ctx, formObject(form)));
  if (state.status === 'success') redirect((state.data as { checkoutPath: string }).checkoutPath);
  return state;
}

export async function declineSecondChanceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => declineSecondChance(ctx, formObject(form)), 'Offer declined.');
}
