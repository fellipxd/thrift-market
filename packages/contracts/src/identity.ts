import { z } from 'zod';
import { email, nigerianPhone } from './common';

export const registerInput = z
  .object({
    displayName: z.string().trim().min(1, 'Enter your name').max(80),
    contact: z.string().trim().min(3, 'Enter an email or phone number').max(200),
    password: z.string().min(10, 'Use at least 10 characters').max(200),
  })
  .transform((v, ctx) => {
    if (v.contact.includes('@')) {
      const parsed = email.safeParse(v.contact);
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', path: ['contact'], message: 'Enter a valid email address' });
        return z.NEVER;
      }
      return { displayName: v.displayName, email: parsed.data, phone: null as string | null, password: v.password };
    }
    const parsed = nigerianPhone.safeParse(v.contact);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', path: ['contact'], message: 'Enter a valid email or Nigerian mobile number' });
      return z.NEVER;
    }
    return { displayName: v.displayName, email: null as string | null, phone: parsed.data, password: v.password };
  });
export type RegisterInput = z.infer<typeof registerInput>;

export const loginInput = z.object({
  contact: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginInput>;

export const verifyContactInput = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const addressInput = z.object({
  label: z.string().trim().min(1).max(40).default('Home'),
  recipientName: z.string().trim().min(2).max(80),
  phone: nigerianPhone,
  line1: z.string().trim().min(3).max(160),
  line2: z.string().trim().max(160).optional().nullable(),
  area: z.string().trim().max(80).optional().nullable(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(40),
  landmark: z.string().trim().max(160).optional().nullable(),
  isDefault: z.boolean().default(false),
});
export type AddressInput = z.infer<typeof addressInput>;
