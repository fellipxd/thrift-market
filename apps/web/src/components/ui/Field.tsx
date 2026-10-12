'use client';

import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from '@/lib/format';
import { useFieldError } from './ActionForm';

const control =
  'block min-h-11 w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2.5 text-base text-ink placeholder:text-muted focus:border-ink focus:outline-2 focus:outline-offset-2 focus:outline-primary aria-[invalid=true]:border-error disabled:bg-sand';

interface FieldProps {
  label: ReactNode;
  name: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
}

function FieldShell({ id, label, hint, error, required, className, children }: Omit<FieldProps, 'name'> & { id: string; children: ReactNode }) {
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
        {required && <span className="text-error"> *</span>}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm font-medium text-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({ label, name, hint, error, required, className, ...input }: FieldProps & Omit<ComponentProps<'input'>, 'name'>) {
  const id = useId();
  const ctxError = useFieldError(name);
  const err = error ?? ctxError;
  return (
    <FieldShell id={id} label={label} hint={hint} error={err} required={required} className={className}>
      <input
        id={id}
        name={name}
        required={required}
        aria-invalid={err ? true : undefined}
        aria-describedby={err ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={control}
        {...input}
      />
    </FieldShell>
  );
}

export function TextAreaField({ label, name, hint, error, required, className, rows = 4, ...input }: FieldProps & Omit<ComponentProps<'textarea'>, 'name'>) {
  const id = useId();
  const ctxError = useFieldError(name);
  const err = error ?? ctxError;
  return (
    <FieldShell id={id} label={label} hint={hint} error={err} required={required} className={className}>
      <textarea
        id={id}
        name={name}
        rows={rows}
        required={required}
        aria-invalid={err ? true : undefined}
        aria-describedby={err ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={control}
        {...input}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  name,
  hint,
  error,
  required,
  className,
  options,
  placeholder,
  ...select
}: FieldProps & Omit<ComponentProps<'select'>, 'name'> & { options: { value: string; label: string }[]; placeholder?: string }) {
  const id = useId();
  const ctxError = useFieldError(name);
  const err = error ?? ctxError;
  return (
    <FieldShell id={id} label={label} hint={hint} error={err} required={required} className={className}>
      <select
        id={id}
        name={name}
        required={required}
        aria-invalid={err ? true : undefined}
        aria-describedby={err ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={control}
        {...select}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckboxField({ label, name, hint, className, ...input }: { label: ReactNode; name: string; hint?: ReactNode; className?: string } & Omit<ComponentProps<'input'>, 'name' | 'type'>) {
  const id = useId();
  const err = useFieldError(name);
  return (
    <div className={cx('flex items-start gap-3', className)}>
      <input id={id} type="checkbox" name={name} className="mt-1 size-5 shrink-0 accent-[var(--color-primary)]" aria-invalid={err ? true : undefined} {...input} />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {hint && <p className="text-sm text-muted">{hint}</p>}
        {err && <p className="text-sm font-medium text-error">{err}</p>}
      </div>
    </div>
  );
}
