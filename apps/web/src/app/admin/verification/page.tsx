import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasRole, listVerificationQueue } from '@thrift/application';
import { formatWat } from '@thrift/domain';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';

export const metadata = { title: 'Seller verification' };

export default async function VerificationQueuePage() {
  const user = await requireStaffPage(routes.admin.verification);
  if (!hasRole(user, 'trust_safety', 'admin')) notFound();
  const q = await listVerificationQueue(await getCtx());
  return (
    <div className="space-y-6">
      <PageHeader title="Seller verification" description="Oldest first. Evidence is restricted; every case view is recorded in the audit log." />
      {q.pending.length === 0 ? (
        <EmptyState title="No pending cases" />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          {q.pending.map((c) => (
            <li key={c.caseId} className="flex items-center justify-between gap-3 p-4">
              <div>
                <Link href={`${routes.admin.verification}/${c.caseId}`} className="font-semibold hover:underline">{c.shopName}</Link>
                <p className="text-sm text-muted">{c.kind} · submitted {formatWat(c.submittedAt)} · {c.evidenceCount} photo(s)</p>
              </div>
              <Badge tone={c.ageHours > 48 ? 'warning' : 'neutral'}>{Math.round(c.ageHours)}h waiting</Badge>
            </li>
          ))}
        </ul>
      )}
      {q.recentlyDecided.length > 0 && (
        <CardSection title="Recently decided">
          <ul className="divide-y divide-line text-sm">
            {q.recentlyDecided.map((d) => (
              <li key={d.caseId} className="flex justify-between gap-3 py-2">
                <Link href={`${routes.admin.verification}/${d.caseId}`} className="hover:underline">{d.shopName}</Link>
                <span className="text-muted">{d.status} · {formatWat(d.decidedAt)}{d.decidedBy ? ` · ${d.decidedBy}` : ''}</span>
              </li>
            ))}
          </ul>
        </CardSection>
      )}
    </div>
  );
}
