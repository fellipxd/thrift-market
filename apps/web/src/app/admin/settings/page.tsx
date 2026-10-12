import { notFound } from 'next/navigation';
import { listPolicies, listSettings } from '@thrift/application';
import { POLICY_KINDS } from '@thrift/contracts';
import { formatWat, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';
import { publishPolicyAction, updateSettingAction } from './actions';

export const metadata = { title: 'Policy settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requireStaffPage(routes.admin.settings);
  const ctx = await getCtx();
  let settings, policies;
  try {
    [settings, policies] = await Promise.all([listSettings(ctx), listPolicies(ctx)]);
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Policy settings" description="Operational parameters and published policies. Every change needs a reason and is audited." />
      <Alert tone="warning" title="Draft values">These defaults come from the product plan and are not final business decisions (fees: D05; payout timing: D06). Change them only with owner approval.</Alert>
      <CardSection title="Parameters">
        <ul className="divide-y divide-line">
          {settings.map((s) => (
            <li key={s.key} className="py-3">
              <ActionForm action={updateSettingAction} className="grid gap-2 sm:grid-cols-[1fr_140px_1fr_auto] sm:items-end">
                <input type="hidden" name="key" value={s.key} />
                <div className="text-sm">
                  <p className="font-semibold">{s.label}</p>
                  <p className="text-xs text-muted">{s.description} Allowed {s.min}–{s.max} {s.unit}; default {s.defaultValue}.{s.updatedAt && ` Changed ${formatWat(s.updatedAt)}.`}</p>
                </div>
                <TextField label={`Value (${s.unit})`} name="value" inputMode="numeric" defaultValue={String(s.value)} required />
                <TextField label="Reason" name="reason" required />
                <SubmitButton size="sm" variant="secondary">Save</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      </CardSection>
      <CardSection title="Policies">
        <ul className="mb-4 space-y-1 text-sm">
          {policies.map((p) => (
            <li key={p.id}>
              <span className="font-mono text-xs">{p.kind}</span> · {p.title} ({p.version}) · effective {formatWat(p.effectiveAt)} {p.current && <Badge tone="success">current</Badge>}
            </li>
          ))}
        </ul>
        <ActionForm action={publishPolicyAction} className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Policy" name="kind" required placeholder="Choose" options={POLICY_KINDS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))} />
          <TextField label="Version label" name="version" required placeholder="2026-11" />
          <TextField label="Title" name="title" required className="sm:col-span-2" />
          <TextAreaField label="Policy text" name="body" required rows={6} className="sm:col-span-2" hint="Existing orders keep the version they were placed under." />
          <TextField label="Reason" name="reason" required className="sm:col-span-2" />
          <div className="sm:col-span-2">
            <SubmitButton>Publish new version</SubmitButton>
          </div>
        </ActionForm>
      </CardSection>
    </div>
  );
}
