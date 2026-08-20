/**
 * FEN normalization for position-keyed move trees.
 *
 * A full FEN has 6 fields:
 *   <pieces> <side> <castling> <ep> <halfmove> <fullmove>
 *
 * The key (`fenKey`) keeps the first 4 fields so transpositions collapse to
 * a single position node. The other 2 fields are session-state, not identity.
 *
 * Both client and server must use this helper so opponent and repertoire
 * trees key identically.
 */

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export type FenKey = string & { readonly __brand: 'FenKey' };

export function fenKey(fen: string): FenKey {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    throw new Error(`Invalid FEN (need at least 4 fields): "${fen}"`);
  }
  return parts.slice(0, 4).join(' ') as FenKey;
}

export function isFenKey(s: string): s is FenKey {
  const parts = s.trim().split(/\s+/);
  return parts.length === 4;
}

export const STARTING_FEN_KEY: FenKey = fenKey(STARTING_FEN);
export { STARTING_FEN };
