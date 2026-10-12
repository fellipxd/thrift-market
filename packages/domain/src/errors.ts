/**
 * Error codes shared by domain, application and API layers. API responses map these to HTTP status.
 * Stock conflicts, expiry and rate limits are expected business outcomes, not server errors.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'CONTACT_UNVERIFIED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'STOCK_CONFLICT'
  | 'EXPIRED'
  | 'INVALID_STATE'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_PENDING'
  | 'PROVIDER_ERROR'
  | 'NOT_DELIVERABLE';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError || (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'DomainError' && 'code' in err);
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  CONTACT_UNVERIFIED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STOCK_CONFLICT: 409,
  EXPIRED: 410,
  INVALID_STATE: 409,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_PENDING: 202,
  PROVIDER_ERROR: 502,
  NOT_DELIVERABLE: 422,
};

export function invariant(condition: unknown, code: ErrorCode, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
