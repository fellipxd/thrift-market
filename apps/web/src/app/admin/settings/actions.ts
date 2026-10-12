'use server';

import { publishPolicyVersion, updateSetting } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function updateSettingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => updateSetting(ctx, formObject(form)), 'Setting saved.');
}

export async function publishPolicyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => publishPolicyVersion(ctx, formObject(form)), 'Policy version published.');
}
