import 'server-only';
import { registerAllJobs, servicesFromEnv, type Services } from '@thrift/application';

declare global {
  // Survives Next.js dev hot reloads so we do not leak connection pools.
  var __thriftServices: Services | undefined;
}

export function services(): Services {
  if (!globalThis.__thriftServices) {
    registerAllJobs();
    globalThis.__thriftServices = servicesFromEnv({ poolMax: Number(process.env.WEB_DB_POOL_MAX ?? 10), applicationName: 'thrift-web' });
  }
  return globalThis.__thriftServices;
}
