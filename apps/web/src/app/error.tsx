'use client';

import { Button } from '@/components/ui/Button';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <h1 className="display text-4xl">Something went wrong</h1>
      <p className="mt-2 text-muted">Your data is safe. Please try again{error.digest ? ` (ref ${error.digest})` : ''}.</p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
