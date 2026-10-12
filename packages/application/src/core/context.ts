import type { Pool } from '@thrift/database';
import type { CourierProvider, MessageSender, ObjectStorage, PaymentProvider } from '@thrift/providers';

export type StaffRole = 'support' | 'trust_safety' | 'finance' | 'admin';

export interface UserActor {
  kind: 'user';
  userId: string;
  displayName: string;
  contactVerified: boolean;
  roles: StaffRole[];
  sessionId: string | null;
  /** The session passed a second factor recently (required for staff tools). */
  mfaVerified: boolean;
}

export type Actor = { kind: 'guest' } | UserActor | { kind: 'system'; name: string };

export interface Providers {
  payments: PaymentProvider;
  courier: CourierProvider;
  messages: MessageSender;
  storage: ObjectStorage;
}

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  baseUrl: string;
  appSecret: string;
}

/**
 * Everything a use case needs. Built per request (web) or per task run (worker).
 * `now()` is the authoritative server clock; tests may inject a fixed clock.
 */
export interface AppContext {
  pool: Pool;
  actor: Actor;
  now: () => Date;
  providers: Providers;
  config: AppConfig;
  requestId: string;
  ip: string | null;
}

export function withActor(ctx: AppContext, actor: Actor): AppContext {
  return { ...ctx, actor };
}

export function systemContext(ctx: Omit<AppContext, 'actor'>, name: string): AppContext {
  return { ...ctx, actor: { kind: 'system', name } };
}
