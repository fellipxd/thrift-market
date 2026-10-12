'use client';

import { useState } from 'react';
import { buttonClass } from '@/components/ui/Button';

export function CopyLinkButton({ url, label = 'Copy link' }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass('secondary', 'sm')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        } catch {
          window.prompt('Copy this link', url);
        }
      }}
    >
      <span aria-live="polite">{copied ? 'Link copied' : label}</span>
    </button>
  );
}
