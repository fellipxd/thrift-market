'use server';

import { importListingsCsv, type ImportResult } from '@thrift/application';
import { runAction, type ActionState } from '@/server/actions';

/** Reads an uploaded CSV file (or pasted text) and imports its rows as drafts. */
export async function importListingsAction(_prev: ActionState, form: FormData): Promise<ActionState<ImportResult>> {
  const file = form.get('file');
  const pasted = String(form.get('csv') ?? '');
  const csv = file instanceof File && file.size > 0 ? await file.text() : pasted;
  if (!csv.trim()) return { status: 'error', message: 'Choose a CSV file or paste its contents.', fieldErrors: { file: 'Choose a file.' } };
  const state = await runAction((ctx) => importListingsCsv(ctx, { csv }));
  if (state.status !== 'success') return state;
  const r = state.data as ImportResult;
  return { ...state, message: `${r.created.length} draft${r.created.length === 1 ? '' : 's'} created${r.errors.length ? `, ${r.errors.length} row${r.errors.length === 1 ? '' : 's'} need fixing` : ''}.` };
}
