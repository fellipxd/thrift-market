import { orderReviewItems, type OrderDetail } from '@thrift/application';
import { formatWat } from '@thrift/domain';
import { ReviewCard } from '@/components/trust/ReviewCard';
import { RatingInput } from '@/components/trust/Stars';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { CardSection } from '@/components/ui/Card';
import { TextAreaField } from '@/components/ui/Field';
import { getCtx } from '@/server/session';
import { submitReviewAction } from './review-actions';

/** Buyer: review each delivered item once (verified purchase), or see the review they left. */
export async function OrderReviewPanel({ order }: { order: OrderDetail }) {
  if (order.status === 'pending_payment' || order.status === 'cancelled') return null;
  const items = await orderReviewItems(await getCtx(), order.id);
  const relevant = items.filter((i) => i.review || i.canReview);
  if (relevant.length === 0) return null;
  return (
    <CardSection title="Review your purchase">
      <div className="space-y-4">
        {relevant.map((i) =>
          i.review ? (
            <ReviewCard key={i.orderItemId} r={i.review} />
          ) : (
            <ActionForm key={i.orderItemId} action={submitReviewAction} className="space-y-3">
              <input type="hidden" name="orderItemId" value={i.orderItemId} />
              <p className="text-sm text-muted">
                How was “{i.title}”? Your review helps other buyers.{i.windowEndsAt && ` You can review until ${formatWat(i.windowEndsAt)}.`}
              </p>
              <RatingInput name="overall" label="Overall" />
              <RatingInput name="accuracy" label="Condition as described" />
              <RatingInput name="communication" label="Communication" />
              <RatingInput name="delivery" label="Delivery" />
              <TextAreaField label="Your review (optional)" name="body" rows={3} maxLength={1500} />
              <SubmitButton>Post review</SubmitButton>
            </ActionForm>
          ),
        )}
      </div>
    </CardSection>
  );
}
