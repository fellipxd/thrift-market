import { notFound } from 'next/navigation';
import { financeOverview, type FinanceOverview } from '@thrift/application';
import { formatNaira, formatWat, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { CardSection, StatTile } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { decideRefundAction } from './actions';

export const metadata = { title: 'Finance' };
export const dynamic = 'force-dynamic';

export default async function FinancePage() {
  await requireUserPage(routes.admin.finance);
  let f: FinanceOverview;
  try {
    f = await financeOverview(await getCtx());
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  const owedToSellers = -(f.ledger.find((b) => b.account === 'seller_payable')?.balanceMinor ?? 0);
  const clearing = f.ledger.find((b) => b.account === 'provider_clearing')?.balanceMinor ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader title="Finance" description="Payments needing attention, refund decisions, payouts and ledger health." />
      {f.unbalanced.length > 0 ? (
        <Alert tone="error" title="Ledger imbalance">{f.unbalanced.length} ledger transaction(s) don’t balance. Investigate before releasing payouts.</Alert>
      ) : (
        <Alert tone="success">Ledger balanced: every transaction sums to zero.</Alert>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Held at provider" value={formatNaira(clearing)} hint="Provider clearing balance" />
        <StatTile label="Owed to sellers" value={formatNaira(owedToSellers)} hint="Seller payable (not yet paid out)" />
        <StatTile label="Unresolved payments" value={f.unresolvedAttempts.length} hint="Pending or uncertain attempts" />
        <StatTile label="Failed webhooks" value={f.failedWebhooks.length} hint="Dead-lettered events" />
      </div>

      <CardSection title={`Refunds awaiting decision (${f.refundsAwaitingDecision.length})`}>
        {f.refundsAwaitingDecision.length === 0 ? (
          <p className="text-sm text-muted">Nothing to decide.</p>
        ) : (
          <ul className="space-y-4">
            {f.refundsAwaitingDecision.map((r) => (
              <li key={r.id} className="rounded-[var(--radius-card)] border border-line p-3">
                <p className="text-sm">
                  <span className="font-semibold">{formatNaira(r.amountMinor)}</span> on order {r.orderNumber} · {r.reason.replace(/_/g, ' ')}
                  {r.requestedBy && <span className="text-muted"> · requested by {r.requestedBy}</span>}
                </p>
                {r.note && <p className="text-sm text-muted">{r.note}</p>}
                <ActionForm action={decideRefundAction} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <input type="hidden" name="refundId" value={r.id} />
                  <TextField label="Reason for decision" name="reason" required className="flex-1" />
                  <div className="flex gap-2">
                    <SubmitButton name="decision" value="approve" size="sm">Approve</SubmitButton>
                    <SubmitButton name="decision" value="reject" variant="secondary" size="sm">Reject</SubmitButton>
                  </div>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">Staff-exception refunds must be approved by a different finance team member than the requester.</p>
      </CardSection>

      <CardSection title="Refunds in flight">
        {f.refundsInFlight.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {f.refundsInFlight.map((r) => (
              <li key={r.id} className="flex justify-between gap-2 py-2">
                <span>{r.orderNumber} · {r.reason.replace(/_/g, ' ')} · attempts {r.attempts}</span>
                <span>
                  {formatNaira(r.amountMinor)} <Badge tone={r.status === 'failed' ? 'error' : 'info'}>{r.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardSection>

      <CardSection title="Unresolved payment attempts">
        {f.unresolvedAttempts.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {f.unresolvedAttempts.map((a) => (
              <li key={a.reference} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="font-mono text-xs">{a.reference}</span>
                <span>{a.orderNumber ?? '—'} · {formatNaira(a.amountMinor)} · <Badge tone={a.status === 'uncertain' ? 'warning' : 'neutral'}>{a.status}</Badge></span>
                <span className="w-full text-xs text-muted">{formatWat(a.createdAt)}{a.failureReason ? ` · ${a.failureReason}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </CardSection>

      <div className="grid gap-6 lg:grid-cols-2">
        <CardSection title="Payouts by status">
          <ul className="divide-y divide-line text-sm">
            {f.payoutsByStatus.map((p) => (
              <li key={p.status} className="flex justify-between py-2">
                <span>{p.status}</span>
                <span>{p.count} · {formatNaira(p.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </CardSection>
        <CardSection title="Ledger balances">
          <ul className="divide-y divide-line text-sm">
            {f.ledger.map((b) => (
              <li key={b.account} className="flex justify-between py-2">
                <span>{b.account.replace(/_/g, ' ')}</span>
                <span className="font-mono">{formatNaira(b.balanceMinor)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Positive = debit balance, negative = credit balance.</p>
        </CardSection>
      </div>

      {f.failedWebhooks.length > 0 && (
        <CardSection title="Failed webhooks">
          <ul className="divide-y divide-line text-sm">
            {f.failedWebhooks.map((w) => (
              <li key={w.id} className="py-2">
                {w.provider} · {w.eventType} · {w.attempts} attempts · {formatWat(w.receivedAt)}
                {w.lastError && <span className="block text-xs text-error">{w.lastError}</span>}
              </li>
            ))}
          </ul>
        </CardSection>
      )}
    </div>
  );
}
