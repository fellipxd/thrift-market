import { DomainError } from './errors';

export const CONDITION_GRADES = ['unworn', 'excellent', 'good', 'worn'] as const;
export type ConditionGrade = (typeof CONDITION_GRADES)[number];

/** Original condition grades with buyer-facing guidance. */
export const CONDITION_INFO: Record<ConditionGrade, { label: string; summary: string; examples: string }> = {
  unworn: {
    label: 'Unworn',
    summary: 'Never worn. May have original tags or packaging.',
    examples: 'Tags attached; shoes with clean soles; bag with protective film.',
  },
  excellent: {
    label: 'Excellent used',
    summary: 'Worn lightly with no visible wear on close inspection.',
    examples: 'No pilling, fading, marks or loose threads; soles barely worn.',
  },
  good: {
    label: 'Good used',
    summary: 'Normal signs of use that are disclosed and photographed.',
    examples: 'Light fading, a small mark, minor pilling or light sole wear.',
  },
  worn: {
    label: 'Visibly worn',
    summary: 'Clear wear that buyers should inspect in the photos.',
    examples: 'Noticeable fading, stains, scuffs, stretched fabric or repairs.',
  },
};

export const SALE_MODES = ['fixed', 'negotiable', 'auction'] as const;
export type SaleMode = (typeof SALE_MODES)[number];

export const SALE_MODE_LABEL: Record<SaleMode, string> = {
  fixed: 'Fixed price',
  negotiable: 'Negotiable',
  auction: 'Auction',
};

