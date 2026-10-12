import { notFound } from 'next/navigation';
import { searchAudit } from '@thrift/application';
import { formatWat, isDomainError } from '@thrift/domain';
import { ButtonLink } from '@/components/ui/Button';
import { CardSection } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';

export const metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

type Search = { action?: string; targetKind?: string; targetId?: string; actorEmail?: string; from?: string; to?: string; before?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireStaffPage(routes.admin.audit);
  const sp = await searchParams;
  let res;
  try {
    res = await searchAudit(await getCtx(), sp);
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  const field = 'mt-1 block w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-2 py-1.5 text-sm';
  return (
    <div className="space-y-5">
      <PageHeader title="Audit log" description="Who did what, when and why. Financial actions are visible to finance and admin only." />
      <form method="get" className="grid gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-3 sm:grid-cols-3">
        <label className="text-xs font-medium">Action starts with<input name="action" defaultValue={sp.action} className={field} placeholder="refund." /></label>
        <label className="text-xs font-medium">Target type<input name="targetKind" defaultValue={sp.targetKind} className={field} placeholder="order" /></label>
        <label className="text-xs font-medium">Target id<input name="targetId" defaultValue={sp.targetId} className={field} /></label>
        <label className="text-xs font-medium">Actor email<input name="actorEmail" defaultValue={sp.actorEmail} className={field} /></label>
        <label className="text-xs font-medium">From<input type="date" name="from" defaultValue={sp.from} className={field} /></label>
        <label className="text-xs font-medium">To<input type="date" name="to" defaultValue={sp.to} className={field} /></label>
        <div className="sm:col-span-3">
          <button className="min-h-10 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-semibold text-white">Search</button>
        </div>
      </form>
      <CardSection title="Entries">
        {res.entries.length === 0 ? (
          <p className="text-sm text-muted">No matching entries.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {res.entries.map((e) => (
              <li key={e.id} className="py-2">
                <p>
                  <span className="font-mono text-xs">{e.action}</span> · {e.targetKind}
                  {e.targetId && <span className="font-mono text-xs"> {e.targetId}</span>}
                </p>
                <p className="text-xs text-muted">
                  {formatWat(e.at)} · {e.actorName ?? e.actorKind}
                  {e.reason && ` · “${e.reason}”`}
                </p>
              </li>
            ))}
          </ul>
        )}
        {res.nextBefore && (
          <div className="mt-3">
            <ButtonLink href={withQuery('/admin/audit', { ...sp, before: res.nextBefore })} variant="secondary" size="sm">Older entries</ButtonLink>
          </div>
        )}
      </CardSection>
    </div>
  );
}
