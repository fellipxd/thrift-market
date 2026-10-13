import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { CardSection } from '@/components/ui/Card';
import { TextAreaField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { requireStaffPage } from '@/server/session';
import { requestStaffRefundAction } from './actions';

export const metadata = { title: 'Exception refunds' };

/** Support, finance and admin raise goodwill/exception refunds; a different finance or admin member approves them. */
export default async function ExceptionRefundsPage() {
  await requireStaffPage(routes.admin.refunds);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Exception refunds"
        description="For problems outside the dispute rules (for example goodwill after a support failure). The refund waits for a different finance or admin team member to approve it, and you can’t raise one on an order you bought or sold."
      />
      <CardSection title="Request a refund">
        <ActionForm action={requestStaffRefundAction} className="max-w-md space-y-3" resetOnSuccess>
          <TextField label="Order number" name="orderNumber" placeholder="TM1234" required />
          <TextField label="Amount (₦)" name="amount" inputMode="decimal" required hint="At most what is still refundable on the order." />
          <TextAreaField label="Why (kept with the refund and shown to approvers)" name="note" rows={3} required />
          <SubmitButton pendingText="Requesting…">Request refund</SubmitButton>
        </ActionForm>
      </CardSection>
    </div>
  );
}
