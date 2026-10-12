'use client';

import { useActionState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { buttonClass } from '@/components/ui/Button';

type State = { status: 'idle' } | { status: 'success'; message?: string; data?: unknown } | { status: 'error'; message: string; fieldErrors?: Record<string, string> };

/** Confirms MFA enrolment and shows the one-time recovery codes once. */
export function ConfirmEnrolmentForm({ action, next }: { action: (prev: State, form: FormData) => Promise<State>; next: string | null }) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' } as State);
  if (state.status === 'success') {
    const codes = (state.data as { recoveryCodes?: string[] } | undefined)?.recoveryCodes ?? [];
    return (
      <div className="space-y-3">
        <Alert tone="success" title="Two-step verification is on">
          Save these recovery codes somewhere safe. Each works once if you lose your phone. They won’t be shown again.
        </Alert>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c} className="rounded-md bg-sand px-2 py-1 text-center">{c}</li>
          ))}
        </ul>
        <a href={next ?? '/account'} className={buttonClass('primary', 'md')}>
          Continue
        </a>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-2">
      {state.status === 'error' && (
        <p role="alert" className="rounded-md bg-error-soft px-2 py-1 text-sm text-error">
          {state.message}
        </p>
      )}
      <label htmlFor="mfa-code" className="block text-sm font-medium">
        6-digit code from your app
      </label>
      <input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required className="block w-40 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2 font-mono text-lg tracking-widest" />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'md')}>
        {pending ? 'Checking…' : 'Turn on two-step verification'}
      </button>
    </form>
  );
}
