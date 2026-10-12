import { DomainError } from '@thrift/domain';
import type { z } from 'zod';

/** Parses untrusted input with a contract schema; failures become VALIDATION_FAILED with field messages. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      // Forms name fields by their top-level key (e.g. a list "condition"), so surface nested errors there too.
      const top = issue.path.length > 1 ? String(issue.path[0]) : null;
      if (top && !fieldErrors[top]) fieldErrors[top] = issue.message;
    }
    const first = Object.values(fieldErrors)[0] ?? 'Check the highlighted fields.';
    throw new DomainError('VALIDATION_FAILED', first, { fieldErrors });
  }
  return result.data;
}
