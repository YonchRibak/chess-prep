/**
 * Phase 9b: the opening-explorer cache.
 *
 * The explorer answers exactly one question — *which opponent replies matter*,
 * by frequency and result. It does not name openings (the ECO book does) and it
 * does not choose the user's move (Stockfish does, with explorer popularity only
 * breaking ties). See
 * [repertoire-growth](../../../../knowledge/03-domain/repertoire-growth.md).
 *
 * **This table is a cache, never a source of truth.** Every caller must behave
 * sanely when it is cold, so this module never throws on a network failure — it
 * returns whatever is stored, or `null`. A stale row beats an error: opening
 * statistics move over months, not minutes.
 *
 * Selection policy deliberately lives in `packages/shared` (`explorer.ts`), not
 * here, so the client and server rank identically.
 */
import { and, eq } from 'drizzle-orm';
import { Chess } from 'chess.js';
import {
  fenKey as makeFenKey,
  type ExplorerEntry,
  type ExplorerMoveStat,
} from '@chess-prep/shared';
import { db } from '../db/client.js';
import { explorerEntries } from '../db/schema.js';
import { HttpError } from './repertoires.js';

/**
 * The lichess dataset and filters we cache. Changing any of these changes the
 * `source` key, which invalidates old rows by construction rather than by a
 * migration — the stale rows simply stop being read.
 */
const SPEEDS = ['blitz', 'rapid', 'classical'] as const;
const MIN_RATING = 1600;
export const EXPLORER_SOURCE = `lichess:${SPEEDS.join(',')}:${MIN_RATING}`;

const EXPLORER_URL = 'https://explorer.lichess.ovh/lichess';
/** Lichess asks for a descriptive UA so they can contact us about abuse. */
const USER_AGENT = 'chess-prep/0.1 (personal opening-prep tool)';
const FETCH_TIMEOUT_MS = 6000;
/** Opening statistics drift over months; a day-old row is fine. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Set while we are being rate-limited. Lichess returns 429 with no body; the
 * documented remedy is to back off wholesale rather than per-endpoint, so one
 * 429 pauses *all* explorer fetches. Reads keep working from cache throughout.
 */
let backoffUntilMs = 0;
const BACKOFF_MS = 60_000;

export function explorerBackoffRemainingMs(now = Date.now()): number {
  return Math.max(0, backoffUntilMs - now);
}

/** Test seam: forget any active backoff. */
export function resetExplorerBackoff(): void {
  backoffUntilMs = 0;
}

export interface GetExplorerOptions {
  /** Serve a cached row younger than this without refetching. */
  maxAgeMs?: number;
  /** Never hit the network; cache-only read (used by bulk warm checks). */
  cachedOnly?: boolean;
}

/**
 * The explorer record for a position: cached if fresh, otherwise refetched,
 * falling back to the stale row (then to `null`) when the network says no.
 */
export async function getExplorerEntry(
  fenKeyStr: string,
  options: GetExplorerOptions = {},
): Promise<ExplorerEntry | null> {
  const { maxAgeMs = DEFAULT_MAX_AGE_MS, cachedOnly = false } = options;

  const cached = await readCached(fenKeyStr);
  if (cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < maxAgeMs) return cached;
  }
  if (cachedOnly || explorerBackoffRemainingMs() > 0) return cached;

  const fetched = await fetchFromLichess(fenKeyStr);
  if (!fetched) return cached; // offline / rate-limited / malformed — stale is fine.

  await upsert(fetched);
  return fetched;
}

