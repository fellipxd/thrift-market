import Link from 'next/link';
import type { OnboardingChecklist } from '@thrift/application';
import { Badge } from '@/components/ui/Badge';
import { routes } from '@/lib/routes';

const LINKS: Record<string, string> = {
  profile: `${routes.sell.settings}#profile`,
  coverage: `${routes.sell.settings}#coverage`,
  payout: `${routes.sell.settings}#payout`,
  verification: routes.sell.verification,
  first_listing: routes.sell.newListing,
};

export function ChecklistCard({ checklist }: { checklist: OnboardingChecklist }) {
  const done = checklist.items.filter((i) => i.done).length;
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4 sm:p-5" aria-labelledby="checklist-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="checklist-title" className="font-serif text-2xl">
          Set up your shop
        </h2>
        <span className="text-sm text-muted">
          {done} of {checklist.items.length} done
        </span>
      </div>
      <ol className="mt-3 divide-y divide-line">
        {checklist.items.map((item) => (
          <li key={item.key} className="flex items-start justify-between gap-3 py-3">
            <div>
              <p className="font-medium text-ink">
                <span aria-hidden="true">{item.done ? '✓ ' : '○ '}</span>
                {item.label}
                {!item.required && <span className="ml-2 text-xs font-normal text-muted">recommended</span>}
              </p>
              <p className="text-sm text-muted">{item.done ? item.status : item.hint}</p>
            </div>
            {item.done ? (
              <Badge tone="success">{item.status}</Badge>
            ) : (
              <Link href={LINKS[item.key] ?? routes.sell.settings} className="whitespace-nowrap text-sm font-semibold text-primary underline">
                {item.required ? 'Do this' : 'Start'}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
