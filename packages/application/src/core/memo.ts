import type { AppContext } from './context';

const store = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Short per-process cache for public, non-personal aggregates (category counts, size facets) that every browse
 * request would otherwise recompute over the whole catalogue. Values may be up to `ttlMs` stale. Never use it
 * for anything personal, priced or stock-deciding. Concurrent misses share one computation (no stampede when an
 * entry expires under load). Disabled in tests so assertions see fresh data.
 */
export async function memoPublic<T>(ctx: AppContext, key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  if (ctx.config.env === 'test') return fn();
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      if (store.size > 500) store.delete(store.keys().next().value!);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
