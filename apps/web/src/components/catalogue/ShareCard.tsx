import QRCode from 'qrcode';
import { CopyLinkButton } from './CopyLinkButton';

/**
 * Share block for items and shops: a link to paste into WhatsApp/Instagram/Telegram and a QR code for
 * posters or market stalls. Generated server-side; no third-party services.
 */
export async function ShareCard({ url, title, hint }: { url: string; title: string; hint?: string }) {
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 160, color: { dark: '#174A3C', light: '#FFFFFF' } });
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return (
    <details className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <summary className="cursor-pointer font-semibold text-ink">Share {title}</summary>
      <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- inline QR code */}
        <img src={dataUrl} alt={`QR code linking to ${title}`} width={128} height={128} className="rounded-lg border border-line" />
        <div className="min-w-0 space-y-2">
          <p className="break-all text-sm text-muted">{url}</p>
          <CopyLinkButton url={url} />
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      </div>
    </details>
  );
}
