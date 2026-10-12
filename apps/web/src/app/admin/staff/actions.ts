'use server';

import { grantRole, resetUserMfa, revokeRole } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function grantRoleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => grantRole(ctx, formObject(form)), 'Role granted. They’ll need to set up two-step verification before using staff tools.');
}

export async function revokeRoleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => revokeRole(ctx, formObject(form)), 'Role revoked.');
}

export async function resetMfaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => resetUserMfa(ctx, formObject(form)), 'Two-step verification reset; their sessions were signed out.');
}
