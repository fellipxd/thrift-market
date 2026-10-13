/**
 * Turns the usual local-setup failures (wrong password, missing role/database, nothing listening, no PostGIS) into
 * an actionable hint for CLI users. Never prints the password from DATABASE_URL.
 */
export function databaseSetupHint(err: unknown, connectionString: string | undefined): string | null {
  const e = err as { code?: string; message?: string; errors?: { code?: string }[] };
  const code = e?.code ?? e?.errors?.find((x) => x?.code)?.code;
  const message = e?.message ?? '';
  let where = 'the database in DATABASE_URL';
  try {
    const u = new URL(connectionString ?? '');
    where = `${decodeURIComponent(u.username) || '(no user)'}@${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`;
  } catch {
    // keep the generic wording
  }
  const setup = [
    'Set up the local database first (see README > Quick start):',
    '  Windows:        powershell -ExecutionPolicy Bypass -File scripts\\dev-setup.ps1',
    '                  (or add -UseLocalPostgres to use a PostgreSQL installed on Windows)',
    '  macOS / Linux:  docker compose up -d postgres   (Debian/Ubuntu without Docker: scripts/dev-setup.sh)',
  ].join('\n');
  if (code === '28P01') {
    return [
      `PostgreSQL rejected the password for ${where}.`,
      'Usually another PostgreSQL is using that port (one installed on Windows, or an older Docker volume created with a',
      'different password), or the role exists with a password other than the one in DATABASE_URL (.env).',
      setup,
      'An older Docker volume can be recreated with: docker compose down -v; docker compose up -d postgres (deletes its local data).',
    ].join('\n');
  }
  if (code === '28000') return `The role in DATABASE_URL (${where}) does not exist on this PostgreSQL.\n${setup}`;
  if (code === '3D000') return `The database in DATABASE_URL (${where}) does not exist.\n${setup}`;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return `Nothing is accepting connections at ${where}. Start PostgreSQL.\n${setup}`;
  if (/extension "postgis"|postgis\.control/i.test(message)) {
    return [
      'PostGIS is not installed for this PostgreSQL (the app needs it for nearby search).',
      '  Windows install:  Application Stack Builder > your PostgreSQL > Spatial Extensions > PostGIS',
      '  Or use Docker:    docker compose up -d postgres   (image postgis/postgis:16-3.4)',
    ].join('\n');
  }
  return null;
}
