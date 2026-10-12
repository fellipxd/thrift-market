import { createPool } from '../client';
import { loadEnvFile } from '../env';
import { migrate, resetDatabase } from '../migrate';

loadEnvFile();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const pool = createPool({ connectionString: url, max: 1, application_name: 'thrift-reset' });
try {
  await resetDatabase(pool);
  const res = await migrate(pool, (m) => console.log(`[reset] ${m}`));
  console.log(`[reset] schema recreated, ${res.applied.length} migrations applied`);
} finally {
  await pool.end();
}
