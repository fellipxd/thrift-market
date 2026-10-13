import { createPool } from '../client';
import { loadEnvFile } from '../env';
import { migrate } from '../migrate';
import { databaseSetupHint } from '../setup-hint';

loadEnvFile();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const pool = createPool({ connectionString: url, max: 1, application_name: 'thrift-migrate' });
try {
  const res = await migrate(pool, (m) => console.log(`[migrate] ${m}`));
  console.log(`[migrate] done: ${res.applied.length} applied, ${res.skipped.length} already applied`);
} catch (err) {
  const hint = databaseSetupHint(err, url);
  if (!hint) throw err;
  console.error(`\n[migrate] ${(err as Error).message.split('\n')[0]}\n\n${hint}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
