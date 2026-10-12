import { redirect } from 'next/navigation';
import { findOwnShop } from '@thrift/application';
import { Alert } from '@/components/ui/Alert';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { requireUserPage } from '@/server/session';
import { createShopAction } from '../settings/actions';
import { ShopProfileFields } from './ShopProfileFields';

export const metadata = { title: 'Open your shop' };

export default async function OnboardingPage() {
  const user = await requireUserPage(routes.sell.onboarding);
  if (await findOwnShop(services().pool, user.userId)) redirect(routes.sell.home);
  return (
    <div className="max-w-2xl">
      <PageHeader eyebrow="Start selling" title="Open your shop" description="Bring your WhatsApp, Instagram and Telegram customers to one shop link with a live catalogue." />
      {!user.contactVerified && (
        <Alert tone="warning" className="mb-4" title="Verify your contact first">
          Sellers need a verified email or phone number. <a className="font-semibold underline" href={routes.auth.verify(routes.sell.onboarding)}>Verify now</a>
        </Alert>
      )}
      <Card className="p-5">
        <ActionForm action={createShopAction} className="space-y-5">
          <ShopProfileFields />
          <SubmitButton pendingText="Creating shop…">Create shop</SubmitButton>
        </ActionForm>
      </Card>
      <p className="mt-4 text-sm text-muted">Next: confirm where you deliver and add your payout account. Your shop opens when those are done.</p>
    </div>
  );
}
