'use client';

import { useEffect, useState } from 'react';
import { formatCountdown } from '@thrift/domain';

/**
 * Countdown to a server-authoritative deadline. `serverNow` corrects for client clock skew;
 * the client display is informational only — the server decides validity.
 */
export function Countdown({ target, serverNow, expiredText = 'Ended', className }: { target: string; serverNow: string; expiredText?: string; className?: string }) {
  const [offset] = useState(() => new Date(serverNow).getTime() - Date.now());
  const [remaining, setRemaining] = useState(() => new Date(target).getTime() - new Date(serverNow).getTime());
  useEffect(() => {
    const tick = () => setRemaining(new Date(target).getTime() - (Date.now() + offset));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [target, offset]);
  return (
    <span className={className} aria-live="off" suppressHydrationWarning>
      {remaining > 0 ? formatCountdown(remaining) : expiredText}
    </span>
  );
}
