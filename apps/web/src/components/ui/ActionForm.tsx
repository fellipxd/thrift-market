'use client';

import { createContext, useActionState, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Alert } from './Alert';
import { buttonClass } from './Button';

export type FormActionState =
  | { status: 'idle' }
  | { status: 'success'; message?: string; data?: unknown }
  | { status: 'error'; message: string; code?: string; fieldErrors?: Record<string, string> };

const FieldErrorsContext = createContext<Record<string, string>>({});

export function useFieldError(name?: string): string | undefined {
  const errors = useContext(FieldErrorsContext);
  return name ? errors[name] : undefined;
}

/**
 * Progressive-enhancement form bound to a server action returning FormActionState.
 * Shows a summary alert, wires field errors to inputs (aria-invalid + message) and can refresh/redirect on success.
 */
export function ActionForm({
  action,
  children,
  className,
  successRedirect,
  refreshOnSuccess = true,
  showSuccess = true,
  resetOnSuccess = false,
  id,
}: {
  action: (prev: FormActionState, form: FormData) => Promise<FormActionState>;
  children: ReactNode;
  className?: string;
  successRedirect?: string;
  refreshOnSuccess?: boolean;
  showSuccess?: boolean;
  resetOnSuccess?: boolean;
  id?: string;
}) {
  const [state, formAction] = useActionState(action, { status: 'idle' } as FormActionState);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status === 'success') {
      if (successRedirect) router.push(successRedirect);
      else if (refreshOnSuccess) router.refresh();
      if (resetOnSuccess) formRef.current?.reset();
    }
    if (state.status === 'error') alertRef.current?.focus();
  }, [state, successRedirect, refreshOnSuccess, resetOnSuccess, router]);
  const fieldErrors = state.status === 'error' ? (state.fieldErrors ?? {}) : {};
  return (
    <FieldErrorsContext.Provider value={fieldErrors}>
      <form ref={formRef} action={formAction} className={className} noValidate id={id}>
        {/* Spans the full row in grid forms and takes no cell while empty (the Alert announces itself via its role). */}
        <div ref={alertRef} tabIndex={-1} className="col-span-full outline-none empty:hidden" aria-live="polite">
          {state.status === 'error' && (
            <Alert tone="error" className="mb-4">
              {state.message}
            </Alert>
          )}
          {state.status === 'success' && showSuccess && state.message && (
            <Alert tone="success" className="mb-4">
              {state.message}
            </Alert>
          )}
        </div>
        {children}
      </form>
    </FieldErrorsContext.Provider>
  );
}

export function SubmitButton({
  children,
  pendingText = 'Working…',
  variant = 'primary',
  size = 'md',
  className,
  name,
  value,
  disabled,
}: {
  children: ReactNode;
  pendingText?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending || disabled} aria-busy={pending} className={buttonClass(variant, size, className)}>
      {pending ? pendingText : children}
    </button>
  );
}
