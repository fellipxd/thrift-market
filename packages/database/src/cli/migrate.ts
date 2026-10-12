import { createPool } from '../client';
import { loadEnvFile } from '../env';
import { migrate } from '../migrate';

loadEnvFile();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const pool = createPool({ connectionString: url, max: 1, application_name: 'thrift-migrate' });
try {
  const res = await migrate(pool, (m) => console.log(`[migrate] ${m}`));
  console.log(`[migrate] done: ${res.applied.length} applied, ${res.skipped.length} already applied`);
} finally {
  await pool.end();
}
