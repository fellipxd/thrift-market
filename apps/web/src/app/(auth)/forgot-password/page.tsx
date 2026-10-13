import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { TextField } from '@/components/ui/Field';
import { routes } from '@/lib/routes';
import { requestResetAction } from '../actions';
import { AuthCard } from '../AuthCard';

export const metadata = { title: 'Forgot password' };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Forgot password"
      subtitle="Enter the email or phone number on your account. If it matches an account, we’ll send a 6-digit code to reset your password."
      footer={
        <>
          Remembered it? <Link className="font-semibold text-primary underline" href={routes.auth.signIn()}>Sign in</Link>
        </>
      }
    >
      <ActionForm action={requestResetAction} className="space-y-4">
        <TextField label="Email or phone number" name="contact" autoComplete="username" required />
        <SubmitButton className="w-full" pendingText="Sending…">Send a reset code</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
