import type { Queryable } from '@thrift/database';
import type { AppContext } from './context';

export interface AuditInput {
  action: string;
  targetKind: string;
  targetId?: string | null;
  reason?: string | null;
  data?: Record<string, unknown>;
}

/** Append-only audit trail. Use for staff actions, money movements, access to restricted evidence. */
export async function recordAudit(db: Queryable, ctx: AppContext, input: AuditInput): Promise<void> {
  const actor = ctx.actor;
  const actorKind = actor.kind === 'user' ? (actor.roles.length > 0 ? 'staff' : 'user') : actor.kind === 'system' ? 'system' : 'guest';
  await db.query(
    `INSERT INTO audit_events (actor_user_id, actor_kind, action, target_kind, target_id, reason, data, request_id, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      actor.kind === 'user' ? actor.userId : null,
      actorKind,
      input.action,
      input.targetKind,
      input.targetId ?? null,
      input.reason ?? null,
      JSON.stringify({ ...(input.data ?? {}), ...(actor.kind === 'system' ? { system: actor.name } : {}) }),
      ctx.requestId,
      ctx.ip,
    ],
  );
}
