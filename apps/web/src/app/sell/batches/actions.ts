'use server';

import { createBatch, deleteBatch, updateBatch } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function createBatchAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => createBatch(ctx, formObject(form)), 'Batch created.');
}

export async function updateBatchAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await updateBatch(ctx, formObject(form));
    return r;
  }, 'Batch saved.');
}

export async function deleteBatchAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => deleteBatch(ctx, formObject(form)), 'Batch deleted.');
}
