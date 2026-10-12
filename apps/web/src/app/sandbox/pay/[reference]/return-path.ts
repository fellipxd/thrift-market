import { routes } from '@/lib/routes';

/** Where the simulated provider may send the payer back: only our own payment return pages (never an arbitrary URL). */
const RETURN_PATHS = [routes.checkout.return, `${routes.sell.promotions}/return`];

export function sandboxReturnPath(callback: string | null | undefined): string {
  if (!callback) return routes.checkout.return;
  try {
    const path = new URL(callback, 'http://local.invalid').pathname;
    return RETURN_PATHS.includes(path) ? path : routes.checkout.return;
  } catch {
    return routes.checkout.return;
  }
}
