import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCategory, listCategoryTree, listSchemaVersions, type CategoryNode } from '@thrift/application';
import { formatWat, MEDIA_ROLES, SIZE_SYSTEM_LABEL, SIZE_SYSTEMS } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';
import { createCategoryAction, publishSchemaAction, updateCategoryAction } from './actions';

export const metadata = { title: 'Categories' };

function Tree({ nodes }: { nodes: CategoryNode[] }) {
  return (
    <ul className="space-y-1">
      {nodes.map((n) => (
        <li key={n.id}>
          <Link href={withQuery(routes.admin.categories, { id: n.id })} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-primary-soft">
            <span className={n.active ? '' : 'text-muted line-through'}>{n.name}</span>
            <span className="flex items-center gap-1 text-xs text-muted">
              {n.restricted && <Badge tone="warning">restricted</Badge>}v{n.schemaVersion ?? '–'}
              {n.listingCount !== undefined ? ` · ${n.listingCount}` : ''}
            </span>
          </Link>
          {n.children.length > 0 && <div className="ml-4 border-l border-line pl-2"><Tree nodes={n.children} /></div>}
        </li>
      ))}
    </ul>
  );
}

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const user = await requireStaffPage(routes.admin.categories);
  if (!user.roles.includes('admin')) notFound();
  const { id } = await searchParams;
  const ctx = await getCtx();
  const tree = await listCategoryTree(ctx.pool, { includeInactive: true, withCounts: true });
  const selected = id ? await getCategory(ctx.pool, id).catch(() => null) : null;
  const versions = selected ? await listSchemaVersions(ctx, selected.id) : [];
  const top = tree.map((t) => ({ value: t.id, label: t.name }));
  return (
    <div className="space-y-6">
      <PageHeader title="Categories" description="Expandable categories with versioned attribute schemas. Publishing a new version never changes how existing listings render." />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <CardSection title="Tree"><Tree nodes={tree} /></CardSection>
        <div className="space-y-6">
          {selected && (
            <>
              <CardSection title={`${selected.parentName ? `${selected.parentName} › ` : ''}${selected.name}`}>
                <ActionForm action={updateCategoryAction} className="space-y-3">
                  <input type="hidden" name="categoryId" value={selected.id} />
                  <TextField label="Name" name="name" defaultValue={selected.name} required />
                  <TextField label="Sort order" name="sortOrder" inputMode="numeric" defaultValue={String(selected.sortOrder)} />
                  <CheckboxField name="restricted" label="Restricted category (extra listing rules, decision D11)" defaultChecked={selected.restricted} />
                  <CheckboxField name="active" label="Active (available for new listings)" defaultChecked={selected.active} />
                  <SubmitButton pendingText="Saving…">Save category</SubmitButton>
                </ActionForm>
              </CardSection>
              <CardSection title={`Attribute schema · current version ${selected.schemaVersion}`}>
                <ActionForm action={publishSchemaAction} className="space-y-4">
                  <input type="hidden" name="categoryId" value={selected.id} />
                  <CheckboxField name="sizeRequired" label="Size is required" defaultChecked={selected.schema.sizeRequired} />
                  <fieldset>
                    <legend className="text-sm font-semibold">Allowed size systems</legend>
                    <div className="mt-1 flex flex-wrap gap-3">
                      {SIZE_SYSTEMS.map((s) => (
                        <label key={s} className="flex items-center gap-1.5 text-sm">
                          <input type="checkbox" name="allowedSizeSystems" value={s} defaultChecked={selected.schema.allowedSizeSystems.includes(s)} className="size-4 accent-[var(--color-primary)]" />
                          {SIZE_SYSTEM_LABEL[s]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="text-sm font-semibold">Recommended photo roles</legend>
                    <div className="mt-1 flex flex-wrap gap-3">
                      {MEDIA_ROLES.map((r) => (
                        <label key={r} className="flex items-center gap-1.5 text-sm capitalize">
                          <input type="checkbox" name="recommendedPhotoRoles" value={r} defaultChecked={selected.schema.recommendedPhotoRoles.includes(r)} className="size-4 accent-[var(--color-primary)]" />
                          {r}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-semibold">Measurements (cm)</legend>
                    {Array.from({ length: Math.max(selected.schema.measurements.length + 2, 3) }, (_, i) => {
                      const m = selected.schema.measurements[i];
                      return (
                        <div key={`m${i}`} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                          <TextField label={`Key ${i + 1}`} name={`m.${i}.key`} defaultValue={m?.key ?? ''} placeholder="chest_cm" />
                          <TextField label="Label" name={`m.${i}.label`} defaultValue={m?.label ?? ''} placeholder="Chest (cm)" />
                          <label className="flex min-h-11 items-center gap-1.5 text-sm"><input type="checkbox" name={`m.${i}.required`} defaultChecked={m?.required} className="size-4" />Required</label>
                        </div>
                      );
                    })}
                  </fieldset>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-semibold">Attributes</legend>
                    {Array.from({ length: Math.max(selected.schema.attributes.length + 1, 2) }, (_, i) => {
                      const a = selected.schema.attributes[i];
                      return (
                        <div key={`a${i}`} className="grid gap-2 rounded-lg border border-line p-2 sm:grid-cols-2">
                          <TextField label={`Key ${i + 1}`} name={`a.${i}.key`} defaultValue={a?.key ?? ''} placeholder="fit" />
                          <TextField label="Label" name={`a.${i}.label`} defaultValue={a?.label ?? ''} placeholder="Fit" />
                          <SelectField label="Type" name={`a.${i}.type`} defaultValue={a?.type ?? 'text'} options={[{ value: 'text', label: 'Text' }, { value: 'select', label: 'Choice list' }]} />
                          <TextField label="Options (comma separated)" name={`a.${i}.options`} defaultValue={a?.options?.join(', ') ?? ''} />
                          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name={`a.${i}.required`} defaultChecked={a?.required} className="size-4" />Required</label>
                        </div>
                      );
                    })}
                  </fieldset>
                  <SubmitButton pendingText="Publishing…">Publish version {selected.schemaVersion + 1}</SubmitButton>
                </ActionForm>
                <h3 className="mt-6 font-semibold">Version history</h3>
                <ul className="mt-2 divide-y divide-line text-sm">
                  {versions.map((v) => (
                    <li key={v.id} className="flex justify-between gap-3 py-2">
                      <span>Version {v.version} · {formatWat(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ''}</span>
                      <span className="text-muted">{v.listingCount} listings</span>
                    </li>
                  ))}
                </ul>
              </CardSection>
            </>
          )}
          <CardSection title="New category or subcategory">
            <ActionForm action={createCategoryAction} className="space-y-3" resetOnSuccess>
              <TextField label="Name" name="name" required />
              <TextField label="Slug (optional)" name="slug" hint="Lowercase letters, numbers and hyphens. Generated from the name if empty." />
              <SelectField label="Parent (leave empty for a top-level category)" name="parentId" defaultValue="" placeholder="Top level" options={top} />
              <SelectField label="Kind (top-level only)" name="kind" defaultValue="" placeholder="Inherit from parent" options={['clothes', 'shoes', 'bags', 'accessories'].map((k) => ({ value: k, label: k }))} />
              <CheckboxField name="restricted" label="Restricted category" />
              <SubmitButton pendingText="Creating…">Create</SubmitButton>
            </ActionForm>
          </CardSection>
        </div>
      </div>
    </div>
  );
}
