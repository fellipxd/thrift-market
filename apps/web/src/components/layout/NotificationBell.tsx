import Link from 'next/link';
import { unreadNotificationCount } from '@thrift/application';
import { routes } from '@/lib/routes';
import { getCtx } from '@/server/session';

/** Header link to the notification centre with the unread count. */
export async function NotificationBell({ className }: { className?: string }) {
  const n = await unreadNotificationCount(await getCtx()).catch(() => 0);
  return (
    <Link href={routes.notifications} className={className} aria-label={n > 0 ? `Notifications, ${n} unread` : 'Notifications'}>
      <span aria-hidden="true">🔔</span>
      <span className="sr-only md:not-sr-only md:ml-1">Alerts</span>
      {n > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 py-0.5 text-xs font-bold text-white">{n > 99 ? '99+' : n}</span>}
    </Link>
  );
}
