import path from 'node:path';
import { createPool, loadEnvFile, migrate, repoRoot, resetDatabase } from '@thrift/database';
import { LocalDiskStorage } from '@thrift/providers';
import { DEV_APP_SECRET } from '../core/services';
import { seedAdPackages, seedCategories, seedCourierRoutes, seedPlaces, seedPolicies, seedSettings } from './base';
import { DEMO_ACCOUNTS, DEMO_MFA_SECRET, DEMO_PASSWORD, seedDemo } from './demo';

/**
 * `pnpm db:seed` — reference data (settings, policies, places, categories, courier routes, ad packages)
 * plus illustrative demo shops. `--reset` recreates the schema first (dev/test databases only).
 * `--base-only` skips demo data.
 */
loadEnvFile();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const log = (m: string) => console.log(`[seed] ${m}`);
const pool = createPool({ connectionString: url, max: 2, application_name: 'thrift-seed' });
try {
  if (process.argv.includes('--reset')) {
    await resetDatabase(pool);
    log('schema reset');
  }
  await migrate(pool, log);
  await seedSettings(pool);
  await seedPolicies(pool);
  await seedPlaces(pool);
  const categories = await seedCategories(pool);
  await seedCourierRoutes(pool);
  await seedAdPackages(pool);
  log('reference data ready');
  if (!process.argv.includes('--base-only')) {
    const storage = new LocalDiskStorage(path.resolve(repoRoot(), process.env.MEDIA_STORAGE_DIR ?? '.data/media'));
    await seedDemo(pool, storage, categories, log, { appSecret: process.env.APP_SECRET ?? DEV_APP_SECRET });
    log(`demo accounts (password "${DEMO_PASSWORD}"): ${Object.values(DEMO_ACCOUNTS).join(', ')}, plus shop owners amina@/tunde@/ebi@/musa@demo.thrift.test; demo staff two-step secret ${DEMO_MFA_SECRET}`);
  }
} finally {
  await pool.end();
}
