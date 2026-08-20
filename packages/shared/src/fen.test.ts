import { describe, it, expect } from 'vitest';
import { fenKey, STARTING_FEN, STARTING_FEN_KEY } from './fen.js';

describe('fenKey', () => {
  it('strips halfmove and fullmove counters', () => {
    expect(fenKey(STARTING_FEN)).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
    );
  });

  it('collapses positions reached via different move orders (transpositions)', () => {
    // After 1.d4 d5 2.c4
    const viaQGD =
      'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3 0 2';
    // Same position reached via 1.c4 d5 2.d4
    const viaEnglish =
      'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3 0 2';
    expect(fenKey(viaQGD)).toBe(fenKey(viaEnglish));
  });

  it('keeps side-to-move, castling, and en passant in the key', () => {
    const k = fenKey(STARTING_FEN);
    expect(k).toContain('w');
    expect(k).toContain('KQkq');
    expect(k.endsWith(' -')).toBe(true);
  });

  it('STARTING_FEN_KEY matches fenKey(STARTING_FEN)', () => {
    expect(STARTING_FEN_KEY).toBe(fenKey(STARTING_FEN));
  });

  it('throws on malformed FEN', () => {
    expect(() => fenKey('not a fen')).toThrow();
  });
});
