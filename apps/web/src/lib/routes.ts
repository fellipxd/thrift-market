/**
 * Canonical app paths. All slices link through these helpers so cross-feature links stay consistent.
 */
export const routes = {
  home: '/',
  search: (params?: Record<string, string | number | undefined>) => withQuery('/search', params),
  item: (listingId: string) => `/items/${listingId}`,
  shop: (slug: string) => `/shops/${slug}`,
  nearby: (params?: Record<string, string | number | undefined>) => withQuery('/nearby', params),
  auctions: '/auctions',
  auction: (auctionId: string) => `/auctions/${auctionId}`,
  saved: '/saved',
  following: '/following',
  inbox: '/inbox',
  conversation: (conversationId: string) => `/inbox/${conversationId}`,
  notifications: '/notifications',
  account: '/account',
  addresses: '/account/addresses',
  notificationSettings: '/account/notifications',
  orders: '/orders',
  order: (orderId: string) => `/orders/${orderId}`,
  checkout: {
    listing: (listingId: string) => `/checkout/new?listing=${listingId}`,
    offer: (threadId: string) => `/checkout/new?offer=${threadId}`,
    auction: (auctionId: string) => `/checkout/new?auction=${auctionId}`,
    secondChance: (offerId: string) => `/checkout/new?secondChance=${offerId}`,
    order: (orderId: string) => `/checkout/${orderId}`,
    return: '/checkout/return',
  },
  auth: {
    signIn: (next?: string) => withQuery('/sign-in', { next }),
    signUp: (next?: string) => withQuery('/sign-up', { next }),
    verify: (next?: string) => withQuery('/verify', { next }),
  },
  sell: {
    home: '/sell',
    onboarding: '/sell/onboarding',
    listings: '/sell/listings',
    newListing: '/sell/listings/new',
    listing: (listingId: string) => `/sell/listings/${listingId}`,
    batches: '/sell/batches',
    offers: '/sell/offers',
    auctions: '/sell/auctions',
    newAuction: (listingId?: string) => withQuery('/sell/auctions/new', { listing: listingId }),
    orders: '/sell/orders',
    order: (orderId: string) => `/sell/orders/${orderId}`,
    payouts: '/sell/payouts',
    promotions: '/sell/promotions',
    insights: '/sell/insights',
    reviews: '/sell/reviews',
    settings: '/sell/settings',
    verification: '/sell/verification',
  },
  admin: {
    home: '/admin',
    verification: '/admin/verification',
    reports: '/admin/reports',
    disputes: '/admin/disputes',
    dispute: (disputeId: string) => `/admin/disputes/${disputeId}`,
    categories: '/admin/categories',
    finance: '/admin/finance',
    ads: '/admin/ads',
    reviews: '/admin/reviews',
    audit: '/admin/audit',
    settings: '/admin/settings',
    staff: '/admin/staff',
    operations: '/admin/operations',
  },
  sandbox: {
    pay: (reference: string) => `/sandbox/pay/${encodeURIComponent(reference)}`,
    courier: (reference: string) => `/sandbox/courier/${encodeURIComponent(reference)}`,
  },
} as const;

export function withQuery(path: string, params?: Record<string, string | number | undefined | null>): string {
  if (!params) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Only allow same-site relative redirects (prevents open redirects via ?next=). */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