async function readCached(fenKeyStr: string): Promise<ExplorerEntry | null> {
  const row = await db.query.explorerEntries.findFirst({
    where: and(
      eq(explorerEntries.fenKey, fenKeyStr),
      eq(explorerEntries.source, EXPLORER_SOURCE),
    ),
  });
  if (!row) return null;
  return {
    fenKey: row.fenKey,
    source: row.source,
    total: row.total,
    moves: (row.moves ?? []) as ExplorerMoveStat[],
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

async function upsert(entry: ExplorerEntry): Promise<void> {
  await db
    .insert(explorerEntries)
    .values({
      fenKey: entry.fenKey,
      source: entry.source,
      total: entry.total,
      moves: entry.moves,
      fetchedAt: new Date(entry.fetchedAt),
    })
    .onConflictDoUpdate({
      target: [explorerEntries.fenKey, explorerEntries.source],
      set: {
        total: entry.total,
        moves: entry.moves,
        fetchedAt: new Date(entry.fetchedAt),
      },
    });
}

/**
 * Fetch one position. Returns `null` for *any* failure — including a 429, which
 * additionally arms the global backoff. Never throws: a cache fill failing must
 * not fail the request that triggered it.
 */
async function fetchFromLichess(fenKeyStr: string): Promise<ExplorerEntry | null> {
  // The explorer wants a full FEN. A fenKey lacks the clocks, and their values
  // don't affect opening statistics, so append neutral ones.
  const params = new URLSearchParams({
    variant: 'standard',
    fen: `${fenKeyStr} 0 1`,
    speeds: SPEEDS.join(','),
    ratings: String(MIN_RATING),
    moves: '12',
    topGames: '0',
    recentGames: '0',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${EXPLORER_URL}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (res.status === 429) {
      backoffUntilMs = Date.now() + BACKOFF_MS;
      console.warn('[explorer] rate limited — backing off for 60s');
      return null;
    }
    if (!res.ok) return null;
    return parseExplorerResponse(fenKeyStr, await res.json());
  } catch (e) {
    // Offline, DNS failure, timeout, or a TLS-interception proxy without
    // NODE_EXTRA_CA_CERTS set — all the same to us: no data this time.
    console.warn('[explorer] fetch failed', (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize a lichess explorer payload. Exported for tests, which is why it
 * takes `unknown` and validates rather than trusting a type assertion — this is
 * third-party JSON crossing a trust boundary.
 */
export function parseExplorerResponse(fenKeyStr: string, body: unknown): ExplorerEntry | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as { moves?: unknown; white?: unknown; draws?: unknown; black?: unknown };
  if (!Array.isArray(raw.moves)) return null;

  const moves: ExplorerMoveStat[] = [];
  for (const m of raw.moves) {
    if (!m || typeof m !== 'object') continue;
    const { san, uci, white, draws, black } = m as Record<string, unknown>;
    if (typeof san !== 'string' || typeof uci !== 'string') continue;
    if (!isCount(white) || !isCount(draws) || !isCount(black)) continue;
    moves.push({ san, uci, white, draws, black });
  }

  // Prefer the position totals lichess reports; they include moves trimmed by
  // the `moves` cap, so shares stay honest instead of summing to 1 over a
  // truncated list.
  const total = isCount(raw.white) && isCount(raw.draws) && isCount(raw.black)
    ? raw.white + raw.draws + raw.black
    : moves.reduce((n, m) => n + m.white + m.draws + m.black, 0);

  return {
    fenKey: fenKeyStr,
    source: EXPLORER_SOURCE,
    total,
    moves,
    fetchedAt: new Date().toISOString(),
  };
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Validate a client-supplied fenKey by round-tripping it through chess.js.
 * Mirrors `validateAndNormalizeFenKey` in openings.ts, but the explorer path
 * also needs to reject positions chess.js won't accept before we spend a
 * network call on them.
 */
export function validateExplorerFenKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new HttpError(400, 'fenKey is required');
  try {
    // A fenKey has no clocks; chess.js needs a full FEN to validate.
    new Chess(`${trimmed} 0 1`);
  } catch {
    throw new HttpError(400, `Not a valid position: "${trimmed}"`);
  }
  return makeFenKey(`${trimmed} 0 1`);
}
