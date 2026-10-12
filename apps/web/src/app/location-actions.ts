'use server';

import { chooseLocation, locationFromDevice } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';
import { setLocationPreference } from '@/server/location';

export async function chooseLocationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const loc = await chooseLocation(ctx, formObject(form));
    await setLocationPreference(loc);
    return loc;
  }, 'Location updated.');
}

/** Called from the "Use my location" button. Only the nearest reference place is stored. */
export async function deviceLocationAction(coords: { lat: number; lng: number }): Promise<ActionState> {
  return runAction(async (ctx) => {
    const loc = await locationFromDevice(ctx, coords);
    await setLocationPreference(loc);
    return loc;
  }, 'Location updated.');
}

export async function clearLocationAction(_prev: ActionState): Promise<ActionState> {
  await setLocationPreference(null);
  return { status: 'success', message: 'Location cleared.' };
}
