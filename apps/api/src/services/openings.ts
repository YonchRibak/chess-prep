/**
 * Read-only opening book queries.
 *
 * The `OpeningBookEntry` table is reloaded by the importer (see
 * scripts/import-openings.ts) — service-layer code never mutates it.
 */
import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm';
import { Chess } from 'chess.js';
import {
  fenKey as makeFenKey,
  identifyDeepestOpening as deepestFromLookup,
  type FenKey,
  type OpeningId,
} from '@chess-prep/shared';
import { db } from '../db/client.js';
import { openingBookEntries } from '../db/schema.js';
import { HttpError } from './repertoires.js';

export interface OpeningListItem {
  id: string;
  eco: string;
  name: string;
  variation: string | null;
  fenKey: string;
  fullFen: string;
  pgnMoves: string;
}

export interface OpeningDetail extends OpeningListItem {}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

export async function listOpenings(input: {
  q?: string;
  eco?: string;
  limit?: string;
}): Promise<OpeningListItem[]> {
  const limit = clampLimit(input.limit);
  const filters = [];
  if (input.eco) {
    filters.push(eq(openingBookEntries.eco, input.eco.toUpperCase()));
  }
  if (input.q && input.q.trim()) {
    const needle = `%${input.q.trim()}%`;
    filters.push(
      or(
        ilike(openingBookEntries.name, needle),
        ilike(openingBookEntries.variation, needle),
      )!,
    );
  }

  const where = filters.length === 0
    ? undefined
    : filters.length === 1
      ? filters[0]
      : and(...filters);

  const rows = where
    ? await db
        .select()
        .from(openingBookEntries)
        .where(where)
        .orderBy(asc(openingBookEntries.eco), asc(openingBookEntries.name))
        .limit(limit)
    : await db
        .select()
        .from(openingBookEntries)
        .orderBy(asc(openingBookEntries.eco), asc(openingBookEntries.name))
        .limit(limit);

  return rows.map(toListItem);
}

export async function getOpeningByFenKey(fenKeyStr: string): Promise<OpeningDetail | null> {
  // The path param is treated as ALREADY-NORMALIZED — do not re-parse through
  // chess.js. The parity test in fen.parity.test.ts asserts both sides use the
  // same `fenKey()` helper.
  const row = await db.query.openingBookEntries.findFirst({
    where: eq(openingBookEntries.fenKey, fenKeyStr),
  });
  return row ? toListItem(row) : null;
}

export async function identifyDeepestOpeningFromPath(
  fenKeys: readonly string[],
): Promise<OpeningId | null> {
  if (fenKeys.length === 0) return null;
  // Single round trip: fetch every match for the path's keys, then walk the
  // path client-side using the shared helper so the matching logic stays in
  // one place.
  const rows = await db
    .select({
      eco: openingBookEntries.eco,
      name: openingBookEntries.name,
      variation: openingBookEntries.variation,
      fenKey: openingBookEntries.fenKey,
    })
    .from(openingBookEntries)
    .where(inArray(openingBookEntries.fenKey, fenKeys as string[]));

  const byKey = new Map<string, OpeningId>(
    rows.map((r) => [r.fenKey, { eco: r.eco, name: r.name, variation: r.variation }]),
  );
  return deepestFromLookup(fenKeys as FenKey[], (k) => byKey.get(k) ?? null);
}

/**
 * Phase 9a: bulk `fenKey → OpeningId` lookup for a whole repertoire in one
 * round trip.
 *
 * Scope filtering runs inside the queue builders, which are synchronous and
 * must work offline — so the client caches this map rather than doing a lookup
 * per card. Keys with no book entry are simply absent from the result.
 */
