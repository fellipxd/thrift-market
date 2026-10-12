export function Stars({ value, label }: { value: number; label?: string }) {
  const full = Math.round(value);
  return (
    <span aria-label={`${label ? `${label}: ` : ''}${value} out of 5`} role="img" className="whitespace-nowrap text-accent">
      {'★'.repeat(full)}
      <span className="text-line-strong">{'★'.repeat(5 - full)}</span>
    </span>
  );
}

/** Accessible 1–5 rating input (radio group). */
export function RatingInput({ name, label }: { name: string; label: string }) {
  return (
    <fieldset className="text-sm">
      <legend className="mb-1 font-medium">{label}</legend>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer">
            <input type="radio" name={name} value={n} required className="peer sr-only" />
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-line-strong bg-surface font-semibold peer-checked:border-primary peer-checked:bg-primary peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40">
              {n}
            </span>
            <span className="sr-only">{n} out of 5</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
