import { many } from '@thrift/database';
import type { AppContext } from '../core/context';
import { memoPublic } from '../core/memo';

/**
 * "Did you mean": corrects misspelled search words against the words actually used in public listings (titles,
 * brands, colours, materials, descriptions). Trigram matching can't fix transposed letters ("shrit"), edit distance
 * can. The vocabulary is cached for 10 minutes.
 */
async function vocabulary(ctx: AppContext): Promise<{ words: Set<string>; byLength: Map<number, string[]> }> {
  return memoPublic(ctx, 'search-vocabulary', 10 * 60_000, async () => {
    const rows = await many<{ word: string }>(
      ctx.pool,
      `SELECT word FROM ts_stat($$SELECT search_vector FROM listings WHERE status IN ('active','reserved')$$)
        WHERE length(word) BETWEEN 3 AND 30 AND word ~ '^[a-z]+$' ORDER BY ndoc DESC LIMIT 20000`,
    );
    const words = new Set(rows.map((r) => r.word));
    const byLength = new Map<number, string[]>();
    for (const { word } of rows) {
      const bucket = byLength.get(word.length);
      if (bucket) bucket.push(word);
      else byLength.set(word.length, [word]);
    }
    return { words, byLength };
  });
}

/** Damerau–Levenshtein (optimal string alignment) distance, stopping early above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** The query with unknown words replaced by the closest catalogue word, or null when nothing changed. */
export async function correctQuery(ctx: AppContext, q: string): Promise<string | null> {
  const vocab = await vocabulary(ctx);
  let changed = false;
  const out = q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (word.length < 3 || !/^[a-z]+$/.test(word) || vocab.words.has(word)) return word;
      const max = word.length >= 6 ? 2 : 1;
      let best: { w: string; d: number } | null = null;
      for (let len = word.length - max; len <= word.length + max; len++) {
        for (const cand of vocab.byLength.get(len) ?? []) {
          const dist = editDistance(word, cand, max);
          if (dist <= max && (!best || dist < best.d)) best = { w: cand, d: dist };
          if (best?.d === 1) break;
        }
        if (best?.d === 1) break;
      }
      if (!best) return word;
      changed = true;
      return best.w;
    })
    .join(' ');
  return changed ? out : null;
}
