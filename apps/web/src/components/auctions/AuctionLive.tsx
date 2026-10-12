'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { AuctionView } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { Countdown } from '@/components/ui/Countdown';
import { routes } from '@/lib/routes';

type FormState =
  | { status: 'idle' }
  | { status: 'success'; message?: string; data?: unknown }
  | { status: 'error'; message: string; code?: string; fieldErrors?: Record<string, string> };
type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const POLL_MS = 3000;
const watFmt = new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });
const timeFmt = new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Lagos' });

function newKey(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Live auction panel: polls the server snapshot every 3s while visible (backing off on errors), keeps the countdown
 * honest with server time, announces leader/outbid changes, and runs a two-step bid (review terms → confirm).
 */
export function AuctionLive({
  initial,
  clientKey,
  bidAction,
  acceptSecondChance,
  declineSecondChance,
}: {
  initial: AuctionView;
  clientKey: string;
  bidAction: Action;
  acceptSecondChance: Action;
  declineSecondChance: Action;
}) {
  const [view, setView] = useState(initial);
  const [announcement, setAnnouncement] = useState('');
  const prevLeader = useRef(initial.viewer.isLeader);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/v1/auctions/${initial.id}`, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`poll ${res.status}`);
    setView((await res.json()) as AuctionView);
  }, [initial.id]);

  useEffect(() => {
    let delay = POLL_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          await poll();
          delay = POLL_MS;
        } catch {
          delay = Math.min(Math.max(delay * 2, 5000), 60_000);
        }
      }
      if (!stopped) timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  useEffect(() => {
    if (prevLeader.current && !view.viewer.isLeader && view.phase === 'live') setAnnouncement(`You’ve been outbid. The current bid is ${formatNaira(view.currentBidMinor ?? 0)}.`);
    else if (!prevLeader.current && view.viewer.isLeader) setAnnouncement('You have the highest bid.');
    prevLeader.current = view.viewer.isLeader;
  }, [view.viewer.isLeader, view.phase, view.currentBidMinor]);

  const v = view;
  const badge = v.phase === 'live' ? <Badge tone="success">Live</Badge> : v.phase === 'upcoming' ? <Badge tone="info">Upcoming</Badge> : <Badge tone="neutral">Ended</Badge>;
  return (
    <div className="space-y-4">
      <p className="sr-only" aria-live="assertive">
        {announcement}
      </p>
      <div className="rounded-[var(--radius-card)] border-2 border-primary/20 bg-surface p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          {badge}
          <span className="text-xs text-muted">{v.bidCount} bid{v.bidCount === 1 ? '' : 's'}</span>
        </div>
        <p className="text-sm text-muted">{v.currentBidMinor ? 'Current bid' : 'Opening price'}</p>
        <p className="font-serif text-4xl text-ink" data-testid="current-bid">
          {formatNaira(v.currentBidMinor ?? v.openingPriceMinor)}
        </p>
        {v.phase !== 'ended' && (
          <p className="mt-1 text-sm">
            Minimum next bid: <strong data-testid="minimum-next-bid">{formatNaira(v.minimumNextBidMinor)}</strong>
          </p>
        )}
        <p className="mt-3 text-sm">
          {v.phase === 'upcoming' ? (
            <>
              Starts {watFmt.format(new Date(v.startsAt))} WAT · in <Countdown target={v.startsAt} serverNow={v.serverNow} expiredText="moments" />
            </>
          ) : v.phase === 'live' ? (
            <>
              Ends {watFmt.format(new Date(v.endsAt))} WAT · <Countdown target={v.endsAt} serverNow={v.serverNow} expiredText="ending now" /> left
              <span className="block text-xs text-muted">Server time decides. {v.extended && 'Extended after a late bid.'}</span>
            </>
          ) : (
            <>Ended {watFmt.format(new Date(v.endsAt))} WAT · {v.statusLabel}</>
          )}
        </p>
        {v.viewer.isLeader && v.phase === 'live' && (
          <p className="mt-3 rounded-md bg-success-soft px-3 py-2 text-sm font-semibold text-success">You have the highest bid.</p>
        )}
        {!v.viewer.isLeader && v.viewer.hasBid && v.phase === 'live' && (
          <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-sm font-semibold text-warning">You’ve been outbid.</p>
        )}
      </div>

      {v.viewer.mustPay && (
        <Alert tone="success" title="You won this auction">
          <span className="block">
            Pay by {watFmt.format(new Date(v.viewer.mustPay.deadline))} WAT (<Countdown target={v.viewer.mustPay.deadline} serverNow={v.serverNow} expiredText="deadline passed" /> left).
            Delivery is added at checkout.
          </span>
          <Link href={v.viewer.mustPay.checkoutPath} className={buttonClass('primary', 'md', 'mt-2')}>
            Pay now
          </Link>
        </Alert>
      )}
      {v.viewer.isWinner && v.viewer.paid && <Alert tone="success">You won and paid. Follow delivery from your orders.</Alert>}
      {v.phase === 'ended' && v.viewer.hasBid && !v.viewer.isWinner && !v.viewer.secondChance && (
        <Alert tone="info">This auction has ended. You weren’t the winning bidder and haven’t been charged — bids are never payments.</Alert>
      )}
      {v.viewer.secondChance && <SecondChance offer={v.viewer.secondChance} serverNow={v.serverNow} accept={acceptSecondChance} decline={declineSecondChance} onDone={() => poll().catch(() => undefined)} />}

      {v.phase === 'live' && <BidForm view={v} clientKey={clientKey} action={bidAction} onDone={() => poll().catch(() => undefined)} />}
      {v.phase === 'upcoming' && <p className="text-sm text-muted">Bidding opens when the auction starts.</p>}

      {v.viewer.delivery ? (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-3 text-sm">
          <p className="font-semibold">Delivery to {v.viewer.delivery.destination}</p>
          {v.viewer.delivery.options.length === 0 ? (
            <p className="text-warning">This seller doesn’t deliver there. Add another address to bid.</p>
          ) : (
            <ul className="text-muted">
              {v.viewer.delivery.options.map((o) => (
                <li key={o.label}>
                  {o.label}: {o.feeMinor === 0 ? 'free' : formatNaira(o.feeMinor)} · {o.transitDaysMin}–{o.transitDaysMax} days
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-muted">Bids are for the item only; delivery is charged separately at checkout.</p>
        </div>
      ) : (
        <p className="text-xs text-muted">Bids are for the item only; delivery is charged separately and confirmed for your address.</p>
      )}

      <section aria-labelledby="bid-history-h" className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
        <h2 id="bid-history-h" className="mb-2 font-serif text-xl">Bid history</h2>
        {v.bids.length === 0 ? (
          <p className="text-sm text-muted">No bids yet.</p>
        ) : (
          <ol className="divide-y divide-line text-sm">
            {v.bids.map((b) => (
              <li key={b.seq} className="flex justify-between gap-2 py-1.5">
                <span className={b.mine ? 'font-semibold' : ''}>{b.bidderLabel}</span>
                <span className="font-semibold">{formatNaira(b.amountMinor)}</span>
                <time dateTime={b.at} className="text-muted">{timeFmt.format(new Date(b.at))}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function BidForm({ view, clientKey, action, onDone }: { view: AuctionView; clientKey: string; action: Action; onDone: () => void }) {
  const [state, formAction] = useActionState(action, { status: 'idle' } as FormState);
  const [key, setKey] = useState(clientKey);
  const [amount, setAmount] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (state.status === 'success') {
      setKey(newKey());
      setAmount('');
      setReviewing(false);
    }
    if (state.status === 'error') setReviewing(false);
    if (state.status !== 'idle') onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const v = view.viewer;
  if (!v.canBid) {
    return (
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-3 text-sm">
        {state.status === 'success' && state.message && <p className="mb-2 text-success">{state.message}</p>}
        <p className="text-muted">{v.cannotBidReason}</p>
        {!v.signedIn && (
          <Link href={routes.auth.signIn(routes.auction(view.id))} className={buttonClass('primary', 'md', 'mt-2')}>
            Sign in to bid
          </Link>
        )}
        {v.signedIn && v.cannotBidReason?.includes('address') && (
          <Link href={`${routes.addresses}?next=${encodeURIComponent(routes.auction(view.id))}`} className={buttonClass('secondary', 'sm', 'mt-2')}>
            Add a delivery address
          </Link>
        )}
      </div>
    );
  }
  const amountMinor = Math.round(Number(amount.replace(/[₦,\s]/g, '')) * 100);
  const review = () => {
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return setLocalError('Enter your bid in naira.');
    if (amountMinor < view.minimumNextBidMinor) return setLocalError(`Your bid must be at least ${formatNaira(view.minimumNextBidMinor)}.`);
    setLocalError(null);
    setReviewing(true);
  };
  return (
    <form action={formAction} className="space-y-3 rounded-[var(--radius-card)] border border-line bg-surface p-3">
      <input type="hidden" name="auctionId" value={view.id} />
      <input type="hidden" name="idempotencyKey" value={key} />
      {state.status === 'error' && (
        <p role="alert" className="rounded-md bg-error-soft px-2 py-1 text-sm text-error">
          {state.message}
        </p>
      )}
      {state.status === 'success' && state.message && <p className="rounded-md bg-success-soft px-2 py-1 text-sm text-success">{state.message}</p>}
      <label className="block text-sm font-medium" htmlFor="bid-amount">
        Your bid (₦)
      </label>
      <input
        id="bid-amount"
        name="amount"
        inputMode="numeric"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setReviewing(false);
        }}
        placeholder={String(view.minimumNextBidMinor / 100)}
        className="block w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2 text-lg"
        aria-describedby="bid-hint"
      />
      <p id="bid-hint" className="text-xs text-muted">
        At least {formatNaira(view.minimumNextBidMinor)}.
      </p>
      {localError && (
        <p role="alert" className="text-sm text-error">
          {localError}
        </p>
      )}
      {!reviewing ? (
        <button type="button" onClick={review} className={buttonClass('primary', 'lg', 'w-full')}>
          Review bid and terms
        </button>
      ) : (
        <div className="space-y-2 rounded-md bg-sand p-3 text-sm">
          <p>
            You’re bidding <strong>{formatNaira(amountMinor)}</strong> for the item. A bid is a commitment to buy, not a payment. If you win, you pay within{' '}
            {view.rules.winnerPaymentHours} hours at checkout, plus delivery. Bids can’t be withdrawn.
          </p>
          <ConfirmButton amount={formatNaira(amountMinor)} />
          <button type="button" onClick={() => setReviewing(false)} className={buttonClass('ghost', 'sm', 'w-full')}>
            Change amount
          </button>
        </div>
      )}
    </form>
  );
}

function ConfirmButton({ amount }: { amount: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass('primary', 'lg', 'w-full')}>
      {pending ? 'Placing bid…' : `Confirm bid of ${amount}`}
    </button>
  );
}

function SecondChance({
  offer,
  serverNow,
  accept,
  decline,
  onDone,
}: {
  offer: NonNullable<AuctionView['viewer']['secondChance']>;
  serverNow: string;
  accept: Action;
  decline: Action;
  onDone: () => void;
}) {
  const [acceptState, acceptAction] = useActionState(accept, { status: 'idle' } as FormState);
  const [declineState, declineAction] = useActionState(decline, { status: 'idle' } as FormState);
  useEffect(() => {
    if (declineState.status !== 'idle' || acceptState.status !== 'idle') onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptState, declineState]);
  if (offer.status === 'accepted' && offer.checkoutPath) {
    return (
      <Alert tone="success" title="Second chance accepted">
        <Link href={offer.checkoutPath} className={buttonClass('primary', 'md', 'mt-1')}>
          Pay now
        </Link>
      </Alert>
    );
  }
  if (offer.status !== 'pending') return null;
  return (
    <Alert tone="info" title={`Second chance: buy it for ${formatNaira(offer.amountMinor)}`}>
      <span className="block">
        The winner didn’t pay. You can buy it at your highest bid. Nothing is charged or reserved unless you accept. Reply within{' '}
        <Countdown target={offer.expiresAt} serverNow={serverNow} expiredText="moments" />.
      </span>
      {acceptState.status === 'error' && <span className="mt-1 block text-error">{acceptState.message}</span>}
      <div className="mt-2 flex gap-2">
        <form action={acceptAction}>
          <input type="hidden" name="offerId" value={offer.offerId} />
          <SmallSubmit>Accept and pay</SmallSubmit>
        </form>
        <form action={declineAction}>
          <input type="hidden" name="offerId" value={offer.offerId} />
          <SmallSubmit variant="ghost">Decline</SmallSubmit>
        </form>
      </div>
    </Alert>
  );
}

function SmallSubmit({ children, variant = 'primary' }: { children: React.ReactNode; variant?: 'primary' | 'ghost' }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass(variant, 'sm')}>
      {children}
    </button>
  );
}
