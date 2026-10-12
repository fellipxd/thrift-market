import Link from 'next/link';
import { notFound } from 'next/navigation';
import { recentModerationActions, staffReportQueue } from '@thrift/application';
import { formatWat, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { actOnReportAction, reverseModerationActionAction } from './actions';

export const metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = {
  remove_listing: 'Remove listing',
  suspend_shop: 'Suspend shop',
  hide_message: 'Hide message',
  hide_review: 'Hide review',
  suspend_user: 'Suspend account',
  dismiss: 'Dismiss (no violation)',
};

function targetLink(kind: string, id: string): string | null {
  if (kind === 'listing') return routes.item(id);
  return null;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireUserPage(routes.admin.reports);
  const { status = 'open' } = await searchParams;
  const ctx = await getCtx();
  let reports, actions;
  try {
    [reports, actions] = await Promise.all([staffReportQueue(ctx, { status }), recentModerationActions(ctx)]);
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="Act only on demonstrable policy violations. Every action needs a reason; the affected person is told why and how to appeal." />
      <nav aria-label="Filter reports" className="flex gap-1">
        {['open', 'closed'].map((s) => (
          <Link
            key={s}
            href={withQuery(routes.admin.reports, { status: s === 'open' ? undefined : s })}
            aria-current={status === s ? 'page' : undefined}
            className={cx('inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-semibold capitalize', status === s ? 'bg-primary text-white' : 'bg-surface text-ink')}
          >
            {s}
          </Link>
        ))}
      </nav>
      <CardSection title={`Reports (${reports.length})`}>
        {reports.length === 0 ? (
          <p className="text-sm text-muted">Nothing here.</p>
        ) : (
          <ul className="space-y-4">
            {reports.map((r) => {
              const href = targetLink(r.kind, r.targetId);
              return (
                <li key={r.id} className="rounded-[var(--radius-card)] border border-line p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone="warning">{r.reasonLabel}</Badge>
                    {href ? <Link href={href} className="font-semibold underline">{r.targetLabel}</Link> : <span className="font-semibold">{r.targetLabel}</span>}
                    {r.openReportsOnTarget > 1 && <Badge tone="error">{r.openReportsOnTarget} open reports</Badge>}
                  </p>
                  {r.details && <p className="mt-1 text-muted">“{r.details}”</p>}
                  <p className="text-xs text-muted">{formatWat(r.createdAt)}</p>
                  {r.status === 'open' ? (
                    <ActionForm action={actOnReportAction} className="mt-2 grid gap-2 sm:grid-cols-[200px_1fr_auto] sm:items-end">
                      <input type="hidden" name="reportId" value={r.id} />
                      <SelectField label="Action" name="action" required options={r.allowedActions.map((a) => ({ value: a, label: ACTION_LABEL[a] ?? a }))} />
                      <TextField label="Reason (shared with the affected person)" name="reason" required />
                      <SubmitButton size="sm">Apply</SubmitButton>
                    </ActionForm>
                  ) : (
                    <p className="mt-1 text-xs">{r.status}: {r.resolutionNote}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardSection>
      <CardSection title="Recent moderation actions">
        <p className="mb-2 text-sm text-muted">Reverse an action when an appeal succeeds. The reason is recorded and shared.</p>
        <ul className="space-y-2 text-sm">
          {actions.map((a) => (
            <li key={a.id} className="rounded-md border border-line p-2">
              <p>
                <span className="font-semibold">{a.action.replace(/_/g, ' ')}</span> · {a.targetKind} · {formatWat(a.createdAt)}
              </p>
              <p className="text-xs text-muted">{a.reason}</p>
              {!a.action.startsWith('reverse_') && (
                <ActionForm action={reverseModerationActionAction} className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <input type="hidden" name="actionId" value={a.id} />
                  <TextField label="Appeal outcome / reason" name="reason" required className="flex-1" />
                  <SubmitButton variant="ghost" size="sm">Reverse</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </CardSection>
    </div>
  );
}
