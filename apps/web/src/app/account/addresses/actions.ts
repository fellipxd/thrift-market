'use server';

import { redirect } from 'next/navigation';
import { archiveAddress, createAddress, setDefaultAddress } from '@thrift/application';
import { safeNext } from '@/lib/routes';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function createAddressAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { next, ...fields } = formObject(form);
  const state = await runAction((ctx) => createAddress(ctx, { ...fields, isDefault: form.get('isDefault') === 'on' }), 'Address saved.');
  if (state.status === 'success' && next) redirect(safeNext(next, '/account/addresses'));
  return state;
}

export async function setDefaultAddressAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => setDefaultAddress(ctx, formObject(form)), 'Default address updated.');
}

export async function archiveAddressAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => archiveAddress(ctx, formObject(form)), 'Address removed.');
}
