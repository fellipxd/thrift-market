import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { mfaStatus, startMfaEnrolment } from '@thrift/application';
import { ConfirmEnrolmentForm } from '@/components/trust/RecoveryCodesForm';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, safeNext } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { confirmEnrolmentAction, restartEnrolmentAction } from './actions';

export const metadata = { title: 'Security' };
export const dynamic = 'force-dynamic';

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  const next = sp.next ? safeNext(sp.next, '/account') : null;
  await requireUserPage(routes.security(next ?? undefined));
  const ctx = await getCtx();
  const status = await mfaStatus(ctx);
  if (status.enrolled && !status.sessionVerified && status.required) redirect(routes.verifyMfa(next ?? '/admin'));
  return (
    <div className="mx-auto max-w-xl space-y-5 px-4 py-6">
      <PageHeader title="Two-step verification" description="Protects your account with a code from an authenticator app (Google Authenticator, Authy, 1Password, …)." />
      {status.required && !status.enrolled && <Alert tone="warning" title="Required for staff">Staff tools need two-step verification. Set it up to continue.</Alert>}
      {status.enrolled ? (
        <Card className="space-y-2 p-4 text-sm">
          <p className="font-semibold text-success">Two-step verification is on.</p>
          <p className="text-muted">{status.recoveryCodesLeft} unused recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left. If you lose your phone and your codes, ask an admin to reset it.</p>
        </Card>
      ) : (
        <SetupCard next={next} />
      )}
    </div>
  );
}

async function SetupCard({ next }: { next: string | null }) {
  const { secret, otpauthUrl } = await startMfaEnrolment(await getCtx());
  const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  return (
    <Card className="space-y-4 p-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Open your authenticator app and add an account.</li>
        <li>Scan this code, or type the setup key.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt="QR code for your authenticator app" width={220} height={220} className="rounded-md border border-line" />
      <p className="text-sm">
        Setup key: <code className="break-all rounded bg-sand px-1 font-mono" data-testid="mfa-secret">{secret}</code>
      </p>
      <ConfirmEnrolmentForm action={confirmEnrolmentAction} next={next} />
      <ActionForm action={restartEnrolmentAction} showSuccess>
        <SubmitButton variant="ghost" size="sm">Generate a new setup key</SubmitButton>
      </ActionForm>
    </Card>
  );
}
