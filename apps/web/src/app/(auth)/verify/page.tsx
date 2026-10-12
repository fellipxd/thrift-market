import { redirect } from 'next/navigation';
import { sandboxLatestCode } from '@thrift/application';
import { Alert } from '@/components/ui/Alert';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { TextField } from '@/components/ui/Field';
import { routes, safeNext } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { resendCodeAction, verifyAction } from '../actions';
import { AuthCard } from '../AuthCard';

export const metadata = { title: 'Verify your contact' };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const user = await requireUserPage(routes.auth.verify(next));
  if (user.contactVerified) redirect(safeNext(next, '/'));
  const sandboxCode = await sandboxLatestCode(await getCtx());
  return (
    <AuthCard title="Verify your contact" subtitle="Enter the 6-digit code we sent you. Verified contacts are required to message, offer, bid and pay.">
      {sandboxCode && (
        <Alert tone="warning" className="mb-4" title="Sandbox delivery">
          Messages are not really sent in this environment. Your code is <strong className="font-mono">{sandboxCode}</strong>.
        </Alert>
      )}
      <ActionForm action={verifyAction} className="space-y-4">
        <input type="hidden" name="next" value={next ?? ''} />
        <TextField label="Verification code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
        <SubmitButton className="w-full" pendingText="Checking…">Verify</SubmitButton>
      </ActionForm>
      <ActionForm action={resendCodeAction} className="mt-4">
        <SubmitButton variant="ghost" size="sm" pendingText="Sending…">Send a new code</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
