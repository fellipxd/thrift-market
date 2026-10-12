import { DomainError } from './errors';

export interface StockLevels {
  quantityTotal: number;
  quantityAvailable: number;
  quantityReserved: number;
  quantitySold: number;
  quantityWithdrawn: number;
}

export type StockMovement =
  | { kind: 'reserve'; quantity: number }
  | { kind: 'release'; quantity: number }
  | { kind: 'sell'; quantity: number }
  | { kind: 'withdraw'; quantity: number }
  | { kind: 'restock'; quantity: number };

/**
 * Pure stock transition. The database enforces the same invariant with CHECK constraints;
 * this computes the next state and raises STOCK_CONFLICT instead of going negative.
 */
export function applyStockMovement(s: StockLevels, m: StockMovement): StockLevels {
  if (!Number.isInteger(m.quantity) || m.quantity <= 0) {
    throw new DomainError('VALIDATION_FAILED', 'Quantity must be a positive integer');
  }
  const next = { ...s };
  switch (m.kind) {
    case 'reserve':
      if (s.quantityAvailable < m.quantity) {
        throw new DomainError('STOCK_CONFLICT', s.quantityTotal === 1 ? 'This piece is no longer available.' : 'Not enough units are available.', {
          available: s.quantityAvailable,
        });
      }
      next.quantityAvailable -= m.quantity;
      next.quantityReserved += m.quantity;
      break;
    case 'release':
      if (s.quantityReserved < m.quantity) throw new DomainError('INVALID_STATE', 'Nothing reserved to release');
      next.quantityReserved -= m.quantity;
      next.quantityAvailable += m.quantity;
      break;
    case 'sell':
      if (s.quantityReserved < m.quantity) throw new DomainError('INVALID_STATE', 'Only reserved units can be sold');
      next.quantityReserved -= m.quantity;
      next.quantitySold += m.quantity;
      break;
    case 'withdraw':
      if (s.quantityAvailable < m.quantity) {
        throw new DomainError('STOCK_CONFLICT', 'Only available units can be marked sold elsewhere or withdrawn.');
      }
      next.quantityAvailable -= m.quantity;
      next.quantityWithdrawn += m.quantity;
      break;
    case 'restock':
      next.quantityTotal += m.quantity;
      next.quantityAvailable += m.quantity;
      break;
  }
  return next;
}

/** Listing status that buyers should see given stock levels (for active listings). */
export function derivedAvailability(s: StockLevels): 'available' | 'reserved' | 'sold_out' {
  if (s.quantityAvailable > 0) return 'available';
  if (s.quantityReserved > 0) return 'reserved';
  return 'sold_out';
}
