import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <EmptyState title="We couldn’t find that page" action={<ButtonLink href="/">Back to discover</ButtonLink>}>
        The item may have sold, or the link may be out of date.
      </EmptyState>
    </div>
  );
}
