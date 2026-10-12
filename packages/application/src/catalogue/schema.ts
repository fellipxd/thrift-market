import { z } from 'zod';
import { MEDIA_ROLES, SIZE_SYSTEMS, type AttributeSchema, type CategoryKind } from '@thrift/domain';

/**
 * Category attribute schemas (attribute_schema_versions.schema). Every listing records the schema version
 * it was written against, and is always rendered and validated with that version — so publishing a new
 * version never makes old listings unreadable.
 */

const KEY = /^[a-z][a-z0-9_]{1,39}$/;

export const attributeSchemaShape = z
  .object({
    sizeRequired: z.boolean(),
    allowedSizeSystems: z.array(z.enum(SIZE_SYSTEMS)).max(SIZE_SYSTEMS.length),
    measurements: z
      .array(
        z.object({
          key: z.string().regex(KEY, 'Measurement keys use lowercase letters, numbers and underscores (e.g. chest_cm).'),
          label: z.string().trim().min(2, 'Give each measurement a label.').max(40),
          required: z.boolean(),
        }),
      )
      .max(12, 'Use at most 12 measurements.'),
    recommendedPhotoRoles: z.array(z.enum(MEDIA_ROLES)).max(MEDIA_ROLES.length),
    attributes: z
      .array(
        z.object({
          key: z.string().regex(KEY, 'Attribute keys use lowercase letters, numbers and underscores (e.g. fit).'),
          label: z.string().trim().min(2, 'Give each attribute a label.').max(40),
          type: z.enum(['text', 'select']),
          options: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
          required: z.boolean(),
        }),
      )
      .max(12, 'Use at most 12 attributes.'),
  })
  .superRefine((s, ctx) => {
    if (s.sizeRequired && s.allowedSizeSystems.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['allowedSizeSystems'], message: 'Choose at least one size system when size is required.' });
    }
    const mKeys = new Set<string>();
    s.measurements.forEach((m, i) => {
      if (mKeys.has(m.key)) ctx.addIssue({ code: 'custom', path: ['measurements', i, 'key'], message: `Measurement “${m.key}” is listed twice.` });
      mKeys.add(m.key);
    });
    const aKeys = new Set<string>();
    s.attributes.forEach((a, i) => {
      if (aKeys.has(a.key)) ctx.addIssue({ code: 'custom', path: ['attributes', i, 'key'], message: `Attribute “${a.key}” is listed twice.` });
      aKeys.add(a.key);
      if (a.type === 'select' && (!a.options || a.options.length < 2)) {
        ctx.addIssue({ code: 'custom', path: ['attributes', i, 'options'], message: `Give “${a.label}” at least two options.` });
      }
    });
  });

/** Reads a stored schema defensively (older rows may miss newer optional keys). */
export function readAttributeSchema(raw: unknown): AttributeSchema {
  const r = (raw ?? {}) as Partial<AttributeSchema>;
  return {
    sizeRequired: Boolean(r.sizeRequired),
    allowedSizeSystems: Array.isArray(r.allowedSizeSystems) ? r.allowedSizeSystems : [],
    measurements: Array.isArray(r.measurements) ? r.measurements : [],
    recommendedPhotoRoles: Array.isArray(r.recommendedPhotoRoles) ? r.recommendedPhotoRoles : [],
    attributes: Array.isArray(r.attributes) ? r.attributes : [],
  };
}

/** Starting schema for a new top-level category of each kind (admins publish new versions from here). */
export const DEFAULT_SCHEMAS: Record<CategoryKind, AttributeSchema> = {
  clothes: {
    sizeRequired: true,
    allowedSizeSystems: ['uk', 'us', 'eu', 'intl_letter', 'waist_inches', 'ng', 'one_size'],
    measurements: [
      { key: 'pit_to_pit_cm', label: 'Pit to pit (cm)', required: false },
      { key: 'length_cm', label: 'Length (cm)', required: false },
      { key: 'waist_cm', label: 'Waist (cm)', required: false },
    ],
    recommendedPhotoRoles: ['front', 'back', 'label', 'detail'],
    attributes: [],
  },
  shoes: {
    sizeRequired: true,
    allowedSizeSystems: ['eu', 'uk', 'us'],
    measurements: [{ key: 'insole_cm', label: 'Insole length (cm)', required: false }],
    recommendedPhotoRoles: ['front', 'sole', 'detail', 'label'],
    attributes: [],
  },
  bags: {
    sizeRequired: false,
    allowedSizeSystems: ['one_size', 'other'],
    measurements: [
      { key: 'width_cm', label: 'Width (cm)', required: false },
      { key: 'height_cm', label: 'Height (cm)', required: false },
      { key: 'depth_cm', label: 'Depth (cm)', required: false },
    ],
    recommendedPhotoRoles: ['front', 'back', 'lining', 'closure'],
    attributes: [],
  },
  accessories: {
    sizeRequired: false,
    allowedSizeSystems: ['one_size', 'intl_letter', 'other'],
    measurements: [],
    recommendedPhotoRoles: ['front', 'detail'],
    attributes: [],
  },
};

export function humaniseKey(key: string): string {
  const s = key.replace(/_cm$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Measurement label from the listing's own schema version (falls back to a readable key). */
export function measurementLabel(schema: AttributeSchema, key: string): string {
  return schema.measurements.find((m) => m.key === key)?.label ?? `${humaniseKey(key)}${key.endsWith('_cm') ? ' (cm)' : ''}`;
}

export function attributeLabel(schema: AttributeSchema, key: string): string {
  return schema.attributes.find((a) => a.key === key)?.label ?? humaniseKey(key);
}
