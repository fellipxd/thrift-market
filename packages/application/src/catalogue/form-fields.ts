import { z } from 'zod';
import { NIGERIAN_STATES } from '@thrift/domain';

/**
 * Form-friendly zod building blocks. Server actions pass FormData as strings while the JSON API passes
 * typed values; these accept both and produce clean typed output with plain, user-facing messages.
 */

export function requiredText(label: string, min: number, max: number) {
  return z
    .string({ message: `Enter ${label.toLowerCase()}.` })
    .trim()
    .min(min, min <= 1 ? `Enter ${label.toLowerCase()}.` : `${label} needs at least ${min} characters.`)
    .max(max, `${label} can be at most ${max} characters.`);
}

/** Optional text: missing / blank becomes null. */
export function optionalText(label: string, max: number) {
  return z
    .union([z.string(), z.null()]).optional()
    .transform((v) => {
      const t = (v ?? '').trim();
      return t === '' ? null : t;
    })
    .refine((v) => v === null || v.length <= max, `${label} can be at most ${max} characters.`);
}

/** Checkbox / boolean: "on", "true", "1", "yes" and true are true; anything else is false. */
export const boolish = z
  .union([z.boolean(), z.string(), z.null()]).optional()
  .transform((v) => v === true || v === 'true' || v === 'on' || v === '1' || v === 'yes');

/** Whole number from a form field or JSON number. */
export function intField(label: string, min: number, max: number) {
  return z.union([z.number(), z.string()]).transform((v, ctx) => {
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: `${label} must be a whole number.` });
      return z.NEVER;
    }
    const n = Number(s);
    if (n < min || n > max) {
      ctx.addIssue({ code: 'custom', message: `${label} must be between ${min} and ${max}.` });
      return z.NEVER;
    }
    return n;
  });
}

/** Naira amount ("8,500", "8500.50", 8500) → kobo. Zero is allowed only when `allowZero`. */
export function nairaField(label: string, opts: { allowZero?: boolean; max?: number } = {}) {
  return z.union([z.number(), z.string()]).transform((v, ctx) => {
    const raw = String(v).replace(/[₦,\s]/g, '').trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
      ctx.addIssue({ code: 'custom', message: `Enter ${label.toLowerCase()} in naira, e.g. 8500 or 8,500.` });
      return z.NEVER;
    }
    const [whole, frac = ''] = raw.split('.');
    const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
    if (minor === 0 && !opts.allowZero) {
      ctx.addIssue({ code: 'custom', message: `${label} must be more than ₦0.` });
      return z.NEVER;
    }
    if (minor > (opts.max ?? 1_000_000_000)) {
      ctx.addIssue({ code: 'custom', message: `${label} is too high.` });
      return z.NEVER;
    }
    return minor;
  });
}

/** Optional naira amount: blank → null. */
export function optionalNairaField(label: string) {
  const inner = nairaField(label);
  return z.union([z.number(), z.string(), z.null()]).optional().transform((v, ctx) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const r = inner.safeParse(v);
    if (!r.success) {
      ctx.addIssue({ code: 'custom', message: r.error.issues[0]?.message ?? `Check ${label.toLowerCase()}.` });
      return z.NEVER;
    }
    return r.data;
  });
}

/** A list of values from repeated form fields, a comma-separated string or a JSON array. */
export const stringList = z
  .union([z.array(z.string()), z.string(), z.null()]).optional()
  .transform((v) => {
    const arr = Array.isArray(v) ? v : (v ?? '').split(',');
    return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
  });

export const stateList = stringList.refine(
  (arr) => arr.every((s) => (NIGERIAN_STATES as readonly string[]).includes(s)),
  'Choose states from the list.',
);

export const stateField = z.enum(NIGERIAN_STATES, { message: 'Choose a state.' });

export const uuidField = (label = 'item') => z.string({ message: `Choose ${label}.` }).trim().uuid(`Choose a valid ${label}.`);

export const optionalUuid = z
  .union([z.string(), z.null()]).optional()
  .transform((v) => (v ?? '').trim() || null)
  .refine((v) => v === null || /^[0-9a-f-]{36}$/i.test(v), 'Choose a valid option.');
