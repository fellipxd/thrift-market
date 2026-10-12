import 'server-only';
import { registerAllJobs, servicesFromEnv, type Services } from '@thrift/application';

declare global {
  // Survives Next.js dev hot reloads so we do not leak connection pools.
  var __thriftServices: Services | undefined;
}

export function services(): Services {
  // Next.js can load separate copies of the application package for pages, server actions and route handlers.
  // Registration is idempotent per copy, so every copy gets its handlers (e.g. promotion payments), while the
  // connection pool stays a single process-wide instance.
  registerAllJobs();
  if (!globalThis.__thriftServices) {
    globalThis.__thriftServices = servicesFromEnv({ poolMax: Number(process.env.WEB_DB_POOL_MAX ?? 10), applicationName: 'thrift-web' });
  }
  return globalThis.__thriftServices;
}
