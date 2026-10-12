import 'server-only';
import { isDomainError } from '@thrift/domain';
import type { AppContext } from '@thrift/application';
import { getCtx } from './session';

/** Shape returned by every server action used with useActionState. */
export type ActionState<T = unknown> =
  | { status: 'idle' }
  | { status: 'success'; message?: string; data?: T }
  | { status: 'error'; message: string; code?: string; fieldErrors?: Record<string, string> };

export const idle: ActionState = { status: 'idle' };

/**
 * Runs a use case and maps expected business errors (validation, stock conflict, expiry, permissions)
 * to a form-friendly state. Unexpected errors are logged and reported generically.
 * Do not call redirect() inside `fn`; redirect after checking the returned state.
 */
export async function runAction<T>(fn: (ctx: AppContext) => Promise<T>, successMessage?: string): Promise<ActionState<T>> {
  const ctx = await getCtx();
  try {
    const data = await fn(ctx);
    return { status: 'success', message: successMessage, data };
  } catch (err) {
    return toErrorState(err, ctx.requestId);
  }
}

export function toErrorState(err: unknown, requestId?: string): Extract<ActionState, { status: 'error' }> {
  if (isDomainError(err)) {
    const fieldErrors = (err.details?.fieldErrors as Record<string, string> | undefined) ?? undefined;
    const issues = err.details?.issues as { field: string; message: string }[] | undefined;
    return {
      status: 'error',
      code: err.code,
      message: err.message,
      fieldErrors: fieldErrors ?? (issues ? Object.fromEntries(issues.map((i) => [i.field, i.message])) : undefined),
    };
  }
  console.error(`[action] unexpected error request=${requestId ?? '-'}`, err);
  return { status: 'error', code: 'INTERNAL', message: `Something went wrong on our side. Please try again. (ref ${requestId ?? 'n/a'})` };
}

export function formObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
  return out;
}
