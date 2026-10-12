import { NIGERIAN_STATES, stateLabel } from '@thrift/domain';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';

export interface ProfileDefaults {
  name?: string;
  bio?: string;
  state?: string;
  city?: string;
  area?: string | null;
  dispatchDays?: number;
  returnsPolicy?: string;
}

/** Shared shop profile fields (onboarding + settings). Location is city/area level only — never a home address. */
export function ShopProfileFields({ d = {} }: { d?: ProfileDefaults }) {
  return (
    <div className="space-y-4">
      <TextField label="Shop name" name="name" defaultValue={d.name} required maxLength={60} hint="Buyers see this on every listing. Your link stays the same if you rename later." />
      <TextAreaField label="Short bio" name="bio" defaultValue={d.bio} rows={3} maxLength={600} hint="What you sell, your style, how you source (at least a sentence)." />
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField label="State" name="state" defaultValue={d.state ?? ''} required placeholder="Choose a state" options={NIGERIAN_STATES.map((s) => ({ value: s, label: stateLabel(s) }))} />
        <TextField label="City or town" name="city" defaultValue={d.city} required maxLength={80} />
        <TextField label="Area (optional)" name="area" defaultValue={d.area ?? ''} maxLength={80} hint="Neighbourhood, e.g. Yaba or Wuse." />
      </div>
      <p className="text-sm text-muted">We show buyers an approximate area for “nearby shops”. Never enter your home address.</p>
      <SelectField
        label="Usual dispatch time"
        name="dispatchDays"
        defaultValue={String(d.dispatchDays ?? 2)}
        options={[0, 1, 2, 3, 4, 5, 7].map((n) => ({ value: String(n), label: n === 0 ? 'Same day' : `Within ${n} ${n === 1 ? 'day' : 'days'}` }))}
      />
      <TextAreaField
        label="Returns policy"
        name="returnsPolicy"
        defaultValue={d.returnsPolicy}
        rows={3}
        maxLength={1000}
        hint="E.g. “Returns accepted for undisclosed defects reported within 3 days of delivery.” Platform dispute rules always apply."
      />
    </div>
  );
}
