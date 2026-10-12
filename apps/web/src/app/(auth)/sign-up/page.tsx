import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { TextField } from '@/components/ui/Field';
import { routes } from '@/lib/routes';
import { signUpAction } from '../actions';
import { AuthCard } from '../AuthCard';

export const metadata = { title: 'Create an account' };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <AuthCard
      title="Create your account"
      subtitle="Browse freely. An account lets you message sellers, make offers, bid and check out — and sell your own pieces."
      footer={
        <>
          Already have an account? <Link className="font-semibold text-primary underline" href={routes.auth.signIn(next)}>Sign in</Link>
        </>
      }
    >
      <ActionForm action={signUpAction} className="space-y-4">
        <input type="hidden" name="next" value={next ?? ''} />
        <TextField label="Your name" name="displayName" autoComplete="name" required />
        <TextField label="Email or Nigerian mobile number" name="contact" autoComplete="username" hint="We’ll send a 6-digit code to verify it." required />
        <TextField label="Password" name="password" type="password" autoComplete="new-password" hint="At least 10 characters." required />
        <p className="text-xs text-muted">
          By creating an account you agree to the marketplace terms. We never import your contacts or message anyone on your behalf.
        </p>
        <SubmitButton className="w-full" pendingText="Creating account…">Create account</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
