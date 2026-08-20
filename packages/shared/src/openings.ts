/**
 * Opening-book identification helpers shared by client and server.
 *
 * The opening book is a flat map from normalized `fenKey` → `{ eco, name,
 * variation }`. Both `identifyOpening` (single-position match) and
 * `identifyDeepestOpening` (walk path, keep last hit) consult that same map.
 *
 * The map is provided by the caller — the API loads it from Postgres, the
 * client receives lookups from the API. Tests can inject a small literal map.
 */
import type { FenKey } from './fen.js';

export interface OpeningId {
  eco: string;
  name: string;
  variation: string | null;
}

export type OpeningBookLookup = (fenKey: FenKey) => OpeningId | null;

export function identifyOpening(
  fenKey: FenKey,
  lookup: OpeningBookLookup,
): OpeningId | null {
  return lookup(fenKey);
}

/**
 * Walks the path of FEN keys from root → current position and returns the
 * deepest (last) entry that the book knows. Used so that "Caro-Kann Defense"
 * refines to "Caro-Kann Defense, Advance Variation" as the user steps deeper,
 * and so transpositions whose immediate FEN isn't in the book still inherit
 * the name from an ancestor that is.
 */
export function identifyDeepestOpening(
  fenKeysAlongLine: readonly FenKey[],
  lookup: OpeningBookLookup,
): OpeningId | null {
  let last: OpeningId | null = null;
  for (const k of fenKeysAlongLine) {
    const hit = lookup(k);
    if (hit) last = hit;
  }
  return last;
}

/**
 * Split a lichess-style opening name ("Caro-Kann Defense: Advance Variation,
 * Short Variation") into base + variation. The base is everything before the
 * first colon; the variation is everything after (kept verbatim, including
 * any comma-joined sub-variations).
 */
export function splitOpeningName(full: string): { name: string; variation: string | null } {
  const idx = full.indexOf(':');
  if (idx < 0) return { name: full.trim(), variation: null };
  const name = full.slice(0, idx).trim();
  const variation = full.slice(idx + 1).trim();
  return { name, variation: variation.length > 0 ? variation : null };
}
