import { listAddresses } from '@thrift/application';
import { NIGERIAN_STATES } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { Card, CardSection } from '@/components/ui/Card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, safeNext, withQuery } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { archiveAddressAction, createAddressAction, setDefaultAddressAction } from './actions';

export const metadata = { title: 'Delivery addresses' };

export default async function AddressesPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  const next = sp.next ? safeNext(sp.next, '') : '';
  await requireUserPage(withQuery(routes.addresses, { next: next || undefined }));
  const addresses = await listAddresses(await getCtx());
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <PageHeader title="Delivery addresses" description="Private to you. A seller only sees the address for an order after you’ve paid for it." />
      {addresses.length > 0 && (
        <ul className="space-y-3" aria-label="Saved addresses">
          {addresses.map((a) => (
            <li key={a.id}>
              <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="text-sm">
                  <p className="font-semibold">
                    {a.label} {a.isDefault && <Badge tone="primary">Default</Badge>}
                  </p>
                  <p>{a.recipientName} · {a.phone}</p>
                  <p className="text-muted">{[a.line1, a.line2, a.area, a.city, a.state].filter(Boolean).join(', ')}</p>
                  {a.landmark && <p className="text-muted">Landmark: {a.landmark}</p>}
                </div>
                <div className="flex gap-2">
                  {!a.isDefault && (
                    <ActionForm action={setDefaultAddressAction} showSuccess={false}>
                      <input type="hidden" name="addressId" value={a.id} />
                      <SubmitButton variant="secondary" size="sm">Make default</SubmitButton>
                    </ActionForm>
                  )}
                  <ActionForm action={archiveAddressAction} showSuccess={false}>
                    <input type="hidden" name="addressId" value={a.id} />
                    <SubmitButton variant="ghost" size="sm">Remove</SubmitButton>
                  </ActionForm>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <CardSection title="Add an address">
        <ActionForm action={createAddressAction} resetOnSuccess className="grid gap-4 sm:grid-cols-2">
          {next && <input type="hidden" name="next" value={next} />}
          <TextField label="Label" name="label" placeholder="Home, Office…" defaultValue="Home" />
          <TextField label="Recipient name" name="recipientName" required autoComplete="name" />
          <TextField label="Phone number" name="phone" required autoComplete="tel" inputMode="tel" placeholder="0803 123 4567" />
          <TextField label="Street address" name="line1" required autoComplete="address-line1" />
          <TextField label="Address line 2" name="line2" autoComplete="address-line2" />
          <TextField label="Area / neighbourhood" name="area" />
          <TextField label="City / town" name="city" required autoComplete="address-level2" />
          <SelectField label="State" name="state" required placeholder="Choose a state" options={NIGERIAN_STATES.map((s) => ({ value: s, label: s }))} />
          <TextField label="Nearest landmark" name="landmark" className="sm:col-span-2" hint="Helps riders find you." />
          <CheckboxField label="Use as my default address" name="isDefault" defaultChecked={addresses.length === 0} className="sm:col-span-2" />
          <div className="sm:col-span-2">
            <SubmitButton pendingText="Saving…">{next ? 'Save and continue' : 'Save address'}</SubmitButton>
          </div>
        </ActionForm>
      </CardSection>
    </div>
  );
}
