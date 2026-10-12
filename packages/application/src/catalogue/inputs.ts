import { z } from 'zod';
import { CONDITION_GRADES, MEDIA_ROLES, SALE_MODES, SIZE_SYSTEMS } from '@thrift/domain';
import { boolish, intField, optionalNairaField, optionalText, optionalUuid, requiredText, stateList, uuidField } from './form-fields';

const emptyToNull = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.union([z.enum(values, { message }), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v));

/** Measurements in centimetres: blank values are dropped; values must be positive with at most one decimal. */
const measurementsField = z
  .record(z.string(), z.union([z.string(), z.number(), z.null()]))
  .transform((rec, ctx) => {
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(rec)) {
      if (raw === null || String(raw).trim() === '') continue;
      const s = String(raw).replace(',', '.').trim();
      if (!/^\d{1,3}(\.\d)?$/.test(s) || Number(s) <= 0 || Number(s) > 500) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Enter centimetres, e.g. 56 or 56.5.' });
        continue;
      }
      out[key] = Number(s);
    }
    return out;
  });

const attributesField = z.record(z.string(), z.union([z.string(), z.null()])).transform((rec, ctx) => {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(rec)) {
    const v = (raw ?? '').trim();
    if (!v) continue;
    if (v.length > 60) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Keep this under 60 characters.' });
      continue;
    }
    out[key] = v;
  }
  return out;
});

export const createDraftInput = z.object({
  categoryId: uuidField('a category'),
  saleMode: z.enum(SALE_MODES, { message: 'Choose how you want to sell this piece.' }).default('fixed'),
  title: requiredText('Title', 3, 90),
  restrictedAcknowledged: boolish.optional(),
});

/** Partial listing edit. Absent fields are left unchanged; blank optional fields are cleared. */
export const listingFieldsInput = z.object({
  listingId: uuidField('listing'),
  title: requiredText('Title', 3, 90).optional(),
  description: optionalText('Description', 4000).optional(),
  brand: optionalText('Brand', 60).optional(),
  colour: optionalText('Colour', 40).optional(),
  material: optionalText('Material', 60).optional(),
  categoryId: uuidField('a category').optional(),
  restrictedAcknowledged: boolish.optional(),
  sizeSystem: emptyToNull(SIZE_SYSTEMS, 'Choose a size system.').optional(),
  sizeLabel: optionalText('Size', 20).optional(),
  measurements: measurementsField.optional(),
  attributes: attributesField.optional(),
  condition: emptyToNull(CONDITION_GRADES, 'Choose a condition grade.').optional(),
  flawsDeclaration: emptyToNull(['none_known', 'described'] as const, 'Choose whether the piece has known flaws.').optional(),
  saleMode: z.enum(SALE_MODES, { message: 'Choose a sale mode.' }).optional(),
  price: optionalNairaField('Price').optional(),
  minOffer: optionalNairaField('Private minimum').optional(),
  quantityMode: z.enum(['unique', 'equivalent'], { message: 'Choose unique piece or identical units.' }).optional(),
  quantity: intField('Quantity', 1, 500).optional(),
  deliveryStates: stateList.optional(),
  weightGrams: z
    .union([intField('Weight', 1, 50_000), z.literal(''), z.null()])
    .transform((v) => (v === '' ? null : v))
    .optional(),
  batchId: optionalUuid.optional(),
});
export type ListingFieldsInput = z.output<typeof listingFieldsInput>;

export const photosInput = z.object({
  listingId: uuidField('listing'),
  photos: z
    .union([
      z.string().transform((s, ctx) => {
        try {
          return JSON.parse(s || '[]') as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Photo order could not be read. Reload and try again.' });
          return z.NEVER;
        }
      }),
      z.array(z.unknown()),
    ])
    .pipe(
      z
        .array(
          z.object({
            mediaId: z.string().uuid('A photo is missing. Upload it again.'),
            role: z.enum(MEDIA_ROLES).default('general'),
            caption: z
              .string()
              .nullish()
              .transform((v) => (v ?? '').trim() || null)
              .refine((v) => v === null || v.length <= 140, 'Keep captions under 140 characters.'),
          }),
        )
        .max(50),
    ),
});

export const flawInput = z.object({
  listingId: uuidField('listing'),
  description: requiredText('Flaw description', 3, 300),
  location: optionalText('Where on the item', 80),
  severity: z.enum(['minor', 'moderate', 'major'], { message: 'Choose how noticeable the flaw is.' }).default('minor'),
  mediaId: optionalUuid,
});

export const updateFlawInput = flawInput.extend({ flawId: uuidField('flaw') });
export const removeFlawInput = z.object({ listingId: uuidField('listing'), flawId: uuidField('flaw') });
export const flawsDeclarationInput = z.object({
  listingId: uuidField('listing'),
  declaration: z.enum(['none_known', 'described'], { message: 'Choose whether the piece has known flaws.' }),
});

export const listingIdInput = z.object({ listingId: uuidField('listing') });
export const quantityActionInput = z.object({
  listingId: uuidField('listing'),
  quantity: z.union([intField('Quantity', 1, 500), z.literal('')]).optional().transform((v) => (typeof v === 'number' ? v : 1)),
});

export const bulkActionInput = z.object({
  action: z.enum(['pause', 'resume', 'mark_sold_elsewhere'], { message: 'Choose an action.' }),
  listingIds: z
    .union([z.array(z.string()), z.string()])
    .transform((v) => [...new Set((Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))])
    .refine((a) => a.length > 0, 'Select at least one listing.')
    .refine((a) => a.length <= 100, 'Select at most 100 listings at a time.'),
});

/** "2026-10-15T18:00" from a datetime-local field is WAT (UTC+1, no DST); ISO strings with an offset are kept. */
export const watDateTime = z
  .union([z.string(), z.null()]).optional()
  .transform((v, ctx) => {
    const s = (v ?? '').trim();
    if (!s) return null;
    const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s);
    const d = new Date(local ? `${s}${s.length === 16 ? ':00' : ''}+01:00` : s);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid date and time.' });
      return z.NEVER;
    }
    return d;
  });

export const batchInput = z.object({
  name: requiredText('Batch name', 2, 80),
  note: optionalText('Note', 500).transform((v) => v ?? ''),
  dropAt: watDateTime,
});
export const updateBatchInput = batchInput.extend({ batchId: uuidField('batch') });
export const batchIdInput = z.object({ batchId: uuidField('batch') });

export const templateInput = z.object({ listingId: uuidField('listing'), name: requiredText('Template name', 2, 80) });
export const templateIdInput = z.object({ templateId: uuidField('template') });
