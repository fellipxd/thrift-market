import { redirect } from 'next/navigation';
import { findOwnShop, getOwnPayoutAccount, getShopSettings, NIGERIAN_BANKS } from '@thrift/application';
import { formatWat, minorToMajorString, NIGERIAN_STATES, stateLabel } from '@thrift/domain';
import { ChecklistCard } from '@/components/catalogue/ChecklistCard';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { ShopProfileFields } from '../onboarding/ShopProfileFields';
import { pauseShopAction, payoutAccountAction, publishShopAction, resumeShopAction, updateCoverageAction, updateProfileAction } from './actions';

export const metadata = { title: 'Shop settings' };

function StateChecklist({ name, selected, legend, hint }: { name: string; selected: string[]; legend: string; hint?: string }) {
  return (
    <fieldset className="rounded-[var(--radius-control)] border border-line p-3">
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      {hint && <p className="mb-2 text-sm text-muted">{hint}</p>}
      <div className="grid max-h-64 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto sm:grid-cols-3">
        {NIGERIAN_STATES.map((s) => (
          <label key={s} className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" name={name} value={s} defaultChecked={selected.includes(s)} className="size-4 accent-[var(--color-primary)]" />
            {stateLabel(s)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default async function ShopSettingsPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const user = await requireUserPage(routes.sell.settings);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const { welcome } = await searchParams;
  const ctx = await getCtx();
  const [s, payout] = await Promise.all([getShopSettings(ctx), getOwnPayoutAccount(ctx)]);
  const c = s.coverage;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Shop settings" description={`${s.name} · /shops/${s.slug}`} />
      {welcome && <Alert tone="success" title="Shop created">Next, confirm your delivery coverage and add a payout account. Then open your shop.</Alert>}
      {s.status === 'draft' && (
        <CardSection title="Open your shop">
          {s.checklist.readyToPublish ? (
            <ActionForm action={publishShopAction}>
              <p className="mb-3 text-sm text-muted">Everything required is in place.</p>
              <SubmitButton pendingText="Opening…">Open my shop</SubmitButton>
            </ActionForm>
          ) : (
            <ChecklistCard checklist={s.checklist} />
          )}
        </CardSection>
      )}

      <div id="profile">
        <CardSection title="Shop profile">
          <ActionForm action={updateProfileAction} className="space-y-4">
            <ShopProfileFields d={{ name: s.name, bio: s.bio, state: s.state, city: s.city, area: s.area, dispatchDays: s.dispatchDays, returnsPolicy: s.returnsPolicy }} />
            <SubmitButton pendingText="Saving…">Save profile</SubmitButton>
          </ActionForm>
        </CardSection>
      </div>

      <div id="coverage">
        <CardSection title="Delivery coverage" action={c.confirmed ? <Badge tone="success">Confirmed</Badge> : <Badge tone="warning">Please confirm</Badge>}>
          <p className="mb-4 text-sm text-muted">Currently: {c.summary}. At checkout we only offer what you cover <em>and</em> what couriers actually support for the buyer’s address.</p>
          <ActionForm action={updateCoverageAction} className="space-y-5">
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Where do you deliver?</legend>
              {(
                [
                  ['local', `Only within ${stateLabel(s.state)}`],
                  ['states', `${stateLabel(s.state)} plus selected states`],
                  ['national', 'Nationwide (except any states you exclude)'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex min-h-10 items-center gap-2">
                  <input type="radio" name="scope" value={value} defaultChecked={c.scope === value} className="size-4 accent-[var(--color-primary)]" />
                  {label}
                </label>
              ))}
            </fieldset>
            <details open={c.scope === 'states'}>
              <summary className="cursor-pointer text-sm font-semibold text-primary">Choose states (for “selected states”)</summary>
              <div className="mt-2"><StateChecklist name="states" selected={c.states} legend="Also deliver to" /></div>
            </details>
            <details open={c.excludedStates.length > 0}>
              <summary className="cursor-pointer text-sm font-semibold text-primary">Exclude states</summary>
              <div className="mt-2"><StateChecklist name="excludedStates" selected={c.excludedStates} legend="Never deliver to" /></div>
            </details>
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">How buyers can receive orders</legend>
              <CheckboxField name="offersSellerArranged" label="Seller-arranged delivery" defaultChecked={c.offersSellerArranged} hint="You send it with your own rider or courier and report progress. Buyers confirm receipt before you are paid." />
              <CheckboxField name="offersIntegrated" label="Platform courier" defaultChecked={c.offersIntegrated} hint="Booked through the platform with courier milestone tracking (sandbox courier in this environment)." />
              <CheckboxField name="offersPickup" label="Pickup" defaultChecked={c.offersPickup} hint="Buyers in your city collect from a public pickup point." />
            </fieldset>
            <TextField label="Pickup point (if offering pickup)" name="pickupNote" defaultValue={s.pickupNote ?? ''} maxLength={200} hint="A public landmark, e.g. “Yaba Market, Gate 2”. Never your home address." />
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField label="Same-city fee (₦)" name="sameCityFee" inputMode="decimal" defaultValue={minorToMajorString(c.sameCityFeeMinor)} />
              <TextField label="Same-state fee (₦)" name="sameStateFee" inputMode="decimal" defaultValue={minorToMajorString(c.sameStateFeeMinor)} />
              <TextField label="Interstate fee (₦)" name="interstateFee" inputMode="decimal" defaultValue={minorToMajorString(c.interstateFeeMinor)} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Fastest transit (days)" name="transitDaysMin" inputMode="numeric" defaultValue={String(c.transitDaysMin)} />
              <TextField label="Slowest transit (days)" name="transitDaysMax" inputMode="numeric" defaultValue={String(c.transitDaysMax)} />
            </div>
            <SubmitButton pendingText="Saving…">Save coverage</SubmitButton>
          </ActionForm>
        </CardSection>
      </div>

      <div id="payout">
        <CardSection title="Payout account">
          {payout ? (
            <div className="mb-4 rounded-[var(--radius-control)] bg-canvas p-3 text-sm">
              <p className="font-medium">
                {payout.bankName} · ••••{payout.accountNumberLast4} · {payout.accountName}
              </p>
              <p className="text-muted">
                {payout.status === 'verified' ? 'Verified' : 'Name check pending'}
                {payout.coolingOff ? ` · can receive payouts from ${formatWat(payout.usableAfter)} (security cooling-off after a change)` : ''}
                {payout.sandbox ? ' · sandbox check' : ''}
              </p>
            </div>
          ) : (
            <p className="mb-4 text-sm text-muted">Add the bank account that receives your payouts. We store only the last 4 digits.</p>
          )}
          <ActionForm action={payoutAccountAction} className="space-y-4" resetOnSuccess>
            <SelectField label="Bank" name="bankCode" required placeholder="Choose your bank" options={NIGERIAN_BANKS.map((b) => ({ value: b.code, label: b.name }))} />
            <TextField label="Account number (10 digits)" name="accountNumber" inputMode="numeric" autoComplete="off" maxLength={13} required />
            <TextField label="Account name" name="accountName" autoComplete="off" required hint="Should match your name or registered business name." />
            {payout && <p className="text-sm text-warning">Changing your payout account starts a security cooling-off period before payouts resume. You’ll be notified.</p>}
            <SubmitButton pendingText="Saving…">{payout ? 'Replace payout account' : 'Add payout account'}</SubmitButton>
          </ActionForm>
        </CardSection>
      </div>

      {s.status !== 'draft' && (
        <CardSection title={s.status === 'paused' ? 'Resume your shop' : 'Pause your shop'}>
          {s.status === 'paused' ? (
            <ActionForm action={resumeShopAction}>
              <p className="mb-3 text-sm text-muted">Your listings become visible and buyable again.</p>
              <SubmitButton pendingText="Resuming…">Resume shop</SubmitButton>
            </ActionForm>
          ) : s.status === 'active' ? (
            <ActionForm action={pauseShopAction} className="space-y-3">
              <p className="text-sm text-muted">Going away? Pausing hides your listings and stops new orders. You still fulfil existing orders and handle any disputes.</p>
              <TextField label="Note for buyers (optional)" name="note" maxLength={200} placeholder="Back on 20 October" />
              <SubmitButton variant="secondary" pendingText="Pausing…">Pause shop</SubmitButton>
            </ActionForm>
          ) : (
            <Alert tone="error">This shop is suspended{s.statusReason ? `: ${s.statusReason}` : ''}. Contact support.</Alert>
          )}
        </CardSection>
      )}
    </div>
  );
}
