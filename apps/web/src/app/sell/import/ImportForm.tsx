'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { ImportResult } from '@thrift/application';
import { Alert } from '@/components/ui/Alert';
import { buttonClass } from '@/components/ui/Button';
import { routes } from '@/lib/routes';
import { importListingsAction } from './actions';

export function ImportForm() {
  const [state, action, pending] = useActionState(importListingsAction, { status: 'idle' });
  const result = state.status === 'success' ? (state.data as ImportResult) : null;
  return (
    <div className="space-y-5">
      <form action={action} className="space-y-4">
        <div>
          <label htmlFor="import-file" className="block font-medium">CSV file</label>
          <input id="import-file" name="file" type="file" accept=".csv,text/csv" className="mt-1 block w-full text-sm" />
          <p className="mt-1 text-sm text-muted">Up to 200 listings and 1 MB per file.</p>
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-primary">Or paste the CSV text</summary>
          <label htmlFor="import-csv" className="sr-only">CSV text</label>
          <textarea id="import-csv" name="csv" rows={8} className="mt-2 w-full border border-line-strong bg-surface p-2 font-mono text-sm" />
        </details>
        <button type="submit" className={buttonClass('primary', 'md')} disabled={pending} aria-busy={pending}>
          {pending ? 'Importing…' : 'Import as drafts'}
        </button>
      </form>
      <div aria-live="polite">
        {state.status === 'error' && <Alert tone="error">{state.message}</Alert>}
        {result && (
          <div className="space-y-4">
            <Alert tone={result.errors.length ? 'warning' : 'success'}>{state.status === 'success' ? state.message : null}</Alert>
            {result.created.length > 0 && (
              <section aria-labelledby="import-created">
                <h2 id="import-created" className="font-serif text-xl">Drafts created</h2>
                <p className="text-sm text-muted">Add real photos and confirm flaws on each draft, then publish.</p>
                <ul className="mt-2 divide-y divide-line border-y border-line text-sm">
                  {result.created.map((c) => (
                    <li key={c.listingId} className="flex justify-between gap-3 py-2">
                      <span>Row {c.row}: {c.title}</span>
                      <Link href={routes.sell.listing(c.listingId)} className="font-semibold text-primary underline">Finish draft</Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {result.errors.length > 0 && (
              <section aria-labelledby="import-errors">
                <h2 id="import-errors" className="font-serif text-xl">Rows to fix</h2>
                <ul className="mt-2 divide-y divide-line border-y border-line text-sm">
                  {result.errors.map((e) => (
                    <li key={e.row} className="py-2">
                      <span className="font-semibold">Row {e.row}{e.title ? ` · ${e.title}` : ''}:</span> {e.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
