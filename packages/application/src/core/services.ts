import path from 'node:path';
import { createPool, maybeOne, type Pool } from '@thrift/database';
import {
  LocalDiskStorage,
  PaystackPaymentProvider,
  SandboxCourierProvider,
  SandboxMessageSender,
  SandboxPaymentProvider,
  type ObjectStorage,
  type SandboxPaymentRecord,
  type SandboxPaymentStore,
} from '@thrift/providers';
import type { AppConfig, AppContext, Actor, Providers } from './context';

/** Sandbox provider state persisted in Postgres so web and worker processes share it. */
export class DbSandboxPaymentStore implements SandboxPaymentStore {
  constructor(private readonly pool: Pool) {}
  async get(reference: string): Promise<SandboxPaymentRecord | null> {
    const r = await maybeOne<{ reference: string; amount_minor: number; currency: string; status: SandboxPaymentRecord['status']; paid_at: Date | null; transaction_id: string }>(
      this.pool,
      'SELECT reference, amount_minor, currency, status, paid_at, transaction_id FROM sandbox_payments WHERE reference = $1',
      [reference],
    );
    return r
      ? { reference: r.reference, amountMinor: r.amount_minor, currency: r.currency, status: r.status, paidAt: r.paid_at, transactionId: r.transaction_id }
      : null;
  }
  async put(rec: SandboxPaymentRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO sandbox_payments (reference, amount_minor, currency, status, transaction_id, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (reference) DO UPDATE SET status = EXCLUDED.status, paid_at = EXCLUDED.paid_at, updated_at = now()`,
      [rec.reference, rec.amountMinor, rec.currency, rec.status, rec.transactionId, rec.paidAt],
    );
  }
}

export interface Services {
  pool: Pool;
  providers: Providers;
  config: AppConfig;
  sandboxPayments: DbSandboxPaymentStore;
  /** Builds a per-request/per-task context. */
  context(actor: Actor, meta?: { requestId?: string; ip?: string | null; now?: () => Date }): AppContext;
}

export interface ServiceOptions {
  databaseUrl: string;
  baseUrl: string;
  appSecret: string;
  env: AppConfig['env'];
  paymentProvider?: string;
  paystackSecretKey?: string;
  mediaStorageDir?: string;
  storage?: ObjectStorage;
  poolMax?: number;
  applicationName?: string;
}

export function createServices(opts: ServiceOptions): Services {
  if (opts.env === 'production' && (!opts.appSecret || opts.appSecret.startsWith('dev-only'))) {
    throw new Error('APP_SECRET must be set to a strong random value in production');
  }
  const pool = createPool({ connectionString: opts.databaseUrl, max: opts.poolMax ?? 10, application_name: opts.applicationName ?? 'thrift' });
  const sandboxPayments = new DbSandboxPaymentStore(pool);
  const payments =
    opts.paymentProvider === 'paystack'
      ? new PaystackPaymentProvider({ secretKey: opts.paystackSecretKey ?? '' })
      : new SandboxPaymentProvider({ baseUrl: opts.baseUrl, webhookSecret: opts.appSecret, store: sandboxPayments });
  if (opts.env === 'production' && payments.isSandbox) {
    console.warn('[services] WARNING: running with a sandbox payment provider. No real payments are processed.');
  }
  const providers: Providers = {
    payments,
    courier: new SandboxCourierProvider({ baseUrl: opts.baseUrl, webhookSecret: opts.appSecret }),
    messages: new SandboxMessageSender(),
    storage: opts.storage ?? new LocalDiskStorage(path.resolve(opts.mediaStorageDir ?? '.data/media')),
  };
  const config: AppConfig = { env: opts.env, baseUrl: opts.baseUrl, appSecret: opts.appSecret };
  let counter = 0;
  return {
    pool,
    providers,
    config,
    sandboxPayments,
    context(actor, meta = {}) {
      counter = (counter + 1) % 1_000_000;
      return {
        pool,
        providers,
        config,
        actor,
        now: meta.now ?? (() => new Date()),
        requestId: meta.requestId ?? `req_${Date.now().toString(36)}_${counter}`,
        ip: meta.ip ?? null,
      };
    },
  };
}

/** Reads standard environment variables (used by web and worker entry points). */
export function servicesFromEnv(overrides: Partial<ServiceOptions> = {}): Services {
  const env = (process.env.NODE_ENV === 'production' ? 'production' : process.env.NODE_ENV === 'test' ? 'test' : 'development') as AppConfig['env'];
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  return createServices({
    databaseUrl,
    baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
    appSecret: process.env.APP_SECRET ?? 'dev-only-insecure-secret-change-me-0123456789abcdef',
    env,
    paymentProvider: process.env.PAYMENT_PROVIDER ?? 'sandbox',
    paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
    mediaStorageDir: process.env.MEDIA_STORAGE_DIR,
    ...overrides,
  });
}
