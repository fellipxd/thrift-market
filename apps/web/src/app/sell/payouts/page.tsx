import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, sellerPayoutSummary } from '@thrift/application';
import { formatNaira, formatWat, formatWatDate } from '@thrift/domain';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { CardSection, StatTile } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';

export const metadata = { title: 'Payouts' };

export default async function PayoutsPage() {
  const user = await requireUserPage(routes.sell.payouts);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const s = await sellerPayoutSummary(await getCtx());
  const coolingOff = s.account && new Date(s.account.usableAfter) > new Date();
  return (
    <div className="space-y-6">
      <PageHeader title="Payouts" description="Money from your sales, shown separately at each stage — nothing is blended." />
      {!s.account ? (
        <Alert tone="warning" title="Add a payout account">
          You need a verified bank account before payouts can be released. <Link href={`${routes.sell.settings}#payout`} className="font-semibold underline">Add one in shop settings</Link>.
        </Alert>
      ) : s.account.status !== 'verified' ? (
        <Alert tone="info" title="Payout account being verified">We’re confirming {s.account.bankName} ••••{s.account.last4}. Payouts wait until it’s verified.</Alert>
      ) : coolingOff ? (
        <Alert tone="info" title="New payout account">For your security, payouts to {s.account.bankName} ••••{s.account.last4} start from {formatWat(s.account.usableAfter)}.</Alert>
      ) : (
        <p className="text-sm text-muted">
          Paying out to <span className="font-semibold text-ink">{s.account.bankName} ••••{s.account.last4}</span>
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Gross sales" value={formatNaira(s.grossSalesMinor)} hint="Item prices on paid orders" />
        <StatTile label="Refunds" value={formatNaira(s.refundsMinor)} hint="Confirmed by the provider" />
        <StatTile label="Platform fees" value={formatNaira(s.feesMinor)} hint={s.feesMinor === 0 ? 'No commission currently' : 'Commission on sales'} />
        <StatTile label="Pending payout" value={formatNaira(s.pendingPayoutMinor)} hint="Awaiting delivery confirmation" />
        <StatTile label="Paid out" value={formatNaira(s.settledPayoutMinor)} hint="Sent to your bank" />
      </div>
      <CardSection title="Payout history">
        {s.payouts.length === 0 ? (
          <EmptyState title="No payouts yet">Each paid order creates a payout that’s released after delivery is confirmed.</EmptyState>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr>
                  <th className="py-2 font-semibold">Order</th>
                  <th className="py-2 font-semibold">Amount</th>
                  <th className="py-2 font-semibold">Status</th>
                  <th className="py-2 font-semibold">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.payouts.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2"><Link href={routes.sell.order(p.orderId)} className="font-medium underline">{p.orderNumber}</Link></td>
                    <td className="py-2">{formatNaira(p.amountMinor)}</td>
                    <td className="py-2"><Badge tone={p.status === 'paid' ? 'success' : p.status === 'blocked' || p.status === 'failed' ? 'warning' : 'neutral'}>{p.statusLabel}</Badge></td>
                    <td className="py-2 text-muted">{p.releasedAt ? formatWatDate(p.releasedAt) : p.eligibleAt ? `from ${formatWatDate(p.eligibleAt)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardSection>
    </div>
  );
}
