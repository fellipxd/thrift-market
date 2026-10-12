import { DEFAULT_SETTINGS, type Settings, type SettingKey } from '@thrift/domain';
import { many, type Queryable } from '@thrift/database';

let cache: { at: number; value: Settings } | null = null;
const TTL_MS = 15_000;

/** Platform settings = draft defaults overridden by admin-edited platform_settings rows. */
export async function getSettings(db: Queryable, opts: { fresh?: boolean } = {}): Promise<Settings> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await many<{ key: string; value: unknown }>(db, 'SELECT key, value FROM platform_settings');
  const value: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in value && typeof r.value === 'number') value[r.key as SettingKey] = r.value;
  }
  cache = { at: Date.now(), value };
  return value;
}

export function clearSettingsCache(): void {
  cache = null;
}
