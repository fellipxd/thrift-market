import { redirect } from 'next/navigation';
import { findOwnShop, getOwnVerification, ID_TYPE_LABEL, ID_TYPES, VERIFICATION_EXPLAINER } from '@thrift/application';
import { formatWat, formatWatDate } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { CardSection } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { submitVerificationAction } from './actions';
import { EvidenceUploader } from './EvidenceUploader';

export const metadata = { title: 'Identity verification' };

export default async function VerificationPage() {
  const user = await requireUserPage(routes.sell.verification);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const v = await getOwnVerification(await getCtx());
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Identity verification" description={VERIFICATION_EXPLAINER} />
      {v.shopVerificationStatus === 'approved' && (
        <Alert tone="success" title={v.verificationLabel ?? 'Identity checked'}>
          {v.verifiedAt ? `Checked on ${formatWatDate(v.verifiedAt)}. ` : ''}Buyers see this note on your shop and listings.
        </Alert>
      )}
      {v.latestCase && v.latestCase.status === 'pending' && (
        <Alert tone="info" title="Under review">Submitted {formatWat(v.latestCase.submittedAt)} with {v.latestCase.evidenceCount} photo(s). We’ll notify you when it’s decided.</Alert>
      )}
      {v.latestCase?.status === 'rejected' && (
        <Alert tone="warning" title="Not approved">
          {v.latestCase.rejectionReason ?? 'Please submit clearer documents.'} You can submit again below.
        </Alert>
      )}
      {v.canSubmit && (
        <CardSection title="Submit documents">
          <ActionForm action={submitVerificationAction} className="space-y-4">
            <TextField label="Legal name (as on the document)" name="legalName" required maxLength={120} />
            <SelectField label="Document type" name="idType" required placeholder="Choose" options={ID_TYPES.map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} />
            <TextField label="Last 4 characters of the document number" name="idNumberLast4" required maxLength={4} hint="We only store the last 4 characters." />
            <EvidenceUploader />
            <SubmitButton pendingText="Submitting…">Submit for review</SubmitButton>
          </ActionForm>
        </CardSection>
      )}
    </div>
  );
}
