/**
 * Phase 9d — refutation shadow lines.
 *
 * After a miss, the engine's principal variation from the position the user
 * *reached by playing the wrong move* is the punishment for that mistake. We
 * store a few plies of it so the user can see why the move loses.
 *
 * A shadow line is **stored but never prep**: it gets no SRS card, the walker's
 * build seed does not treat it as coverage, neither queue builder drills it,
 * and PGN export omits it. The marker is `moves.is_refutation` — a dedicated
 * column, not a line tag, because every one of those call sites has to exclude
 * it and a forgotten tag check fails silently (a shadow line would quietly turn
 * into a drilled card).
 *
 * This module is the pure part: converting an engine PV into the SAN list the
 * API stores. It lives in `packages/shared` because both sides agree on the
 * ply cap.
 */
import { Chess } from 'chess.js';

/**
 * How deep a stored refutation goes. Long enough to show the point (usually a
 * capture and its follow-up), short enough that shadow lines never dominate the
 * tree — they are illustration, not repertoire.
 */
export const MAX_REFUTATION_PLIES = 6;

/**
 * The FEN reached by playing `san` in `fullFen`, or `null` if it is illegal.
 *
 * Exists so the refutation UI never has to touch chess.js itself: the position
 * to analyze after a miss is "the one the wrong move reached", and getting that
 * wrong would point the engine at the card's own position — the one place it
 * must never look while the card is unanswered.
 */
export function fenAfterSan(fullFen: string, san: string): string | null {
  const chess = new Chess();
  try {
    chess.load(fullFen);
    const played = chess.move(san);
    if (!played) return null;
  } catch {
    return null;
  }
  return chess.fen();
}

/**
 * Convert an engine PV (UCI moves, as Stockfish emits them) into SAN, playing
 * from `fullFen` and stopping at `maxPlies`.
 *
 * Truncates rather than throws on the first move the position rejects: a PV can
 * outlive the search that produced it, and a partial refutation is still worth
 * storing. Returns `[]` when nothing is playable, which callers treat as "no
 * refutation to save" rather than as an error.
 */
export function pvToRefutationSans(
  fullFen: string,
  pvUci: readonly string[],
  maxPlies: number = MAX_REFUTATION_PLIES,
): string[] {
  const chess = new Chess();
  try {
    chess.load(fullFen);
  } catch {
    return [];
  }
  const sans: string[] = [];
  for (const uci of pvUci) {
    if (sans.length >= maxPlies) break;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    let played;
    try {
      played = chess.move({ from, to, promotion });
    } catch {
      break;
    }
    if (!played) break;
    sans.push(played.san);
  }
  return sans;
}
