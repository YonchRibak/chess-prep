import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { pgnToTree, treeToPgn, InvalidPgnError } from './pgn.js';
import { STARTING_FEN_KEY } from './fen.js';

describe('pgnToTree', () => {
  it('parses a simple linear PGN', () => {
    const t = pgnToTree('1. e4 e5 2. Nf3 Nc6 *');
    expect(t.moves).toHaveLength(4);
    expect(t.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(t.moves.every((m) => m.isMainLine)).toBe(true);
    expect(t.rootFenKey).toBe(STARTING_FEN_KEY);
  });

  it('parses variations as non-main-line siblings of the same parent', () => {
    const t = pgnToTree('1. e4 e5 (1... c5 {Sicilian}) 2. Nf3 *');
    const e4 = t.moves.find((m) => m.san === 'e4');
    const e5 = t.moves.find((m) => m.san === 'e5');
    const c5 = t.moves.find((m) => m.san === 'c5');
    expect(e4?.isMainLine).toBe(true);
    expect(e5?.isMainLine).toBe(true);
    expect(c5?.isMainLine).toBe(false);
    expect(c5?.parentFenKey).toBe(e5?.parentFenKey);
    expect(c5?.comment).toBe('Sicilian');
  });

  it('captures NAGs (annotations) on moves', () => {
    const t = pgnToTree('1. e4 $1 e5 $2 *');
    expect(t.moves.find((m) => m.san === 'e4')?.annotation).toBe('$1');
    expect(t.moves.find((m) => m.san === 'e5')?.annotation).toBe('$2');
  });

  it('collapses transpositions to a single position node', () => {
    // 1.d4 d5 2.c4 reaches the same position as 1.c4 d5 2.d4 (Slav-like move order).
    const a = pgnToTree('1. d4 d5 2. c4 *');
    const b = pgnToTree('1. c4 d5 2. d4 *');
    // Final position key is the same in both trees.
    const lastA = a.moves[a.moves.length - 1]!;
    const lastB = b.moves[b.moves.length - 1]!;
    expect(lastA.childFenKey).toBe(lastB.childFenKey);
  });

  it('throws InvalidPgnError on illegal moves', () => {
    expect(() => pgnToTree('1. e4 e5 2. Nf3 e4 *')).toThrow(InvalidPgnError);
  });

  it('throws InvalidPgnError on malformed PGN', () => {
    expect(() => pgnToTree('not a pgn ###')).toThrow(InvalidPgnError);
  });

  it('parses from a custom starting FEN', () => {
    // Black to move with a forced win
    const fen = '4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1';
    const t = pgnToTree('1... Kd8 2. Qe7+ *', { startFen: fen });
    expect(t.rootFullFen).toBe(fen);
    expect(t.moves[0]!.san).toBe('Kd8');
  });
});

describe('treeToPgn → pgnToTree round-trip', () => {
  it('round-trips a simple linear PGN losslessly (structure preserved)', () => {
    const original = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *';
    const tree1 = pgnToTree(original);
    const pgn1 = treeToPgn(tree1);
    const tree2 = pgnToTree(pgn1);
    expect(extractStructure(tree2)).toEqual(extractStructure(tree1));
  });

  it('round-trips a PGN with variations', () => {
    const original = '1. e4 e5 (1... c5 2. Nf3 d6) 2. Nf3 Nc6 *';
    const tree1 = pgnToTree(original);
    const pgn1 = treeToPgn(tree1);
    const tree2 = pgnToTree(pgn1);
    expect(extractStructure(tree2)).toEqual(extractStructure(tree1));
  });

  it('round-trips a PGN with nested variations', () => {
    const original = '1. e4 e5 (1... c5 (1... e6 2. d4) 2. Nf3) 2. Nf3 *';
    const tree1 = pgnToTree(original);
    const pgn1 = treeToPgn(tree1);
    const tree2 = pgnToTree(pgn1);
    expect(extractStructure(tree2)).toEqual(extractStructure(tree1));
  });

  it('round-trips comments and annotations', () => {
    const original = '1. e4 $1 {King pawn opening} e5 2. Nf3 {Most popular reply} *';
    const tree1 = pgnToTree(original);
    const pgn1 = treeToPgn(tree1);
    const tree2 = pgnToTree(pgn1);
    expect(extractStructure(tree2)).toEqual(extractStructure(tree1));
    // Make sure the comment text survived
    const nf3 = tree2.moves.find((m) => m.san === 'Nf3');
    expect(nf3?.comment).toContain('Most popular');
    expect(tree2.moves.find((m) => m.san === 'e4')?.annotation).toBe('$1');
  });

  it('exported PGN is itself replayable by chess.js', () => {
    const tree = pgnToTree('1. e4 e5 (1... c5) 2. Nf3 Nc6 3. Bb5 *');
    const pgn = treeToPgn(tree);
    // chess.js should load the main line cleanly (it ignores variations).
    const game = new Chess();
    expect(() => game.loadPgn(pgn)).not.toThrow();
    expect(game.history()).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
  });
});

/** Extracts the structural facts that should be stable across round-trips. */
function extractStructure(t: ReturnType<typeof pgnToTree>) {
  return {
    rootFenKey: t.rootFenKey,
    positions: [...t.positions.map((p) => p.fenKey)].sort(),
    edges: [...t.moves.map((m) => `${m.parentFenKey}::${m.san}::${m.isMainLine}`)].sort(),
  };
}
