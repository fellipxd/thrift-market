import { z } from 'zod';
import {
  boolish,
  intField,
  nairaField,
  optionalText,
  requiredText,
  stateField,
  stateList,
  uuidField,
} from '../catalogue/form-fields';

const placeName = (label: string) =>
  requiredText(label, 2, 80).regex(/^[\p{L}][\p{L}\s.'’-]*$/u, `${label} can only use letters, spaces, hyphens and apostrophes.`);

export const shopProfileInput = z.object({
  name: requiredText('Shop name', 2, 60),
  bio: optionalText('Bio', 600).transform((v) => v ?? ''),
  state: stateField,
  city: placeName('City or town'),
  area: optionalText('Area', 80).refine((v) => v === null || /^[\p{L}\d][\p{L}\d\s.'’-]*$/u.test(v), 'Area can only use letters, numbers, spaces and hyphens.'),
  dispatchDays: intField('Dispatch time', 0, 14).default(2),
  returnsPolicy: optionalText('Returns policy', 1000).transform((v) => v ?? ''),
});
export type ShopProfileInput = z.output<typeof shopProfileInput>;

export const coverageInput = z
  .object({
    scope: z.enum(['local', 'states', 'national'], { message: 'Choose where you deliver.' }),
    states: stateList,
    excludedStates: stateList,
    offersPickup: boolish,
    offersSellerArranged: boolish,
    offersIntegrated: boolish,
    sameCityFee: nairaField('Same-city fee', { allowZero: true, max: 10_000_000 }),
    sameStateFee: nairaField('Same-state fee', { allowZero: true, max: 10_000_000 }),
    interstateFee: nairaField('Interstate fee', { allowZero: true, max: 10_000_000 }),
    transitDaysMin: intField('Fastest delivery time', 0, 30),
    transitDaysMax: intField('Slowest delivery time', 0, 30),
    pickupNote: optionalText('Pickup note', 200),
  })
  .superRefine((v, ctx) => {
    if (!v.offersPickup && !v.offersSellerArranged && !v.offersIntegrated) {
      ctx.addIssue({ code: 'custom', path: ['offersSellerArranged'], message: 'Turn on at least one way to get orders to buyers.' });
    }
    if (v.scope === 'states' && v.states.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['states'], message: 'Choose the states you deliver to, or pick another option.' });
    }
    if (v.transitDaysMax < v.transitDaysMin) {
      ctx.addIssue({ code: 'custom', path: ['transitDaysMax'], message: 'The slowest delivery time cannot be shorter than the fastest.' });
    }
    if (v.offersPickup && !v.pickupNote) {
      ctx.addIssue({ code: 'custom', path: ['pickupNote'], message: 'Describe a public pickup point (e.g. a landmark). Never give your home address.' });
    }
  });
export type CoverageInput = z.output<typeof coverageInput>;

export const payoutAccountInput = z.object({
  bankCode: requiredText('Bank', 1, 10),
  accountNumber: z
    .string({ message: 'Enter your 10-digit account number.' })
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => /^\d{10}$/.test(v), 'Enter your 10-digit account number (NUBAN).'),
  accountName: requiredText('Account name', 2, 100),
});

export const ID_TYPES = ['nin', 'drivers_licence', 'passport', 'voters_card', 'cac_registration'] as const;
export const ID_TYPE_LABEL: Record<(typeof ID_TYPES)[number], string> = {
  nin: 'National Identification Number (NIN) slip or card',
  drivers_licence: 'Driver’s licence',
  passport: 'International passport',
  voters_card: 'Permanent voter’s card',
  cac_registration: 'CAC business registration',
};

export const submitVerificationInput = z.object({
  legalName: requiredText('Legal name', 2, 120),
  idType: z.enum(ID_TYPES, { message: 'Choose the document type.' }),
  idNumberLast4: z
    .string({ message: 'Enter the last 4 characters of the document number.' })
    .trim()
    .regex(/^[A-Za-z0-9]{4}$/, 'Enter only the last 4 letters or digits of the document number.'),
  evidenceMediaIds: z
    .union([z.array(z.string()), z.string()])
    .transform((v) => [...new Set((Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))])
    .refine((arr) => arr.length >= 1, 'Upload at least one photo of your document.')
    .refine((arr) => arr.length <= 4, 'Upload at most 4 photos.')
    .refine((arr) => arr.every((s) => /^[0-9a-f-]{36}$/i.test(s)), 'Upload the document photos again.'),
});

export const decideVerificationInput = z.object({
  caseId: uuidField('case'),
  decision: z.enum(['approve', 'reject'], { message: 'Choose approve or reject.' }),
  reason: requiredText('Reason', 10, 1000),
});

export const pauseShopInput = z.object({ note: optionalText('Note', 200) });
