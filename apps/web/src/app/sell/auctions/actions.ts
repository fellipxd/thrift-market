'use server';

import { redirect } from 'next/navigation';
import { cancelAuction, createAuction, offerSecondChance, relistAuction } from '@thrift/application';
import { routes } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';

/** Schedules a new auction (or relists a previous one). "Start now" sends startsAt=now. */
export async function scheduleAuctionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const fields = formObject(form);
  const input = { ...fields, startsAt: form.get('startNow') === 'on' ? 'now' : fields.startsAt };
  const state = await runAction((ctx) => (fields.relistAuctionId ? relistAuction(ctx, { ...input, auctionId: fields.relistAuctionId }) : createAuction(ctx, input)));
  if (state.status === 'success') redirect(`${routes.sell.auctions}?scheduled=1`);
  return state;
}

export async function cancelAuctionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => cancelAuction(ctx, formObject(form)), 'Auction cancelled. The piece is back in your drafts.');
}

export async function offerSecondChanceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => offerSecondChance(ctx, formObject(form)), 'Second-chance offer sent. Nothing is reserved or charged unless the bidder accepts.');
}
