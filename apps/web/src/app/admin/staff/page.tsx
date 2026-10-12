import { notFound } from 'next/navigation';
import { listStaff } from '@thrift/application';
import { STAFF_ROLES } from '@thrift/contracts';
import { isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';
import { grantRoleAction, resetMfaAction, revokeRoleAction } from './actions';

export const metadata = { title: 'Staff access' };
export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = { support: 'Support', trust_safety: 'Trust & safety', finance: 'Finance', admin: 'Admin' };

export default async function StaffPage() {
  await requireStaffPage(routes.admin.staff);
  let staff;
  try {
    staff = await listStaff(await getCtx());
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Staff access" description="Grant only the roles someone needs. You can’t change your own roles, and there is always at least one admin. All changes are audited." />
      <CardSection title="Grant a role">
        <ActionForm action={grantRoleAction} resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_180px_1fr_auto] sm:items-end">
          <TextField label="Account email" name="email" type="email" required />
          <SelectField label="Role" name="role" required options={STAFF_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }))} />
          <TextField label="Reason" name="reason" required />
          <SubmitButton size="sm">Grant</SubmitButton>
        </ActionForm>
      </CardSection>
      <CardSection title={`Staff (${staff.length})`}>
        <ul className="divide-y divide-line text-sm">
          {staff.map((s) => (
            <li key={s.userId} className="space-y-2 py-3">
              <p>
                <span className="font-semibold">{s.name}</span> <span className="text-muted">{s.email}</span>{' '}
                {s.mfaEnrolled ? <Badge tone="success">2-step on</Badge> : <Badge tone="warning">2-step not set up</Badge>}
              </p>
              <div className="flex flex-wrap gap-2">
                {s.roles.map((r) => (
                  <ActionForm key={r} action={revokeRoleAction} className="flex items-end gap-1 rounded-md border border-line p-1">
                    <input type="hidden" name="userId" value={s.userId} />
                    <input type="hidden" name="role" value={r} />
                    <Badge tone="primary">{ROLE_LABEL[r] ?? r}</Badge>
                    <input name="reason" required placeholder="Reason to revoke" aria-label={`Reason to revoke ${ROLE_LABEL[r]}`} className="w-40 rounded border border-line-strong px-1 text-xs" />
                    <SubmitButton variant="ghost" size="sm">Revoke</SubmitButton>
                  </ActionForm>
                ))}
              </div>
              {s.mfaEnrolled && (
                <ActionForm action={resetMfaAction} className="flex items-end gap-2">
                  <input type="hidden" name="userId" value={s.userId} />
                  <TextField label="Reset two-step (lost device) — reason" name="reason" required className="flex-1" />
                  <SubmitButton variant="ghost" size="sm">Reset</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </CardSection>
    </div>
  );
}
