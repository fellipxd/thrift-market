import { createHmac, timingSafeEqual } from 'node:crypto';
import { headerValue } from '../payments/types';
import type { CourierBooking, CourierBookingInput, CourierProvider, CourierQuote, CourierQuoteInput, CourierTrackingEvent } from './types';

/** Geopolitical zones used by the sandbox courier to produce deterministic quotes. */
const ZONES: Record<string, string> = {
  Lagos: 'SW', Ogun: 'SW', Oyo: 'SW', Osun: 'SW', Ondo: 'SW', Ekiti: 'SW',
  Edo: 'SS', Delta: 'SS', Rivers: 'SS', Bayelsa: 'SS', 'Akwa Ibom': 'SS', 'Cross River': 'SS',
  Abia: 'SE', Anambra: 'SE', Ebonyi: 'SE', Enugu: 'SE', Imo: 'SE',
  FCT: 'NC', Kogi: 'NC', Kwara: 'NC', Nasarawa: 'NC', Niger: 'NC', Plateau: 'NC', Benue: 'NC',
  Kaduna: 'NW', Kano: 'NW', Katsina: 'NW', Kebbi: 'NW', Sokoto: 'NW', Zamfara: 'NW', Jigawa: 'NW',
  Adamawa: 'NE', Bauchi: 'NE', Borno: 'NE', Gombe: 'NE', Taraba: 'NE', Yobe: 'NE',
};

/** Sandbox route exclusions to exercise "not deliverable" paths deterministically. */
export const SANDBOX_UNSUPPORTED_DESTINATIONS = new Set(['Borno', 'Yobe']);

export const COURIER_SIGNATURE_HEADER = 'x-sandbox-courier-signature';

export function sandboxCourierQuote(originState: string, destinationState: string, weightGrams: number): CourierQuote {
  if (SANDBOX_UNSUPPORTED_DESTINATIONS.has(destinationState) || !ZONES[originState] || !ZONES[destinationState]) {
    return { available: false, feeMinor: 0, transitDaysMin: 0, transitDaysMax: 0, serviceName: 'Sandbox Courier' };
  }
  const weightKg = Math.max(1, Math.ceil(weightGrams / 1000));
  let base: number;
  let tmin: number;
  let tmax: number;
  if (originState === destinationState) {
    base = 180_000; tmin = 1; tmax = 2;
  } else if (ZONES[originState] === ZONES[destinationState]) {
    base = 280_000; tmin = 2; tmax = 3;
  } else {
    base = 420_000; tmin = 3; tmax = 6;
  }
  return { available: true, feeMinor: base + (weightKg - 1) * 50_000, transitDaysMin: tmin, transitDaysMax: tmax, serviceName: 'Sandbox Courier' };
}

export function signCourierPayload(secret: string, rawBody: string): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

/**
 * Deterministic sandbox courier. Bookings return a reference whose milestones are advanced from the
 * sandbox courier console (/sandbox/courier/[reference]), which posts signed webhooks to the app.
 */
export class SandboxCourierProvider implements CourierProvider {
  readonly name = 'sandbox_courier';
  readonly isSandbox = true;

  constructor(private readonly opts: { baseUrl: string; webhookSecret: string }) {}

  async quote(input: CourierQuoteInput): Promise<CourierQuote> {
    return sandboxCourierQuote(input.originState, input.destinationState, input.weightGrams);
  }

  async book(input: CourierBookingInput): Promise<CourierBooking> {
    const ref = `SBX-${input.orderNumber}`;
    return {
      trackingReference: ref,
      trackingUrl: new URL(`/sandbox/courier/${encodeURIComponent(ref)}`, this.opts.baseUrl).toString(),
      carrierName: 'Sandbox Courier',
    };
  }

  async track(): Promise<CourierTrackingEvent[]> {
    return [];
  }

  verifyWebhookSignature(rawBody: string, headers: Headers | Record<string, string | undefined>): boolean {
    const given = headerValue(headers, COURIER_SIGNATURE_HEADER);
    if (!given) return false;
    const expected = signCourierPayload(this.opts.webhookSecret, rawBody);
    const a = Buffer.from(given, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): CourierTrackingEvent[] {
    const body = JSON.parse(rawBody) as {
      events: { id: string; reference: string; status: CourierTrackingEvent['status']; description?: string; occurred_at: string }[];
    };
    return (body.events ?? []).map((e) => ({
      externalId: e.id,
      trackingReference: e.reference,
      status: e.status,
      description: e.description ?? '',
      occurredAt: new Date(e.occurred_at),
    }));
  }
}
