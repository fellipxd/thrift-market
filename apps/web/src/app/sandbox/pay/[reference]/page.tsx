import { notFound } from 'next/navigation';
import { formatNaira } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { services } from '@/server/services';
import { simulatePaymentAction } from './actions';
import { sandboxReturnPath } from './return-path';

export const metadata = { title: 'Sandbox payment', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * Stand-in for the payment provider's hosted page while the real provider is not enabled (decision D04).
 * Clearly labelled as a simulation; unavailable in production or when a real provider is configured.
 */
export default async function SandboxPayPage({ params, searchParams }: { params: Promise<{ reference: string }>; searchParams: Promise<{ callback?: string }> }) {
  const svc = services();
  if (!svc.providers.payments.isSandbox || svc.providers.payments.name !== 'sandbox' || svc.config.env === 'production') notFound();
  const { reference } = await params;
  const returnPath = sandboxReturnPath((await searchParams).callback);
  const rec = await svc.sandboxPayments.get(decodeURIComponent(reference));
  if (!rec) notFound();
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <Card className="space-y-4 border-2 border-dashed border-warning p-5">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Sandbox payment page</h1>
          <Badge tone="warning">SIMULATION</Badge>
        </div>
        <Alert tone="warning">No real money moves here. This page imitates a payment provider so the full checkout can be tested before a real provider is connected.</Alert>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-muted">Amount</dt><dd className="text-lg font-semibold">{formatNaira(rec.amountMinor)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">Reference</dt><dd className="font-mono text-xs">{rec.reference}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">Status at provider</dt><dd>{rec.status}</dd></div>
        </dl>
        {rec.status === 'succeeded' ? (
          <Alert tone="success">This payment has already succeeded.</Alert>
        ) : (
          <ActionForm action={simulatePaymentAction} refreshOnSuccess={false} className="space-y-2">
            <input type="hidden" name="reference" value={rec.reference} />
            <input type="hidden" name="returnPath" value={returnPath} />
            <SubmitButton name="outcome" value="succeeded" size="lg" className="w-full" pendingText="Processing…">Simulate successful payment</SubmitButton>
            <SubmitButton name="outcome" value="failed" variant="secondary" className="w-full" pendingText="Processing…">Simulate declined payment</SubmitButton>
            <SubmitButton name="outcome" value="abandoned" variant="ghost" className="w-full" pendingText="Processing…">Close without paying</SubmitButton>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