export async function lookupOpeningsByFenKeys(
  fenKeys: readonly string[],
): Promise<Record<string, OpeningId>> {
  if (fenKeys.length === 0) return {};
  const rows = await db
    .select({
      eco: openingBookEntries.eco,
      name: openingBookEntries.name,
      variation: openingBookEntries.variation,
      fenKey: openingBookEntries.fenKey,
    })
    .from(openingBookEntries)
    .where(inArray(openingBookEntries.fenKey, fenKeys as string[]));

  const out: Record<string, OpeningId> = {};
  for (const r of rows) {
    out[r.fenKey] = { eco: r.eco, name: r.name, variation: r.variation };
  }
  return out;
}

/**
 * Phase 7 guided builder: given any position in the book's reach, return the
 * set of known book moves out of it, each with the opening identity of the
 * position it leads to (if that child is itself a named entry).
 *
 * Computed by replaying every OpeningBookEntry's `pgn_moves` once and
 * recording each transition `(parentFenKey, san) -> { childFenKey, opening }`.
 * Cached in-process so subsequent requests are pure map lookups. The cache is
 * invalidated when the importer reloads the book (server restart in
 * practice).
 */
export interface BookContinuation {
  san: string;
  childFenKey: string;
  opening: OpeningId | null;
}

let continuationsCache: Map<string, BookContinuation[]> | null = null;
let continuationsBuildPromise: Promise<Map<string, BookContinuation[]>> | null = null;

async function buildContinuationsCache(): Promise<Map<string, BookContinuation[]>> {
  const rows = await db.select().from(openingBookEntries);
  const openingByKey = new Map<string, OpeningId>(
    rows.map((r) => [r.fenKey, { eco: r.eco, name: r.name, variation: r.variation }]),
  );

  // parentFenKey -> san -> BookContinuation
  const transitions = new Map<string, Map<string, BookContinuation>>();

  for (const r of rows) {
    const pgn = r.pgnMoves.trim();
    if (!pgn) continue;
    const replay = new Chess();
    try {
      replay.loadPgn(pgn, { strict: false });
    } catch {
      // Defensive: skip rows the importer would also flag.
      continue;
    }
    const history = replay.history({ verbose: true });
    const walker = new Chess();
    for (const step of history) {
      const parentKey = makeFenKey(walker.fen());
      const moveObj = walker.move(step.san);
      if (!moveObj) break;
      const childKey = makeFenKey(walker.fen());
      let bucket = transitions.get(parentKey);
      if (!bucket) {
        bucket = new Map();
        transitions.set(parentKey, bucket);
      }
      if (!bucket.has(step.san)) {
        bucket.set(step.san, {
          san: step.san,
          childFenKey: childKey,
          opening: openingByKey.get(childKey) ?? null,
        });
      }
    }
  }

  const flat = new Map<string, BookContinuation[]>();
  for (const [k, m] of transitions) {
    // Stable order: book-named children first (they're the headline branches),
    // then by SAN alphabetically.
    const arr = [...m.values()].sort((a, b) => {
      if ((a.opening !== null) !== (b.opening !== null)) return a.opening ? -1 : 1;
      return a.san.localeCompare(b.san);
    });
    flat.set(k, arr);
  }
  return flat;
}

export async function getBookContinuations(fenKey: string): Promise<BookContinuation[]> {
  if (!continuationsCache) {
    if (!continuationsBuildPromise) {
      continuationsBuildPromise = buildContinuationsCache();
    }
    continuationsCache = await continuationsBuildPromise;
  }
  return continuationsCache.get(fenKey) ?? [];
}

export function validateAndNormalizeFenKey(raw: string): string {
  // Defensive: if a caller sent a full FEN with halfmove/fullmove, normalize.
  try {
    return makeFenKey(raw);
  } catch (e) {
    throw new HttpError(400, `Invalid FEN/fenKey: ${(e as Error).message}`);
  }
}

function toListItem(r: {
  id: string;
  eco: string;
  name: string;
  variation: string | null;
  fenKey: string;
  fullFen: string;
  pgnMoves: string;
}): OpeningListItem {
  return {
    id: r.id,
    eco: r.eco,
    name: r.name,
    variation: r.variation,
    fenKey: r.fenKey,
    fullFen: r.fullFen,
    pgnMoves: r.pgnMoves,
  };
}
