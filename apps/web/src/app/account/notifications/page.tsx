import Link from 'next/link';
import { getNotificationPreferences } from '@thrift/application';
import { formatWatDate } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { CardSection } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { followDropsAction, savePreferencesAction } from './actions';

export const metadata = { title: 'Notification preferences' };
export const dynamic = 'force-dynamic';

const CHANNEL_LABEL = { in_app: 'In app', email: 'Email', sms: 'SMS' } as const;

export default async function NotificationPreferencesPage() {
  await requireUserPage(routes.notificationSettings);
  const p = await getNotificationPreferences(await getCtx());
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <PageHeader title="Notification preferences" description="Choose what we tell you about and how. Marketing updates are off until you turn them on, and every email has a one-click unsubscribe link." />
      <CardSection title="Topics and channels">
        <ActionForm action={savePreferencesAction} className="space-y-4">
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="text-xs uppercase text-muted">
                  <th className="py-2 font-semibold">Topic</th>
                  {(['in_app', 'email', 'sms'] as const).map((c) => (
                    <th key={c} className="py-2 text-center font-semibold">{CHANNEL_LABEL[c]}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {p.topics.map((t) => (
                  <tr key={t.topic}>
                    <td className="py-3 pr-3">
                      <span className="font-semibold">{t.label}</span>
                      {t.marketing && <span className="ml-1 text-xs text-accent">opt-in</span>}
                      <span className="block text-xs text-muted">{t.description}</span>
                    </td>
                    {t.cells.map((c) => (
                      <td key={c.channel} className="py-3 text-center">
                        <input
                          type="checkbox"
                          name={`pref:${c.topic}:${c.channel}`}
                          defaultChecked={c.on}
                          disabled={c.locked || (c.channel === 'email' && !p.contacts.emailVerified) || (c.channel === 'sms' && !p.contacts.phoneVerified)}
                          aria-label={`${t.label} by ${CHANNEL_LABEL[c.channel]}`}
                          className="h-5 w-5 accent-[var(--color-primary)]"
                        />
                        {c.consentedAt && c.channel !== 'in_app' && <span className="block text-[10px] text-muted">since {formatWatDate(c.consentedAt)}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(!p.contacts.emailVerified || !p.contacts.phoneVerified) && (
            <p className="text-xs text-muted">Email and SMS can only be turned on for a verified email address or phone number.</p>
          )}
          <SubmitButton>Save preferences</SubmitButton>
        </ActionForm>
      </CardSection>
      <CardSection title="Shops you follow">
        {p.follows.length === 0 ? (
          <p className="text-sm text-muted">
            You don’t follow any shops yet. <Link href={routes.nearby()} className="underline">Find shops near you</Link>.
          </p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {p.follows.map((f) => (
              <li key={f.shopId} className="flex items-center justify-between gap-2 py-2">
                <Link href={routes.shop(f.shopSlug)} className="font-medium underline">{f.shopName}</Link>
                <ActionForm action={followDropsAction} showSuccess={false} className="flex items-center gap-2">
                  <input type="hidden" name="shopId" value={f.shopId} />
                  <input type="hidden" name="notifyDrops" value={f.notifyDrops ? 'false' : 'true'} />
                  <span className="text-xs text-muted">{f.notifyDrops ? 'Drop alerts on' : 'Drop alerts off'}</span>
                  <SubmitButton variant="ghost" size="sm">{f.notifyDrops ? 'Turn off' : 'Turn on'}</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Drop alerts are sent only if “New drops from shops you follow” is on above.</p>
      </CardSection>
    </div>
  );
}
