import { notFound } from 'next/navigation';
import { reportTarget } from '@thrift/application';
import { REPORT_REASONS, REPORT_REASON_LABEL } from '@thrift/contracts';
import { isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Card } from '@/components/ui/Card';
import { SelectField, TextAreaField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { withQuery } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { submitReportAction } from './actions';

export const metadata = { title: 'Report', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ kind?: string; id?: string }> }) {
  const sp = await searchParams;
  await requireUserPage(withQuery('/report', sp));
  let target;
  try {
    target = await reportTarget(await getCtx(), sp.kind ?? '', sp.id ?? '');
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <PageHeader title="Report a problem" description="Reports are private. The person you report won’t see who reported them." />
      <Card className="p-4">
        <p className="mb-4 text-sm">
          Reporting <span className="font-semibold">{target.label}</span>
        </p>
        <ActionForm action={submitReportAction} refreshOnSuccess={false} className="space-y-4">
          <input type="hidden" name="kind" value={target.kind} />
          <input type="hidden" name="id" value={target.id} />
          <SelectField label="What’s wrong?" name="reason" required placeholder="Choose a reason" options={REPORT_REASONS.map((r) => ({ value: r, label: REPORT_REASON_LABEL[r] }))} />
          <TextAreaField label="Details (optional)" name="details" rows={4} maxLength={2000} hint="What did you see? Links or quotes help. Don’t include your own contact details." />
          <SubmitButton pendingText="Sending…">Send report</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
