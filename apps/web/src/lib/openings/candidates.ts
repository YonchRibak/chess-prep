/**
 * Phase 9c: composing candidate moves from the three sources, each doing only
 * its own job ([explorer](../../../../../knowledge/03-domain/explorer.md)).
 *
 * - **Opponent replies** come from the explorer (frequency), falling back to
 *   book continuations when the explorer is cold or too thin. The fallback is
 *   not a nicety: the explorer is unreachable on some networks and absent
 *   offline, and a build session must still work.
 * - **The user's own move** comes from the engine, re-ranked by explorer
 *   popularity only among moves the engine already considers equivalent.
 *
 * Fetching lives here; ranking lives in `packages/shared` so it is testable and
 * identical on both sides.
 */
import { Chess } from 'chess.js';
import {
  rankUserCandidates,
  selectOpponentReplies,
  type EngineCandidate,
  type ExplorerEntry,
  type RankedReply,
  type UserCandidate,
} from '@chess-prep/shared';
import { api, type BookContinuation } from '../../api/client.ts';
import type { EngineLine } from '../engine/engine.ts';

/** Where a candidate list came from — shown in the UI so the user can judge it. */
export type CandidateSource = 'explorer' | 'book' | 'none';

export interface OpponentCandidates {
  replies: RankedReply[];
  source: CandidateSource;
}

/**
 * Explorer entry for a position, or `null`. Never throws: an unreachable
 * explorer is an expected state, not an error
 * ([explorer](../../../../../knowledge/03-domain/explorer.md)).
 */
export async function fetchExplorerEntry(
  fenKey: string,
  opts: { cachedOnly?: boolean } = {},
): Promise<ExplorerEntry | null> {
  try {
    const { entry } = await api.getExplorerEntry(fenKey, opts);
    return entry;
  } catch {
    return null;
  }
}

/** Book continuations reduced to the same shape, with no frequency data. */
export function bookAsReplies(continuations: readonly BookContinuation[]): RankedReply[] {
  return continuations.map((c) => ({
    san: c.san,
    uci: '',
    share: 0,
    games: 0,
    score: null,
  }));
}

/**
 * The opponent replies worth preparing against at `fenKey`.
 *
 * `bookFallback` is used verbatim when the explorer yields nothing — the book
 * has no frequency data, so there is nothing to rank; its own ordering (named
 * children first) is the best available signal.
 */
export async function getOpponentCandidates(
  fenKey: string,
  sideToMove: 'w' | 'b',
  bookFallback: readonly BookContinuation[],
  opts: { cachedOnly?: boolean; max?: number } = {},
): Promise<OpponentCandidates> {
  const entry = await fetchExplorerEntry(fenKey, opts);
  const ranked = selectOpponentReplies(entry, sideToMove, {
    ...(opts.max === undefined ? {} : { maxReplies: opts.max }),
  });
  if (ranked.length > 0) return { replies: ranked, source: 'explorer' };

  const fromBook = bookAsReplies(bookFallback).slice(0, opts.max ?? 3);
  return {
    replies: fromBook,
    source: fromBook.length > 0 ? 'book' : 'none',
  };
}

/**
 * Turn engine lines into candidates for the user's own move.
 *
 * The engine speaks UCI; everything else here speaks SAN, so the conversion
 * happens once, at this boundary — chess.js is the only thing allowed to make
 * it ([separation-of-concerns](../../../../../knowledge/02-architecture/separation-of-concerns.md)).
 * Lines whose first move is illegal in this position (a stale analysis arriving
 * after a navigation) are dropped rather than rendered.
 */
export function engineLinesToCandidates(
  fullFen: string,
  lines: readonly EngineLine[],
): EngineCandidate[] {
  const out: EngineCandidate[] = [];
  for (const line of lines) {
    const uci = line.pv[0];
    if (!uci) continue;
    const san = uciToSan(fullFen, uci);
    if (!san) continue;
    out.push({
      san,
      uci,
      ...(line.cp === undefined ? {} : { cp: line.cp }),
      ...(line.mate === undefined ? {} : { mate: line.mate }),
    });
  }
  // MultiPV can repeat a move across depth updates; keep the first (best) one.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.uci) ? false : (seen.add(c.uci), true)));
}

function uciToSan(fullFen: string, uci: string): string | null {
  try {
    const chess = new Chess(fullFen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci.length > 4 ? { promotion: uci.slice(4, 5) } : {}),
    });
    return move?.san ?? null;
  } catch {
    return null;
  }
}

export interface UserCandidatesResult {
  candidates: UserCandidate[];
  source: CandidateSource;
}

/**
 * Ranked candidates for the user's own move at `fenKey`.
 *
 * With no engine lines this returns nothing rather than falling back to
 * popularity — the explorer must never pick the user's move on its own.
 */
export async function getUserCandidates(
  fenKey: string,
  fullFen: string,
  sideToMove: 'w' | 'b',
  lines: readonly EngineLine[],
  opts: { cachedOnly?: boolean } = {},
): Promise<UserCandidatesResult> {
  const engineCandidates = engineLinesToCandidates(fullFen, lines);
  if (engineCandidates.length === 0) return { candidates: [], source: 'none' };

  const entry = await fetchExplorerEntry(fenKey, opts);
  return {
    candidates: rankUserCandidates(engineCandidates, entry, sideToMove),
    source: entry ? 'explorer' : 'none',
  };
}
