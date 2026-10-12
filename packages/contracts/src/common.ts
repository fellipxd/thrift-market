import { z } from 'zod';
import { NIGERIAN_STATES } from '@thrift/domain';

export const API_VERSION = 'v1';

export const uuid = z.string().uuid();
export const state = z.enum(NIGERIAN_STATES);
export const minorAmount = z.number().int().positive().max(100_000_000_000);
export const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

/** Accepts "8,500" / 8500 (naira) from forms; outputs integer kobo. */
export const nairaInput = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = String(v).replace(/[₦,\s]/g, '').trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
      ctx.addIssue({ code: 'custom', message: 'Enter an amount in naira, e.g. 8500' });
      return z.NEVER;
    }
    const [whole, frac = ''] = raw.split('.');
    return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  });

export const cursorPage = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

export const nigerianPhone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .refine((v) => /^(\+234|234|0)[789][01]\d{8}$/.test(v), 'Enter a Nigerian mobile number, e.g. 0803 123 4567')
  .transform((v) => (v.startsWith('+234') ? v : v.startsWith('234') ? `+${v}` : `+234${v.slice(1)}`));

export const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);

export type ApiErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};
