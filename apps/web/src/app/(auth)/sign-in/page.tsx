import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { TextField } from '@/components/ui/Field';
import { routes } from '@/lib/routes';
import { signInAction } from '../actions';
import { AuthCard } from '../AuthCard';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const { next, reset } = await searchParams;
  return (
    <AuthCard
      title="Welcome back"
      footer={
        <>
          New here? <Link className="font-semibold text-primary underline" href={routes.auth.signUp(next)}>Create an account</Link>
        </>
      }
    >
      {reset && (
        <Alert tone="success" className="mb-4" title="Password reset">
          Sign in with your new password. You were signed out on every other device.
        </Alert>
      )}
      <ActionForm action={signInAction} className="space-y-4">
        <input type="hidden" name="next" value={next ?? ''} />
        <TextField label="Email or phone number" name="contact" autoComplete="username" required />
        <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
        <SubmitButton className="w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-sm">
        <Link href={routes.auth.forgotPassword} className="font-semibold text-primary underline">Forgot your password?</Link>
      </p>
    </AuthCard>
  );
}
