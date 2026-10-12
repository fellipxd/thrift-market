'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { MessageView, OfferThreadView, OfferView } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { Alert } from '@/components/ui/Alert';
import { buttonClass } from '@/components/ui/Button';
import { Countdown } from '@/components/ui/Countdown';
import { cx } from '@/lib/format';
import { routes } from '@/lib/routes';

type FormState =
  | { status: 'idle' }
  | { status: 'success'; message?: string; data?: unknown }
  | { status: 'error'; message: string; code?: string; fieldErrors?: Record<string, string> };
type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const SAFETY_NOTICE = 'Pay through checkout to keep your purchase protected. Never pay by direct bank transfer or move the conversation off Thrift Market.';
const POLL_MS = 4000;

function newKey(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '');
}

function mergeMessages(prev: MessageView[], incoming: MessageView[]): MessageView[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const timeFmt = new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });
const dayFmt = new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });

export interface ConversationThreadProps {
  conversationId: string;
  role: 'buyer' | 'seller';
  listing: { id: string; negotiable: boolean; available: number; status: string } | null;
  initialMessages: MessageView[];
  initialOfferThreads: OfferThreadView[];
  initialBlocked: boolean;
  serverNow: string;
  clientKey: string;
  sendAction: Action;
  offerAction: Action;
}

/**
 * The live part of a conversation: message list, offer cards, composer. Polls for new messages every few seconds
 * while the tab is visible (backing off on errors) and merges them without reloading the page.
 */
