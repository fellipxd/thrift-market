'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui/Button';
import { deviceLocationAction } from '@/app/location-actions';

/** Optional device location. Permission denial falls back gracefully to typing a city. */
export function UseMyLocationButton({ label = 'Use my location' }: { label?: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={pending}
        className={buttonClass('ghost', 'sm')}
        onClick={() => {
          setMessage(null);
          if (!('geolocation' in navigator)) {
            setMessage('Location isn’t available on this device. Type your city instead.');
            return;
          }
          navigator.geolocation.getCurrentPosition(
            (pos) =>
              startTransition(async () => {
                const res = await deviceLocationAction({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                if (res.status === 'error') setMessage(res.message);
                else router.refresh();
              }),
            () => setMessage('Location permission was not given. Type your city or area instead.'),
            { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
          );
        }}
      >
        {pending ? 'Finding you…' : `◎ ${label}`}
      </button>
      {message && (
        <p className="text-sm text-muted" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
