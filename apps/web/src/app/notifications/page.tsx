import Link from 'next/link';
import { listNotifications } from '@thrift/application';
import { formatWat } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { markAllReadAction, openNotificationAction } from './actions';

export const metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ offset?: string }> }) {
  await requireUserPage(routes.notifications);
  const { offset } = await searchParams;
  const res = await listNotifications(await getCtx(), { offset: Number(offset) || 0 });
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <PageHeader
        title="Notifications"
        description={res.unread > 0 ? `${res.unread} unread` : 'You’re all caught up.'}
        actions={
          <div className="flex gap-2">
            {res.unread > 0 && (
              <ActionForm action={markAllReadAction} showSuccess={false}>
                <SubmitButton variant="secondary" size="sm">Mark all read</SubmitButton>
              </ActionForm>
            )}
            <ButtonLink href={routes.notificationSettings} variant="ghost" size="sm">Settings</ButtonLink>
          </div>
        }
      />
      {res.items.length === 0 ? (
        <EmptyState title="No notifications yet">Updates about your orders, messages and the shops you follow will appear here.</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          {res.items.map((n) => (
            <li key={n.id} className={cx(!n.read && 'bg-primary-soft/40')}>
              <ActionForm action={openNotificationAction} showSuccess={false}>
                <input type="hidden" name="notificationId" value={n.id} />
                <button type="submit" className="block w-full p-3 text-left hover:bg-primary-soft/60">
                  <span className="flex items-start justify-between gap-2">
                    <span className={cx('text-sm', n.read ? 'text-ink' : 'font-semibold text-ink')}>
                      {!n.read && <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" aria-label="Unread" />}
                      {n.title}
                    </span>
                    <time dateTime={n.createdAt} className="whitespace-nowrap text-xs text-muted">{formatWat(n.createdAt).replace(' WAT', '')}</time>
                  </span>
                  {n.body && <span className="mt-0.5 block text-sm text-muted">{n.body}</span>}
                </button>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      {res.nextOffset !== null && (
        <div className="mt-4 flex justify-center">
          <Link href={withQuery(routes.notifications, { offset: res.nextOffset })} className="text-sm font-semibold text-primary underline">Older notifications</Link>
        </div>
      )}
    </div>
  );
}
