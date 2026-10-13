import Link from 'next/link';
import { sandboxLatestResetCode } from '@thrift/application';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { TextField } from '@/components/ui/Field';
import { routes } from '@/lib/routes';
import { getCtx } from '@/server/session';
import { resetPasswordAction } from '../actions';
import { AuthCard } from '../AuthCard';

export const metadata = { title: 'Reset password' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ contact?: string }> }) {
  const { contact } = await searchParams;
  const sandboxCode = contact ? await sandboxLatestResetCode(await getCtx(), contact) : null;
  return (
    <AuthCard
      title="Reset password"
      subtitle="If the email or phone number matches an account, a 6-digit code is on its way. It expires in 15 minutes."
      footer={
        <>
          No code? <Link className="font-semibold text-primary underline" href={routes.auth.forgotPassword}>Send a new one</Link>
        </>
      }
    >
      {sandboxCode && (
        <Alert tone="warning" className="mb-4" title="Sandbox delivery">
          Messages are not really sent in this development environment. The code is <strong className="font-mono">{sandboxCode}</strong>.
        </Alert>
      )}
      <ActionForm action={resetPasswordAction} className="space-y-4">
        <TextField label="Email or phone number" name="contact" autoComplete="username" defaultValue={contact ?? ''} required />
        <TextField label="Reset code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
        <TextField label="New password" name="password" type="password" autoComplete="new-password" hint="At least 10 characters." required />
        <SubmitButton className="w-full" pendingText="Saving…">Set new password</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
