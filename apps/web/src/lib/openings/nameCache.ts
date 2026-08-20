/**
 * Phase 9a: a local `fenKey → OpeningId` cache covering the positions of the
 * user's own repertoires.
 *
 * Why a cache rather than the existing `useOpeningId` hooks: opening-name line
 * scopes are evaluated *inside* the queue builders, which are synchronous and
 * must produce the same queue offline as online. A per-card HTTP lookup would
 * break both. The book is still server-owned — this only mirrors the handful of
 * positions that appear in the user's trees (see
 * [lib/openings/useOpeningId.ts](./useOpeningId.ts) for the online, position-at-
 * a-time path used by the header).
 *
 * Cold-cache behavior is deliberate: an opening-name scope with no cached names
 * matches nothing, so the setup screen shows "0 cards" instead of silently
 * drilling the whole tree. A scoped session that quietly includes everything
 * looks finished when it isn't.
 */
import type { OpeningId } from '@chess-prep/shared';
import { api } from '../../api/client';
import { getAllOpeningNamesLocal, putOpeningNamesLocal } from '../idb/schema.ts';
import type { RepertoireFull } from '../../api/client';

/** In-memory mirror so repeated queue builds in one session are free. */
let memo: Map<string, OpeningId> | null = null;

/** Keys we've already asked the server about, including the misses. */
const requested = new Set<string>();

export function openingNameLookup(map: Map<string, OpeningId>) {
  return (fenKey: string): OpeningId | null => map.get(fenKey) ?? null;
}

/** Whatever is cached right now — never hits the network. */
export async function loadCachedOpeningNames(): Promise<Map<string, OpeningId>> {
  if (!memo) memo = await getAllOpeningNamesLocal();
  return memo;
}

/**
 * Ensure every position in `reps` has been looked up, then return the cache.
 * Network failures are swallowed: the caller gets whatever is cached, which is
 * the offline path.
 */
export async function ensureOpeningNames(
  reps: readonly RepertoireFull[],
): Promise<Map<string, OpeningId>> {
  const cache = await loadCachedOpeningNames();

  const missing: string[] = [];
  for (const rep of reps) {
    for (const p of rep.positions) {
      if (cache.has(p.fenKey) || requested.has(p.fenKey)) continue;
      requested.add(p.fenKey);
      missing.push(p.fenKey);
    }
  }
  if (missing.length === 0) return cache;

  try {
    const { openings } = await api.lookupOpeningsByFenKeys(missing);
    const entries = Object.entries(openings).map(([fenKey, opening]) => ({ fenKey, opening }));
    for (const e of entries) cache.set(e.fenKey, e.opening);
    await putOpeningNamesLocal(entries);
  } catch {
    // Offline (or the API is down): fall back to the cache as-is, and allow a
    // retry later — otherwise the first offline session would poison the
    // "already requested" set for the rest of the app's lifetime.
    for (const k of missing) requested.delete(k);
  }
  return cache;
}

/** Test/debug seam: drop the in-memory mirror so the next read re-reads IDB. */
export function resetOpeningNameMemo(): void {
  memo = null;
  requested.clear();
}
