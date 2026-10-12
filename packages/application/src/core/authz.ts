import { DomainError } from '@thrift/domain';
import { maybeOne, type Queryable } from '@thrift/database';
import type { Actor, AppContext, StaffRole, UserActor } from './context';

/** Every protected use case starts with one of these. Hidden UI is never authorisation. */
export function requireUser(ctx: AppContext): UserActor {
  if (ctx.actor.kind !== 'user') throw new DomainError('UNAUTHENTICATED', 'Sign in to continue.');
  return ctx.actor;
}

/** Messaging, offers, bidding and checkout need a verified contact. */
export function requireVerifiedUser(ctx: AppContext): UserActor {
  const user = requireUser(ctx);
  if (!user.contactVerified) {
    throw new DomainError('CONTACT_UNVERIFIED', 'Verify your email or phone number to continue.');
  }
  return user;
}

export function hasRole(actor: Actor, ...roles: StaffRole[]): boolean {
  return actor.kind === 'user' && actor.roles.some((r) => roles.includes(r));
}

/** Staff permission check. `admin` does not implicitly include finance approvals (see four-eyes rules). */
/** Staff-only use cases: the role is required AND the session must have passed MFA recently. */
export function requireStaff(ctx: AppContext, ...roles: StaffRole[]): UserActor {
  const user = requireUser(ctx);
  if (!user.roles.some((r) => roles.includes(r))) {
    throw new DomainError('FORBIDDEN', 'You do not have permission to do this.');
  }
  if (!user.mfaVerified) {
    throw new DomainError('FORBIDDEN', 'Confirm it’s you with your authenticator app to use staff tools.', { mfaRequired: true });
  }
  return user;
}

export function requireSystem(ctx: AppContext): void {
  if (ctx.actor.kind !== 'system') throw new DomainError('FORBIDDEN', 'System task only.');
}

export interface OwnedShop {
  id: string;
  slug: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'suspended';
  owner_user_id: string;
  city: string;
  state: string;
  verification_status: string;
}

/** The caller's own shop (one shop per seller at launch), or null. */
export async function findOwnShop(db: Queryable, userId: string): Promise<OwnedShop | null> {
  return maybeOne<OwnedShop & Record<string, unknown>>(
    db,
    `SELECT s.id, s.slug, s.name, s.status, s.owner_user_id, s.city, s.state, s.verification_status
       FROM shops s JOIN shop_members m ON m.shop_id = s.id
      WHERE m.user_id = $1
      ORDER BY m.role = 'owner' DESC LIMIT 1`,
    [userId],
  );
}

export async function requireOwnShop(db: Queryable, ctx: AppContext): Promise<OwnedShop> {
  const user = requireUser(ctx);
  const shop = await findOwnShop(db, user.userId);
  if (!shop) throw new DomainError('NOT_FOUND', 'Create your shop first.');
  return shop;
}

/** Object-level check: the caller is a member of this shop. Returns NOT_FOUND (not FORBIDDEN) to avoid probing. */
export async function assertShopMember(db: Queryable, ctx: AppContext, shopId: string): Promise<UserActor> {
  const user = requireUser(ctx);
  const row = await maybeOne(db, 'SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2', [shopId, user.userId]);
  if (!row) throw new DomainError('NOT_FOUND', 'Not found.');
  return user;
}

/** Shops that are paused/suspended cannot make new sales but can fulfil existing orders. */
export function assertShopCanSell(shop: { status: string }): void {
  if (shop.status !== 'active') {
    throw new DomainError('INVALID_STATE', shop.status === 'paused' ? 'This shop is paused and not taking new orders.' : 'This shop is not taking orders.');
  }
}
