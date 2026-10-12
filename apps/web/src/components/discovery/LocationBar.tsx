import { locationLabel, type LocationPreference } from '@thrift/application';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { chooseLocationAction, clearLocationAction } from '@/app/location-actions';
import { UseMyLocationButton } from './UseMyLocationButton';

/** "Delivery to: Abuja · Change" — the chosen place drives delivery estimates and "near me" sections. */
export function LocationBar({ location }: { location: LocationPreference | null }) {
  return (
    <details className="group">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-ink">
        <span className="font-semibold">Delivery to: {location ? locationLabel(location) : 'Choose your location'}</span>
        <span className="text-primary underline underline-offset-4">Change</span>
      </summary>
      <div className="mt-2 max-w-md space-y-3 border border-ink bg-surface p-4">
        <ActionForm action={chooseLocationAction} className="space-y-2">
          <label htmlFor="where" className="block text-sm font-semibold">City, area or state</label>
          <div className="flex gap-2">
            <input id="where" name="where" required placeholder="e.g. Yaba, Abuja or Kano" className="w-full rounded-[var(--radius-control)] border border-line-strong px-3 py-2" />
            <SubmitButton size="md" pendingText="…">Set</SubmitButton>
          </div>
        </ActionForm>
        <UseMyLocationButton />
        {location && (
          <ActionForm action={clearLocationAction} showSuccess={false}>
            <SubmitButton variant="ghost" size="sm" pendingText="…">Clear location</SubmitButton>
          </ActionForm>
        )}
        <p className="text-xs text-muted">We only keep the town or area you choose — never your exact position.</p>
      </div>
    </details>
  );
}
