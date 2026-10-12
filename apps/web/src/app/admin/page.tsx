import Link from 'next/link';
import { notFound } from 'next/navigation';
import { adminOverview } from '@thrift/application';
import { formatWat, isDomainError } from '@thrift/domain';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';

export const metadata = { title: 'Operations overview' };
export const dynamic = 'force-dynamic';

export default async function AdminHome() {
  await requireStaffPage(routes.admin.home);
  let o;
  try {
    o = await adminOverview(await getCtx());
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  return (
    <div className="space-y-5">
      <PageHeader title="Operations overview" description="What needs attention now. Each count links to where it’s handled." />
      {o.worker.stale ? (
        <Alert tone="error" title="Background worker needs attention">
          {o.worker.lastRunAt ? `Last activity ${formatWat(o.worker.lastRunAt)}.` : 'No worker activity recorded yet.'}
          {o.worker.staleTasks.length > 0 && ` Stale or failing: ${o.worker.staleTasks.slice(0, 6).join(', ')}${o.worker.staleTasks.length > 6 ? '…' : ''}.`}
        </Alert>
      ) : (
        <Alert tone="success">Background worker healthy · last activity {o.worker.lastRunAt ? formatWat(o.worker.lastRunAt) : '—'}</Alert>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {o.counts.map((c) => (
          <li key={c.key}>
            <Link href={c.href} className={cx('block rounded-[var(--radius-card)] border p-4 hover:border-primary', c.urgent ? 'border-error/40 bg-error-soft' : 'border-line bg-surface')}>
              <span className="block text-3xl font-semibold tabular-nums">{c.count}</span>
              <span className="text-sm">{c.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
