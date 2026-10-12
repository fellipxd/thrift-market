import { registerTask } from '../jobs/tasks';
import { escalateOverdueDisputes } from './disputes';

export function registerDisputesJobs(): void {
  registerTask({ name: 'disputes.escalate_overdue', intervalMs: 300_000, run: (ctx) => escalateOverdueDisputes(ctx) });
}
