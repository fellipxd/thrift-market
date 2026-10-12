import { z } from 'zod';
import { uuid } from './common';

const reason = z.string({ message: 'Give a reason.' }).trim().min(10, 'Give a reason (at least 10 characters).').max(1000);

export const STAFF_ROLES = ['support', 'trust_safety', 'finance', 'admin'] as const;
export type StaffRoleName = (typeof STAFF_ROLES)[number];

export const updateSettingInput = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.coerce.number({ message: 'Enter a number.' }).finite('Enter a number.'),
  reason,
});

export const POLICY_KINDS = ['checkout_terms', 'buyer_protection', 'auction_rules', 'seller_terms', 'promotion_terms', 'privacy', 'returns'] as const;

export const publishPolicyInput = z.object({
  kind: z.enum(POLICY_KINDS, { message: 'Choose a policy.' }),
  version: z.string().trim().min(1, 'Give a version label.').max(40),
  title: z.string().trim().min(3, 'Give a title.').max(160),
  body: z.string().trim().min(20, 'Write the policy text.').max(20000),
  reason,
});

export const grantRoleInput = z.object({
  email: z.string().trim().toLowerCase().email('Enter the staff member’s account email.'),
  role: z.enum(STAFF_ROLES, { message: 'Choose a role.' }),
  reason,
});

export const revokeRoleInput = z.object({
  userId: uuid,
  role: z.enum(STAFF_ROLES),
  reason,
});

export const retryOutboxInput = z.object({ id: z.coerce.number().int().positive(), reason });
export const replayWebhookInput = z.object({ id: uuid, reason });

export const auditSearchInput = z.object({
  action: z.string().trim().max(80).optional(),
  targetKind: z.string().trim().max(40).optional(),
  targetId: z.string().trim().max(80).optional(),
  actorEmail: z.string().trim().max(200).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  before: z.coerce.number().int().positive().optional(),
});
