import type { AppContext } from '../core/context';

/**
 * Background task registry. Each task is an idempotent, recoverable scan (safe to run concurrently on
 * several workers thanks to row locks / SKIP LOCKED). The worker runs every registered task each tick;
 * a scheduled reconciliation scan is the backstop for any lost event.
 */
export interface BackgroundTask {
  name: string;
  /** Minimum milliseconds between runs. */
  intervalMs: number;
  run(ctx: AppContext): Promise<Record<string, unknown> | void>;
}

const tasks: BackgroundTask[] = [];

export function registerTask(task: BackgroundTask): void {
  if (tasks.some((t) => t.name === task.name)) return;
  tasks.push(task);
}

export function listTasks(): readonly BackgroundTask[] {
  return tasks;
}
