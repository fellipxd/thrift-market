import { notFound } from 'next/navigation';
import { sandboxCourierShipment } from '@thrift/application';
import { formatWat } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { getCtx } from '@/server/session';
import { courierEventAction } from './actions';

export const metadata = { title: 'Sandbox courier', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** Stand-in for a courier's systems: emits signed milestone webhooks for a booking. Sandbox and non-production only. */
export default async function SandboxCourierPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  const s = await sandboxCourierShipment(await getCtx(), decodeURIComponent(reference));
  if (!s) notFound();
  const milestones: { status: string; label: string }[] = [
    { status: 'picked_up', label: 'Picked up' },
    { status: 'in_transit', label: 'In transit' },
    { status: 'out_for_delivery', label: 'Out for delivery' },
    { status: 'delivered', label: 'Delivered' },
    { status: 'exception', label: 'Exception' },
    { status: 'returned', label: 'Returned to sender' },
  ];
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <Card className="space-y-4 border-2 border-dashed border-warning p-5">
        <div className="flex items-center justify-between">
          <h1 className="font-serif text-2xl">Sandbox courier console</h1>
          <Badge tone="warning">SIMULATION</Badge>
        </div>
        <Alert tone="warning">No parcel is collected. This page imitates a courier sending tracking milestones to Thrift Market.</Alert>
        <p className="text-sm">
          Booking <span className="font-mono">{s.reference}</span> for order {s.orderNumber} · current status <strong>{s.status.replace(/_/g, ' ')}</strong>
        </p>
        <ActionForm action={courierEventAction} className="space-y-2">
          <input type="hidden" name="reference" value={s.reference} />
          <label className="block text-sm">
            Description (optional)
            <input name="description" className="mt-1 block w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            {milestones.map((m) => (
              <SubmitButton key={m.status} name="status" value={m.status} variant={m.status === 'exception' ? 'danger' : 'secondary'} size="sm">
                {m.label}
              </SubmitButton>
            ))}
          </div>
        </ActionForm>
        <ol className="space-y-1 text-xs text-muted">
          {s.events.map((e, i) => (
            <li key={i}>
              {formatWat(e.at)} · {e.status.replace(/_/g, ' ')} · {e.source}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
