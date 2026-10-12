export {
  formatNaira,
  formatWat,
  formatWatDate,
  formatCountdown,
  stateLabel,
  CONDITION_INFO,
  SALE_MODE_LABEL,
  SIZE_SYSTEM_LABEL,
  DELIVERY_METHOD_LABEL,
  TRACKING_CONFIDENCE_LABEL,
  REPUTATION_TIER_LABEL,
  approximateDistanceLabel,
} from '@thrift/domain';

export function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function relativeTime(date: Date | string, now: Date = new Date()): string {
  const diff = (now.getTime() - new Date(date).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