export const LISTING_STATUSES = ['draft', 'scheduled', 'active', 'reserved', 'sold', 'paused', 'ended', 'removed'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const SIZE_SYSTEMS = ['uk', 'us', 'eu', 'ng', 'intl_letter', 'waist_inches', 'one_size', 'other'] as const;
export type SizeSystem = (typeof SIZE_SYSTEMS)[number];

export const SIZE_SYSTEM_LABEL: Record<SizeSystem, string> = {
  uk: 'UK',
  us: 'US',
  eu: 'EU',
  ng: 'Local (NG)',
  intl_letter: 'XS–XXL',
  waist_inches: 'Waist (inches)',
  one_size: 'One size',
  other: 'Other',
};

export const MEDIA_ROLES = ['front', 'back', 'label', 'detail', 'sole', 'lining', 'closure', 'flaw', 'general'] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

export type CategoryKind = 'clothes' | 'shoes' | 'bags' | 'accessories';

/** Attribute schema stored per category version (attribute_schema_versions.schema). */
export interface AttributeSchema {
  sizeRequired: boolean;
  allowedSizeSystems: SizeSystem[];
  /** Measurement fields in centimetres, e.g. chest, length, waist, insole, width. */
  measurements: { key: string; label: string; required: boolean }[];
  /** Photo roles that should be captured for this category. */
  recommendedPhotoRoles: MediaRole[];
  attributes: { key: string; label: string; type: 'text' | 'select'; options?: string[]; required: boolean }[];
}

export interface PublishCandidate {
  title: string;
  description: string;
  saleMode: SaleMode;
  priceMinor: number | null;
  minOfferMinor: number | null;
  condition: ConditionGrade | null;
  flawsDeclaration: 'none_known' | 'described' | null;
  flaws: { description: string; mediaId: string | null }[];
  sizeSystem: SizeSystem | null;
  sizeLabel: string | null;
  measurements: Record<string, number>;
  attributes: Record<string, string>;
  photoCount: number;
  quantityMode: 'unique' | 'equivalent';
  quantity: number;
}

export interface PublishIssue {
  field: string;
  message: string;
}

/**
 * Pre-publication checklist. Returns issues; empty array means publishable.
 * Rules: real photos, condition grade, flaw affirmation (each described flaw needs photo evidence),
 * size/measurements per category schema, valid price per sale mode.
 */
export function validateForPublish(c: PublishCandidate, schema: AttributeSchema): PublishIssue[] {
  const issues: PublishIssue[] = [];
  if (c.title.trim().length < 3) issues.push({ field: 'title', message: 'Add a descriptive title.' });
  if (c.photoCount < 2) issues.push({ field: 'photos', message: 'Add at least two photos of the actual item.' });
  if (!c.condition) issues.push({ field: 'condition', message: 'Choose a condition grade.' });
  if (!c.flawsDeclaration) {
    issues.push({ field: 'flaws', message: 'Confirm there are no known flaws, or describe each flaw.' });
  } else if (c.flawsDeclaration === 'described') {
    if (c.flaws.length === 0) issues.push({ field: 'flaws', message: 'Describe at least one flaw, or confirm none are known.' });
    c.flaws.forEach((f, i) => {
      if (!f.mediaId) issues.push({ field: `flaws.${i}`, message: `Add a photo showing flaw “${f.description}”.` });
    });
  } else if (c.flaws.length > 0) {
    issues.push({ field: 'flaws', message: 'You listed flaws but declared none are known. Choose “described”.' });
  }
  if (c.condition === 'worn' && c.flawsDeclaration === 'none_known') {
    issues.push({ field: 'flaws', message: 'Visibly worn items need the wear described and photographed.' });
  }
  if (schema.sizeRequired) {
    if (!c.sizeSystem || !c.sizeLabel?.trim()) issues.push({ field: 'size', message: 'Add the size and size system.' });
    else if (!schema.allowedSizeSystems.includes(c.sizeSystem)) {
      issues.push({ field: 'size', message: 'Choose a size system that fits this category.' });
    }
  }
  for (const m of schema.measurements) {
    const v = c.measurements[m.key];
    if (m.required && (v === undefined || !(v > 0))) {
      issues.push({ field: `measurements.${m.key}`, message: `Add the ${m.label.toLowerCase()} measurement.` });
    }
  }
  for (const a of schema.attributes) {
    if (a.required && !c.attributes[a.key]?.trim()) issues.push({ field: `attributes.${a.key}`, message: `Add ${a.label.toLowerCase()}.` });
  }
  if (c.saleMode !== 'auction') {
    if (!c.priceMinor || c.priceMinor <= 0) issues.push({ field: 'price', message: 'Set a price.' });
    if (c.saleMode === 'negotiable' && c.minOfferMinor !== null && c.priceMinor && c.minOfferMinor > c.priceMinor) {
      issues.push({ field: 'minOffer', message: 'Your private minimum cannot be above the asking price.' });
    }
    if (c.saleMode === 'fixed' && c.minOfferMinor !== null) {
      issues.push({ field: 'minOffer', message: 'A private minimum only applies to negotiable listings.' });
    }
  }
  if (c.quantityMode === 'unique' && c.quantity !== 1) {
    issues.push({ field: 'quantity', message: 'A unique piece has a quantity of one.' });
  }
  if (c.quantityMode === 'equivalent' && (c.quantity < 1 || c.quantity > 500)) {
    issues.push({ field: 'quantity', message: 'Quantity must be between 1 and 500.' });
  }
  if (c.saleMode === 'auction' && c.quantityMode !== 'unique') {
    issues.push({ field: 'saleMode', message: 'Auctions cover one identified piece.' });
  }
  return issues;
}

export function assertPublishable(c: PublishCandidate, schema: AttributeSchema): void {
  const issues = validateForPublish(c, schema);
  if (issues.length > 0) {
    throw new DomainError('VALIDATION_FAILED', 'The listing is not ready to publish.', { issues });
  }
}

/**
 * Edits that change what a buyer is purchasing are restricted once the item is reserved, sold,
 * or an auction has bids. Returns null when allowed, else the reason.
 */
export function editRestriction(args: {
  status: ListingStatus;
  hasActiveReservation: boolean;
  auctionHasBids: boolean;
  field: 'price' | 'saleMode' | 'condition' | 'description' | 'photos' | 'quantity' | 'title';
}): string | null {
  if (args.status === 'sold' || args.status === 'removed') return 'This listing can no longer be edited.';
  if (args.auctionHasBids) return 'Auction terms and item details are locked after the first bid.';
  if (args.hasActiveReservation && ['price', 'saleMode', 'condition', 'photos', 'quantity'].includes(args.field)) {
    return 'This item is reserved for a buyer; wait for the reservation to finish.';
  }
  if (args.field === 'saleMode' && args.status === 'active') {
    return 'Pause the listing before changing its sale mode.';
  }
  return null;
}

export function slugify(input: string, maxLength = 40): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : `${base || 'shop'}-${Math.random().toString(36).slice(2, 6)}`;
}
