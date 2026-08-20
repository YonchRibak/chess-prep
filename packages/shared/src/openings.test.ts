import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { fenKey } from './fen.js';
import {
  identifyDeepestOpening,
  identifyOpening,
  splitOpeningName,
  type OpeningId,
} from './openings.js';

/**
 * Replays a PGN move sequence through chess.js and returns the fenKey of the
 * resulting position. This is the *exact* operation the importer performs per
 * row, so any whitespace/encoding drift between this function and the importer
 * would mean the lookup map can never hit.
 */
function fenKeyAfterPgn(pgn: string): string {
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: false });
  return fenKey(chess.fen());
}

describe('opening normalization parity', () => {
  // These are the canonical names + PGNs straight from the lichess
  // `chess-openings` TSV. If chess.js or fenKey() ever drift in a way that
  // breaks lookup, these tests fail before users do.
  const cases: Array<{ pgn: string; expectedFenKey: string; label: string }> = [
    {
      label: 'starting position',
      pgn: '',
      expectedFenKey: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
    },
    {
      label: "Caro-Kann (B10) — '1. e4 c6'",
      pgn: '1. e4 c6',
      expectedFenKey: 'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
    },
    {
      label: "Caro-Kann Advance (B12) — '1. e4 c6 2. d4 d5 3. e5'",
      pgn: '1. e4 c6 2. d4 d5 3. e5',
      expectedFenKey: 'rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq -',
    },
    {
      label: "King's Indian Sämisch (E80) — '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f3'",
      pgn: '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f3',
      expectedFenKey: 'rnbqk2r/ppp1ppbp/3p1np1/8/2PPP3/2N2P2/PP4PP/R1BQKBNR b KQkq -',
    },
  ];

  for (const c of cases) {
    it(`${c.label} normalizes to the expected fenKey`, () => {
      expect(fenKeyAfterPgn(c.pgn)).toBe(c.expectedFenKey);
    });
  }
});

describe('splitOpeningName', () => {
  it('splits on the first colon only', () => {
    expect(splitOpeningName('Caro-Kann Defense')).toEqual({
      name: 'Caro-Kann Defense',
      variation: null,
    });
    expect(splitOpeningName('Caro-Kann Defense: Advance Variation')).toEqual({
      name: 'Caro-Kann Defense',
      variation: 'Advance Variation',
    });
    // Sub-variations after a comma stay grouped under the first colon.
    expect(
      splitOpeningName('Caro-Kann Defense: Advance Variation, Short Variation'),
    ).toEqual({
      name: 'Caro-Kann Defense',
      variation: 'Advance Variation, Short Variation',
    });
  });

  it('handles edge cases', () => {
    expect(splitOpeningName('Foo: ')).toEqual({ name: 'Foo', variation: null });
    expect(splitOpeningName('  Foo  ')).toEqual({ name: 'Foo', variation: null });
  });
});

describe('identifyOpening / identifyDeepestOpening', () => {
  const startKey = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -' as ReturnType<typeof fenKey>;
  const e4c6Key = 'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -' as ReturnType<typeof fenKey>;
  const advanceKey = 'rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq -' as ReturnType<typeof fenKey>;
  const unknownKey = 'k7/8/8/8/8/8/8/K7 w - -' as ReturnType<typeof fenKey>;

  const book = new Map<string, OpeningId>([
    [e4c6Key, { eco: 'B10', name: 'Caro-Kann Defense', variation: null }],
    [advanceKey, { eco: 'B12', name: 'Caro-Kann Defense', variation: 'Advance Variation' }],
  ]);
  const lookup = (k: string) => book.get(k) ?? null;

  it('starting position is unknown', () => {
    expect(identifyOpening(startKey, lookup as never)).toBeNull();
  });

  it('exact match returns the entry', () => {
    expect(identifyOpening(e4c6Key, lookup as never)).toEqual({
      eco: 'B10',
      name: 'Caro-Kann Defense',
      variation: null,
    });
  });

  it('identifyDeepest returns the last (most specific) hit along the path', () => {
    const path = [startKey, e4c6Key, advanceKey];
    expect(identifyDeepestOpening(path, lookup as never)).toEqual({
      eco: 'B12',
      name: 'Caro-Kann Defense',
      variation: 'Advance Variation',
    });
  });

  it('identifyDeepest returns last-known when current FEN is not in book (transposition)', () => {
    // path ends in an unknown position — should fall back to the deepest match.
    const path = [startKey, e4c6Key, unknownKey];
    expect(identifyDeepestOpening(path, lookup as never)).toEqual({
      eco: 'B10',
      name: 'Caro-Kann Defense',
      variation: null,
    });
  });

  it('identifyDeepest returns null when nothing along the path matches', () => {
    expect(identifyDeepestOpening([startKey, unknownKey], lookup as never)).toBeNull();
  });
});
