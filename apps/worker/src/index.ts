import { hostname } from 'node:os';
import { listTasks, registerAllJobs, servicesFromEnv, type BackgroundTask } from '@thrift/application';
import { loadEnvFile } from '@thrift/database';

/**
 * Worker entry point. Runs independently of the web framework (no Next.js imports).
 * Every task is an idempotent scan protected by row locks / SKIP LOCKED, so several workers may run.
 * Usage: `pnpm worker` (loop) or `pnpm --filter @thrift/worker once` (single pass, e.g. from cron).
 */
loadEnvFile();
registerAllJobs();

const services = servicesFromEnv({ poolMax: Number(process.env.WORKER_DB_POOL_MAX ?? 5), applicationName: 'thrift-worker' });
const workerId = `${hostname()}:${process.pid}`;
const tickMs = Number(process.env.WORKER_TICK_MS ?? 5000);
const once = process.argv.includes('--once');
const lastRun = new Map<string, number>();
let stopping = false;

async function runTask(task: BackgroundTask): Promise<void> {
  const ctx = services.context({ kind: 'system', name: `worker:${task.name}` });
  const started = Date.now();
  try {
    const detail = (await task.run(ctx)) ?? {};
    await heartbeat(task.name, 'ok', { ...detail, ms: Date.now() - started });
  } catch (err) {
    console.error(`[worker] task ${task.name} failed`, err);
    await heartbeat(task.name, 'error', { error: String((err as Error).message ?? err).slice(0, 500) }).catch(() => undefined);
  }
}

async function heartbeat(task: string, status: string, detail: Record<string, unknown>): Promise<void> {
  await services.pool.query(
    `INSERT INTO worker_heartbeats (worker_id, task, last_run_at, last_status, detail) VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (worker_id) DO UPDATE SET task = EXCLUDED.task, last_run_at = now(), last_status = EXCLUDED.last_status, detail = EXCLUDED.detail`,
    [`${workerId}:${task}`, task, status, JSON.stringify(detail)],
  );
}

async function tick(): Promise<void> {
  const now = Date.now();
  for (const task of listTasks()) {
    if (stopping) return;
    if (!once && now - (lastRun.get(task.name) ?? 0) < task.intervalMs) continue;
    lastRun.set(task.name, now);
    await runTask(task);
  }
}

async function main(): Promise<void> {
  console.log(`[worker] ${workerId} starting with ${listTasks().length} tasks: ${listTasks().map((t) => t.name).join(', ')}`);
  if (once) {
    await tick();
    await services.pool.end();
    return;
  }
  while (!stopping) {
    await tick();
    await new Promise((r) => setTimeout(r, Math.min(tickMs, 1000)));
  }
  await services.pool.end();
  console.log('[worker] stopped');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received, finishing current task…`);
    stopping = true;
  });
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
