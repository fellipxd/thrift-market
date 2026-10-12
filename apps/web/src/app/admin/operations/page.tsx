import { notFound } from 'next/navigation';
import { operationsStatus } from '@thrift/application';
import { formatWat, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';
import { replayWebhookAction, retryOutboxAction } from './actions';

export const metadata = { title: 'Operations' };
export const dynamic = 'force-dynamic';

export default async function OperationsPage() {
  await requireStaffPage(routes.admin.operations);
  let s;
  try {
    s = await operationsStatus(await getCtx());
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Operations" description="Worker health, background event backlog and failed webhooks. Retries and replays are audited." />
      <CardSection title="Worker tasks">
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs uppercase text-muted">
              <tr>
                <th className="py-2">Task</th>
                <th className="py-2">Last run</th>
                <th className="py-2">Status</th>
                <th className="py-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {s.heartbeats.map((h) => (
                <tr key={h.task}>
                  <td className="py-2 font-mono text-xs">{h.task}</td>
                  <td className="py-2">{formatWat(h.lastRunAt)}</td>
                  <td className="py-2">
                    <Badge tone={h.status === 'error' ? 'error' : h.stale ? 'warning' : 'success'}>{h.status === 'error' ? 'error' : h.stale ? 'stale' : 'ok'}</Badge>
                  </td>
                  <td className="max-w-xs truncate py-2 font-mono text-xs text-muted">{JSON.stringify(h.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {s.missingTasks.length > 0 && <p className="mt-2 text-sm text-error">Never run: {s.missingTasks.join(', ')}</p>}
      </CardSection>
      <CardSection title="Background events">
        <p className="text-sm">{s.outbox.length === 0 ? 'No backlog.' : s.outbox.map((o) => `${o.status}: ${o.count}`).join(' · ')}</p>
        {s.deadEvents.length > 0 && (
          <ul className="mt-3 space-y-2 text-sm">
            {s.deadEvents.map((d) => (
              <li key={d.id} className="rounded-md border border-line p-2">
                <p>
                  <span className="font-mono">#{d.id}</span> {d.topic} · {d.attempts} attempts · {formatWat(d.createdAt)}
                </p>
                {d.lastError && <p className="text-xs text-error">{d.lastError}</p>}
                <ActionForm action={retryOutboxAction} className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <input type="hidden" name="id" value={d.id} />
                  <TextField label="Reason" name="reason" required className="flex-1" />
                  <SubmitButton size="sm" variant="secondary">Retry</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </CardSection>
      <CardSection title="Failed webhooks">
        {s.failedWebhooks.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {s.failedWebhooks.map((w) => (
              <li key={w.id} className="rounded-md border border-line p-2">
                <p>
                  {w.provider} · {w.eventType} · {w.attempts} attempts · {formatWat(w.receivedAt)}
                </p>
                {w.lastError && <p className="text-xs text-error">{w.lastError}</p>}
                <ActionForm action={replayWebhookAction} className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <input type="hidden" name="id" value={w.id} />
                  <TextField label="Reason" name="reason" required className="flex-1" />
                  <SubmitButton size="sm" variant="secondary">Replay</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </CardSection>
      <CardSection title="Overdue work">
        <p className="text-sm">Auctions past their end and not finalised: {s.overdueAuctions.length}. Holds overdue for reconciliation: {s.overdueReservations.length}.</p>
        <p className="mt-1 text-xs text-muted">These clear automatically when the worker runs; persistent items mean the worker is down or a task is failing.</p>
      </CardSection>
    </div>
  );
}
