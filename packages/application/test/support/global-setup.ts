import { createPool, loadEnvFile, migrate, resetDatabase } from '@thrift/database';

/** Recreates the test database schema once per test run. */
export default async function setup(): Promise<void> {
  loadEnvFile();
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://thrift:thrift@localhost:5432/thrift_test';
  process.env.TEST_DATABASE_URL = url;
  const pool = createPool({ connectionString: url, max: 1 });
  try {
    await resetDatabase(pool);
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
