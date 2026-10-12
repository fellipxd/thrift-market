import { Badge, type Tone } from '@/components/ui/Badge';

const PAYMENT_TONE: Record<string, Tone> = {
  pending: 'warning',
  paid: 'success',
  refund_pending: 'info',
  refunded: 'neutral',
  partially_refunded: 'info',
  failed: 'error',
};

const FULFILMENT_TONE: Record<string, Tone> = {
  awaiting_dispatch: 'warning',
  dispatched: 'info',
  in_transit: 'info',
  delivered: 'success',
  cancelled: 'neutral',
};

export function PaymentBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={PAYMENT_TONE[status] ?? 'neutral'}>{label}</Badge>;
}

export function FulfilmentBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={FULFILMENT_TONE[status] ?? 'neutral'}>{label}</Badge>;
}
