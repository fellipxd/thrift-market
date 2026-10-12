import { Badge, type Tone } from '@/components/ui/Badge';

const TONES: Record<string, Tone> = {
  draft: 'neutral',
  scheduled: 'info',
  active: 'success',
  reserved: 'warning',
  sold: 'primary',
  paused: 'neutral',
  ended: 'neutral',
  removed: 'error',
};

export function ListingStatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={TONES[status] ?? 'neutral'}>{label}</Badge>;
}
