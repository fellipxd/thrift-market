import { redirect } from 'next/navigation';
import { mfaStatus } from '@thrift/application';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Card } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, safeNext } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { verifyMfaAction } from '../actions';

export const metadata = { title: 'Confirm it’s you' };
export const dynamic = 'force-dynamic';

export default async function VerifyMfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next, '/admin');
  await requireUserPage(routes.verifyMfa(next));
  const status = await mfaStatus(await getCtx());
  if (!status.enrolled) redirect(routes.security(next));
  if (status.sessionVerified) redirect(next);
  return (
    <div className="mx-auto max-w-sm px-4 py-10">
      <PageHeader title="Confirm it’s you" description="Enter the code from your authenticator app, or one of your recovery codes." />
      <Card className="p-4">
        <ActionForm action={verifyMfaAction} refreshOnSuccess={false} className="space-y-3">
          <input type="hidden" name="next" value={next} />
          <TextField label="Code" name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={20} />
          <SubmitButton pendingText="Checking…">Verify</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
