'use server';

import { createCategory, publishSchemaVersion, schemaFromForm, updateCategory } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function createCategoryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => createCategory(ctx, formObject(form)), 'Category created.');
}

export async function updateCategoryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => updateCategory(ctx, formObject(form)), 'Category saved.');
}

export async function publishSchemaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const multi: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key).map(String);
    multi[key] = all.length > 1 || key === 'allowedSizeSystems' || key === 'recommendedPhotoRoles' ? all : (all[0] ?? '');
  }
  return runAction(
    (ctx) => publishSchemaVersion(ctx, { categoryId: String(form.get('categoryId') ?? ''), schema: schemaFromForm(multi) }),
    'New schema version published. Existing listings keep their own version.',
  );
}
