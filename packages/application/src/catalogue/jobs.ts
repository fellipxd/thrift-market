import { registerTask } from '../jobs/tasks';
import { releaseScheduledDrops } from './batches';

export function registerCatalogueJobs(): void {
  registerTask({ name: 'catalogue.release_scheduled_drops', intervalMs: 15_000, run: (ctx) => releaseScheduledDrops(ctx) });
}
