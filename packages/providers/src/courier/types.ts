export interface CourierQuoteInput {
  originState: string;
  originCity: string;
  destinationState: string;
  destinationCity: string;
  weightGrams: number;
}

export interface CourierQuote {
  available: boolean;
  feeMinor: number;
  transitDaysMin: number;
  transitDaysMax: number;
  serviceName: string;
}

export interface CourierBookingInput {
  orderNumber: string;
  quote: CourierQuote;
  origin: { name: string; phone: string; city: string; state: string; addressLine: string };
  destination: { name: string; phone: string; city: string; state: string; addressLine: string };
  weightGrams: number;
}

export interface CourierBooking {
  trackingReference: string;
  trackingUrl: string | null;
  carrierName: string;
}

export type CourierStatus = 'booked' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception' | 'returned' | 'cancelled';

export interface CourierTrackingEvent {
  externalId: string;
  trackingReference: string;
  status: CourierStatus;
  description: string;
  occurredAt: Date;
}

/** Normalised courier adapter (quotes, booking, milestone events). Milestones are not live GPS. */
export interface CourierProvider {
  readonly name: string;
  readonly isSandbox: boolean;
  quote(input: CourierQuoteInput): Promise<CourierQuote>;
  book(input: CourierBookingInput): Promise<CourierBooking>;
  track(trackingReference: string): Promise<CourierTrackingEvent[]>;
  verifyWebhookSignature(rawBody: string, headers: Headers | Record<string, string | undefined>): boolean;
  parseWebhook(rawBody: string): CourierTrackingEvent[];
}
