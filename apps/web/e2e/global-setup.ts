/**
 * Warms up the dev server so first-visit route compilation doesn't count against test timeouts.
 * (E2E runs `next dev` because sandbox payment/courier pages are disabled in production mode.)
 */
export default async function globalSetup(): Promise<void> {
  const base = `http://localhost:${process.env.E2E_PORT ?? 3200}`;
  const get = async (path: string) => {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(120_000) });
      return await res.text();
    } catch {
      return '';
    }
  };
  const shop = await get('/shops/abuja-wardrobe');
  const item = /\/items\/[0-9a-f-]{36}/.exec(shop)?.[0];
  const paths = ['/', '/search?q=linen', '/nearby', '/sign-in', '/sign-up', '/sell', '/saved', '/account', ...(item ? [item] : [])];
  for (const p of paths) await get(p);
}
