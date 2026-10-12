import Link from 'next/link';
import { TOPIC_INFO, unsubscribe } from '@thrift/application';
import { isDomainError } from '@thrift/domain';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { routes } from '@/lib/routes';
import { getCtx } from '@/server/session';

export const metadata = { title: 'Unsubscribe', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** One-click unsubscribe from a signed link (works signed out). */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let result: { topic: keyof typeof TOPIC_INFO; channel: string } | null = null;
  let error: string | null = null;
  try {
    result = await unsubscribe(await getCtx(), token ?? '');
  } catch (err) {
    if (!isDomainError(err)) throw err;
    error = err.message;
  }
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <Card className="space-y-3 p-5">
        <h1 className="display text-4xl">Unsubscribe</h1>
        {result ? (
          <Alert tone="success" title="You’re unsubscribed">
            You won’t receive “{TOPIC_INFO[result.topic].label}” by {result.channel === 'sms' ? 'SMS' : result.channel === 'email' ? 'email' : 'in-app notice'} any more. Order and account messages still reach you.
          </Alert>
        ) : (
          <Alert tone="error">{error}</Alert>
        )}
        <p className="text-sm text-muted">
          Manage everything in <Link href={routes.notificationSettings} className="underline">notification preferences</Link>.
        </p>
      </Card>
    </div>
  );
}
