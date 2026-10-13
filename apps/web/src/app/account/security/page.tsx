import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { listMySessions, mfaStatus, startMfaEnrolment } from '@thrift/application';
import { formatWat } from '@thrift/domain';
import { ConfirmEnrolmentForm } from '@/components/trust/RecoveryCodesForm';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Card, CardSection } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, safeNext } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { changePasswordAction, confirmEnrolmentAction, restartEnrolmentAction, revokeOtherSessionsAction, revokeSessionAction } from './actions';

export const metadata = { title: 'Security' };
export const dynamic = 'force-dynamic';

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  const next = sp.next ? safeNext(sp.next, '/account') : null;
  await requireUserPage(routes.security(next ?? undefined));
  const ctx = await getCtx();
  const status = await mfaStatus(ctx);
  if (status.enrolled && !status.sessionVerified && status.required) redirect(routes.verifyMfa(next ?? '/admin'));
  const sessions = await listMySessions(ctx);
  const others = sessions.filter((s) => !s.current).length;
  return (
    <div className="mx-auto max-w-xl space-y-8 px-4 py-6">
      <PageHeader title="Security" description="Your password, the devices signed in to your account, and two-step verification." />

      <CardSection title="Password">
        <ActionForm action={changePasswordAction} className="space-y-3" resetOnSuccess>
          <TextField label="Current password" name="currentPassword" type="password" autoComplete="current-password" required />
          <TextField label="New password" name="newPassword" type="password" autoComplete="new-password" hint="At least 10 characters. Other devices are signed out." required />
          <SubmitButton pendingText="Saving…">Change password</SubmitButton>
        </ActionForm>
      </CardSection>

      <CardSection title="Signed-in devices">
        <ul className="divide-y divide-line border-y border-line" aria-label="Signed-in devices">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-3 text-sm">
              <span className="min-w-0">
                <span className="font-semibold text-ink">{s.device}</span>
                {s.current && <span className="label-caps ml-2 text-accent">This device</span>}
                <span className="block text-muted">Signed in {formatWat(s.createdAt)} · last active {formatWat(s.lastSeenAt)}</span>
              </span>
              {!s.current && (
                <ActionForm action={revokeSessionAction} showSuccess={false}>
                  <input type="hidden" name="sessionId" value={s.id} />
                  <SubmitButton variant="ghost" size="sm" pendingText="Signing out…">
                    Sign out<span className="sr-only"> {s.device}</span>
                  </SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        {others > 0 && (
          <ActionForm action={revokeOtherSessionsAction} className="mt-3">
            <SubmitButton variant="secondary" size="sm" pendingText="Signing out…">Sign out of all other devices</SubmitButton>
          </ActionForm>
        )}
      </CardSection>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl text-ink">Two-step verification</h2>
        <p className="text-sm text-muted">Protects your account with a code from an authenticator app (Google Authenticator, Authy, 1Password, …).</p>
      {status.required && !status.enrolled && <Alert tone="warning" title="Required for staff">Staff tools need two-step verification. Set it up to continue.</Alert>}
      {status.enrolled ? (
        <Card className="space-y-2 p-4 text-sm">
          <p className="font-semibold text-success">Two-step verification is on.</p>
          <p className="text-muted">{status.recoveryCodesLeft} unused recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left. If you lose your phone and your codes, ask an admin to reset it.</p>
        </Card>
      ) : (
        <SetupCard next={next} />
      )}
      </section>
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
