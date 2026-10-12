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
  const paths = [
    '/', '/search?q=linen', '/nearby', '/sign-in', '/sign-up', '/verify', '/sell', '/saved', '/account', '/account/addresses',
    '/orders', '/orders/00000000-0000-0000-0000-000000000000', '/checkout/new', '/checkout/00000000-0000-0000-0000-000000000000',
    '/checkout/return', '/sandbox/pay/none', '/sell/orders', '/sell/orders/00000000-0000-0000-0000-000000000000', '/sell/payouts', '/inbox', '/inbox/new', '/inbox/00000000-0000-0000-0000-000000000000', '/sell/offers', '/auctions', '/auctions/00000000-0000-0000-0000-000000000000', '/sell/auctions', '/sell/auctions/new',
    ...(item ? [item, `${item}/offer`] : []),
  ];
  for (const p of paths) await get(p);
}