export function ConversationThread(props: ConversationThreadProps) {
  const { conversationId, role } = props;
  const [messages, setMessages] = useState(props.initialMessages);
  const [threads, setThreads] = useState(props.initialOfferThreads);
  const [blocked, setBlocked] = useState(props.initialBlocked);
  const [serverNow, setServerNow] = useState(props.serverNow);
  const [offline, setOffline] = useState(false);
  const lastIdRef = useRef<string | undefined>(props.initialMessages.at(-1)?.id);
  const listRef = useRef<HTMLOListElement>(null);

  // A server refresh (after a form action) brings new props: merge rather than replace.
  useEffect(() => {
    setMessages((prev) => mergeMessages(prev, props.initialMessages));
    setThreads(props.initialOfferThreads);
    setBlocked(props.initialBlocked);
    setServerNow(props.serverNow);
  }, [props.initialMessages, props.initialOfferThreads, props.initialBlocked, props.serverNow]);

  useEffect(() => {
    lastIdRef.current = messages.at(-1)?.id;
  }, [messages]);

  const poll = useCallback(async () => {
    const after = lastIdRef.current;
    const res = await fetch(`/api/v1/conversations/${conversationId}/messages${after ? `?after=${encodeURIComponent(after)}` : ''}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`poll ${res.status}`);
    const data = (await res.json()) as { messages: MessageView[]; offerThreads: OfferThreadView[]; block: { blocked: boolean }; serverNow: string };
    setMessages((prev) => mergeMessages(prev, data.messages));
    setThreads(data.offerThreads);
    setBlocked(data.block.blocked);
    setServerNow(data.serverNow);
  }, [conversationId]);

  useEffect(() => {
    let delay = POLL_MS;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          await poll();
          delay = POLL_MS;
          setOffline(false);
        } catch {
          delay = Math.min(delay * 2, 60_000);
          setOffline(true);
        }
      }
      if (!stopped) timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll().catch(() => setOffline(true));
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  // Keep the newest message in view when messages arrive.
  const count = messages.length;
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [count]);

  const offersById = new Map<string, { offer: OfferView; thread: OfferThreadView }>();
  for (const t of threads) for (const o of t.offers) offersById.set(o.id, { offer: o, thread: t });
  const accepted = threads.find((t) => t.status === 'accepted' && t.reservation && ['active', 'payment_pending'].includes(t.reservation.status));
  const openThread = threads.find((t) => t.status === 'open');
  const canOffer = role === 'buyer' && props.listing?.negotiable && props.listing.status === 'active' && props.listing.available > 0 && !accepted && !openThread?.pending && !blocked;

  let lastDay = '';
  return (
    <div className="flex flex-col gap-3">
      {accepted && (
        <Alert tone="success" title={`Offer accepted at ${formatNaira(accepted.agreedPriceMinor ?? 0)}`}>
          {role === 'buyer' ? (
            <>
              <span className="block">
                The piece is held for you for <Countdown target={accepted.reservation!.expiresAt} serverNow={serverNow} expiredText="— the hold has ended" />.
              </span>
              {accepted.checkoutPath && (
                <Link href={accepted.checkoutPath} className={buttonClass('primary', 'md', 'mt-2')}>
                  Continue to checkout
                </Link>
              )}
            </>
          ) : (
            <span>
              Reserved for the buyer for <Countdown target={accepted.reservation!.expiresAt} serverNow={serverNow} expiredText="— the hold has ended" /> while they pay.
            </span>
          )}
        </Alert>
      )}

      <ol ref={listRef} className="flex flex-col gap-2" aria-label="Messages" aria-live="polite">
        {messages.length === 0 && <li className="py-8 text-center text-sm text-muted">No messages yet. Say hello and ask anything about the item.</li>}
        {messages.map((m) => {
          const day = dayFmt.format(new Date(m.createdAt));
          const showDay = day !== lastDay;
          lastDay = day;
          const offerInfo = m.offerId ? offersById.get(m.offerId) : undefined;
          return (
            <li key={m.id} className="flex flex-col">
              {showDay && <p className="my-2 text-center text-xs font-semibold uppercase tracking-wide text-muted">{day}</p>}
              {m.kind === 'system' ? (
                <p className="mx-auto max-w-[85%] rounded-sm bg-sand px-3 py-1 text-center text-xs text-ink">{m.body}</p>
              ) : m.kind === 'offer' && offerInfo ? (
                <OfferCard message={m} offer={offerInfo.offer} thread={offerInfo.thread} role={role} serverNow={serverNow} action={props.offerAction} blocked={blocked} onDone={() => poll().catch(() => undefined)} />
              ) : (
                <MessageBubble message={m} />
              )}
            </li>
          );
        })}
      </ol>

      {offline && <p className="text-center text-xs text-muted">Reconnecting… new messages will appear when you’re back online.</p>}

      {canOffer && props.listing && (
        <Link href={routes.itemOffer(props.listing.id)} className={buttonClass('secondary', 'sm', 'self-start')}>
          Make an offer
        </Link>
      )}

      {blocked ? (
        <Alert tone="warning">Messaging is turned off in this conversation because one of you has blocked the other.</Alert>
      ) : (
        <Composer
          conversationId={conversationId}
          initialKey={props.clientKey}
          action={props.sendAction}
          onSent={(m) => setMessages((prev) => mergeMessages(prev, [m]))}
        />
      )}
      <p className="text-xs text-muted">{SAFETY_NOTICE}</p>
    </div>
  );
}

function MessageBubble({ message: m }: { message: MessageView }) {
  const mine = m.fromViewerSide;
  return (
    <div className={cx('flex max-w-[85%] flex-col', mine ? 'items-end self-end' : 'items-start self-start')}>
      {!mine && <span className="mb-0.5 text-xs text-muted">{m.senderName}</span>}
      <div className={cx('rounded-2xl px-3 py-2 text-[15px]', mine ? 'rounded-br-sm bg-primary text-white' : 'rounded-bl-sm border border-line bg-surface text-ink')}>
        {m.hidden ? (
          <span className="italic opacity-80">This message was removed.</span>
        ) : (
          <>
            {m.image && (
              <a href={m.image.url} target="_blank" rel="noreferrer" className="mb-1 block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.image.thumbUrl} alt="Photo sent in chat" className="max-h-60 rounded-lg" loading="lazy" />
              </a>
            )}
            {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
          </>
        )}
      </div>
      <div className="mt-0.5 flex gap-2 text-[11px] text-muted">
        <time dateTime={m.createdAt}>{timeFmt.format(new Date(m.createdAt))}</time>
        {!mine && !m.hidden && (
          <Link href={routes.report('message', m.id)} className="underline">
            Report
          </Link>
        )}
      </div>
      {m.safetyFlag && <p className="mt-1 max-w-xs rounded-md bg-warning-soft px-2 py-1 text-xs text-warning">⚠ {SAFETY_NOTICE}</p>}
    </div>
  );
}

function OfferCard({
  message,
  offer,
  thread,
  role,
  serverNow,
  action,
  blocked,
  onDone,
}: {
  message: MessageView;
  offer: OfferView;
  thread: OfferThreadView;
  role: 'buyer' | 'seller';
  serverNow: string;
  action: Action;
  blocked: boolean;
  onDone: () => void;
}) {
  const [state, formAction] = useActionState(action, { status: 'idle' } as FormState);
  const [countering, setCountering] = useState(false);
  useEffect(() => {
    if (state.status !== 'idle') {
      setCountering(false);
      onDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const mine = offer.fromParty === role;
  const isPending = offer.status === 'pending' && thread.status === 'open' && new Date(offer.expiresAt) > new Date(serverNow);
  const who = offer.fromParty === 'buyer' ? (role === 'buyer' ? 'You offered' : 'Buyer offered') : role === 'seller' ? 'You countered' : 'Seller countered';
  return (
    <div className={cx('w-full max-w-sm rounded-[var(--radius-card)] border-2 bg-surface p-3', mine ? 'self-end' : 'self-start', isPending ? 'border-accent' : 'border-line')}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{who}</p>
      <p className="font-serif text-2xl text-ink">{formatNaira(offer.amountMinor)}</p>
      <p className="text-xs text-muted">Item price only — delivery is added at checkout.</p>
      {offer.note && <p className="mt-1 text-sm">“{offer.note}”</p>}
      <p className="mt-2 text-sm">
        <span className="font-semibold">{offer.statusLabel}</span>
        {isPending && (
          <span className="text-muted">
            {' '}
            · expires in <Countdown target={offer.expiresAt} serverNow={serverNow} expiredText="moments" />
          </span>
        )}
      </p>
      {state.status === 'error' && (
        <Alert tone="error" className="mt-2">
          {state.message}
        </Alert>
      )}
      {state.status === 'success' && state.message && <p className="mt-2 text-sm text-success">{state.message}</p>}
      {isPending && !blocked && (
        <form action={formAction} className="mt-3 space-y-2">
          <input type="hidden" name="offerId" value={offer.id} />
          {mine ? (
            <OfferButton name="action" value="withdraw" variant="ghost">
              Withdraw offer
            </OfferButton>
          ) : countering ? (
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Your counteroffer (₦)
                <input name="counterAmount" inputMode="numeric" required className="mt-1 block w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2" />
              </label>
              <label className="block text-sm font-medium">
                Note (optional)
                <input name="note" maxLength={280} className="mt-1 block w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2" />
              </label>
              <div className="flex gap-2">
                <OfferButton name="action" value="counter">Send counteroffer</OfferButton>
                <button type="button" onClick={() => setCountering(false)} className={buttonClass('ghost', 'sm')}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <OfferButton name="action" value="accept">Accept</OfferButton>
              <button type="button" onClick={() => setCountering(true)} className={buttonClass('secondary', 'sm')}>
                Counter
              </button>
              <OfferButton name="action" value="reject" variant="ghost">
                Decline
              </OfferButton>
            </div>
          )}
          {!mine && !countering && role === 'seller' && <p className="text-xs text-muted">Accepting reserves the piece for the buyer at this price while they pay.</p>}
        </form>
      )}
      <time dateTime={message.createdAt} className="mt-2 block text-[11px] text-muted">
        {timeFmt.format(new Date(message.createdAt))}
      </time>
    </div>
  );
}

function OfferButton({ children, name, value, variant = 'primary' }: { children: React.ReactNode; name: string; value: string; variant?: 'primary' | 'secondary' | 'ghost' }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending} aria-busy={pending} className={buttonClass(variant, 'sm')}>
      {children}
    </button>
  );
}

function Composer({ conversationId, initialKey, action, onSent }: { conversationId: string; initialKey: string; action: Action; onSent: (m: MessageView) => void }) {
  const [state, formAction] = useActionState(action, { status: 'idle' } as FormState);
  const [clientKey, setClientKey] = useState(initialKey);
  const [fileName, setFileName] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === 'success' && state.data) {
      onSent(state.data as MessageView);
      formRef.current?.reset();
      setFileName(null);
      setClientKey(newKey());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form ref={formRef} action={formAction} className="rounded-[var(--radius-card)] border border-line bg-surface p-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="clientKey" value={clientKey} />
      {state.status === 'error' && (
        <p role="alert" className="mb-2 rounded-md bg-error-soft px-2 py-1 text-sm text-error">
          {state.message}
        </p>
      )}
      <label htmlFor="composer-body" className="sr-only">
        Write a message
      </label>
      <textarea
        id="composer-body"
        name="body"
        rows={2}
        maxLength={2000}
        placeholder="Write a message…"
        className="w-full resize-y rounded-md border-0 bg-transparent px-2 py-1 text-[15px] focus:outline-none focus:ring-2 focus:ring-primary/30"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) formRef.current?.requestSubmit();
        }}
      />
      <div className="flex items-center justify-between gap-2 px-1">
        <label className="cursor-pointer text-sm font-medium text-primary">
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)} />
          {fileName ? `📎 ${fileName}` : 'Add photo'}
        </label>
        <SendButton />
      </div>
    </form>
  );
}

function SendButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass('primary', 'sm')}>
      {pending ? 'Sending…' : 'Send'}
    </button>
  );
}
