import { redirect } from 'next/navigation';
import { findOwnShop, sellerReviews } from '@thrift/application';
import { ReviewCard } from '@/components/trust/ReviewCard';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextAreaField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { replyAction } from './actions';

export const metadata = { title: 'Reviews' };
export const dynamic = 'force-dynamic';

export default async function SellerReviewsPage() {
  const user = await requireUserPage(routes.sell.reviews);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const reviews = await sellerReviews(await getCtx());
  return (
    <div className="space-y-5">
      <PageHeader title="Reviews" description="Reply once to each review (you can edit for 48 hours). Reviews are only hidden for clear policy violations — report one if it breaks the rules." />
      {reviews.length === 0 ? (
        <EmptyState title="No reviews yet">Buyers can review an order after it’s delivered.</EmptyState>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <ReviewCard key={r.id} r={r}>
              {r.canEditReply && r.status !== 'removed' && (
                <ActionForm action={replyAction} className="mt-3 space-y-2">
                  <input type="hidden" name="reviewId" value={r.id} />
                  <TextAreaField label={r.sellerReply ? 'Edit your reply' : 'Reply publicly'} name="reply" rows={2} defaultValue={r.sellerReply ?? ''} required />
                  <SubmitButton variant="secondary" size="sm">Save reply</SubmitButton>
                </ActionForm>
              )}
            </ReviewCard>
          ))}
        </div>
      )}
    </div>
  );
}
