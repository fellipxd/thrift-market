import { redirect } from 'next/navigation';
import { findOwnShop, listListableCategories, listTemplates } from '@thrift/application';
import { formatNaira, SALE_MODE_LABEL } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { CardSection } from '@/components/ui/Card';
import { CheckboxField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { createDraftAction, createFromTemplateAction, deleteTemplateAction } from '../actions';

export const metadata = { title: 'Add an item' };

export default async function NewListingPage() {
  const user = await requireUserPage(routes.sell.newListing);
  const shop = await findOwnShop(services().pool, user.userId);
  if (!shop) redirect(routes.sell.onboarding);
  const ctx = await getCtx();
  const [categories, templates] = await Promise.all([listListableCategories(ctx.pool), listTemplates(ctx)]);
  const groups = [...new Set(categories.map((c) => c.parentName))];
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Add an item" description="Start with the basics. You’ll add photos, condition, flaws, size and price next — nothing is public until you publish." />
      {shop.status !== 'active' && <Alert tone="info">You can prepare drafts now. Publishing starts once your shop is open.</Alert>}
      <CardSection title="New listing">
        <ActionForm action={createDraftAction} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="categoryId" className="block text-sm font-semibold">Category <span className="text-error">*</span></label>
            <select id="categoryId" name="categoryId" required defaultValue="" className="block w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2.5">
              <option value="" disabled>Choose a category</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {categories.filter((c) => c.parentName === g).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.restricted ? ' (restricted)' : ''}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <TextField label="Title" name="title" required maxLength={90} placeholder="e.g. Relaxed linen shirt, size M" hint="What it is, plus anything a buyer searches for: brand, colour, style." />
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">How do you want to sell it?</legend>
            {(['fixed', 'negotiable', 'auction'] as const).map((m) => (
              <label key={m} className="flex min-h-11 items-start gap-2 rounded-[var(--radius-control)] border border-line p-3">
                <input type="radio" name="saleMode" value={m} defaultChecked={m === 'fixed'} className="mt-1 size-4 accent-[var(--color-primary)]" />
                <span>
                  <span className="font-medium">{SALE_MODE_LABEL[m]}</span>
                  <span className="block text-sm text-muted">
                    {m === 'fixed' && 'Buyers check out at your price.'}
                    {m === 'negotiable' && 'Buyers can also send offers. You can set a private minimum.'}
                    {m === 'auction' && 'One identified piece sold by scheduled bidding. You set the start, end, opening price and increment.'}
                  </span>
                </span>
              </label>
            ))}
            <p className="text-xs text-muted">The sale mode is fixed once a piece is published — fixed-price pieces never turn into auctions.</p>
          </fieldset>
          <CheckboxField name="restrictedAcknowledged" label="I’ve read the extra rules for restricted categories (only needed for restricted categories)." />
          <SubmitButton pendingText="Creating draft…">Continue</SubmitButton>
        </ActionForm>
      </CardSection>
      {templates.length > 0 && (
        <CardSection title="Or start from a template">
          <ul className="divide-y divide-line">
            {templates.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-xs text-muted">{t.categoryName ?? 'Category unavailable'} · {SALE_MODE_LABEL[t.saleMode]}{t.priceMinor ? ` · ${formatNaira(t.priceMinor)}` : ''}</p>
                </div>
                <div className="flex gap-2">
                  <ActionForm action={createFromTemplateAction} showSuccess={false}>
                    <input type="hidden" name="templateId" value={t.id} />
                    <SubmitButton size="sm" pendingText="…">Use</SubmitButton>
                  </ActionForm>
                  <ActionForm action={deleteTemplateAction} showSuccess={false}>
                    <input type="hidden" name="templateId" value={t.id} />
                    <SubmitButton size="sm" variant="ghost" pendingText="…">Delete</SubmitButton>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Templates copy descriptions, size system and price. Photos, condition and flaws are always added per piece.</p>
        </CardSection>
      )}
    </div>
  );
}
