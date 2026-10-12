import { notFound, redirect } from 'next/navigation';
import { startConversation, startOrderConversation } from '@thrift/application';
import { isDomainError } from '@thrift/domain';
import { Alert } from '@/components/ui/Alert';
import { ButtonLink } from '@/components/ui/Button';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireVerifiedPage } from '@/server/session';

export const metadata = { title: 'Message seller' };
export const dynamic = 'force-dynamic';

/** Opens (or reuses) the conversation for an item or an order, then shows it. */
export default async function NewConversationPage({ searchParams }: { searchParams: Promise<{ listing?: string; order?: string }> }) {
  const sp = await searchParams;
  await requireVerifiedPage(withQuery('/inbox/new', sp));
  let conversationId: string;
  try {
    const ctx = await getCtx();
    conversationId = sp.order
      ? (await startOrderConversation(ctx, { orderId: sp.order })).conversationId
      : (await startConversation(ctx, { listingId: sp.listing ?? '' })).conversationId;
  } catch (err) {
    if (!isDomainError(err)) throw err;
    if (err.code === 'NOT_FOUND' || err.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <Alert tone="warning" title="Can’t start this conversation">{err.message}</Alert>
        <div className="mt-4">
          <ButtonLink href={sp.listing ? routes.item(sp.listing) : routes.inbox} variant="secondary">Go back</ButtonLink>
        </div>
      </div>
    );
  }
  redirect(routes.conversation(conversationId));
}
