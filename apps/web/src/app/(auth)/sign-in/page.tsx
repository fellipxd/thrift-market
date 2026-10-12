import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { TextField } from '@/components/ui/Field';
import { routes } from '@/lib/routes';
import { signInAction } from '../actions';
import { AuthCard } from '../AuthCard';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <AuthCard
      title="Welcome back"
      footer={
        <>
          New here? <Link className="font-semibold text-primary underline" href={routes.auth.signUp(next)}>Create an account</Link>
        </>
      }
    >
      <ActionForm action={signInAction} className="space-y-4">
        <input type="hidden" name="next" value={next ?? ''} />
        <TextField label="Email or phone number" name="contact" autoComplete="username" required />
        <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
        <SubmitButton className="w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
