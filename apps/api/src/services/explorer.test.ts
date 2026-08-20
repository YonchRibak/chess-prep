/**
 * Pure-logic tests for the explorer cache: parsing third-party JSON and the
 * fenKey guard. The fetch/cache round trip itself is not covered — it would
 * mean either hitting lichess from CI or mocking the network, and the behavior
 * that actually matters (never throw, fall back to stale, fall back to null) is
 * a property of code paths that all funnel through the parser below.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPLORER_SOURCE,
  parseExplorerResponse,
  validateExplorerFenKey,
} from './explorer.js';

const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

describe('parseExplorerResponse', () => {
  it('reads moves and totals from a well-formed payload', () => {
    const entry = parseExplorerResponse(START_KEY, {
      white: 500,
      draws: 200,
      black: 300,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 300, draws: 100, black: 150 },
        { san: 'd4', uci: 'd2d4', white: 150, draws: 80, black: 100 },
      ],
    });
    expect(entry!.total).toBe(1000);
    expect(entry!.moves).toHaveLength(2);
    expect(entry!.source).toBe(EXPLORER_SOURCE);
  });

  it('uses the position totals, not the move sum, so shares stay honest', () => {
    // Lichess caps the returned move list; summing it would inflate every
    // share to fill a truncated 100%.
    const entry = parseExplorerResponse(START_KEY, {
      white: 900,
      draws: 50,
      black: 50,
      moves: [{ san: 'e4', uci: 'e2e4', white: 400, draws: 0, black: 100 }],
    });
    expect(entry!.total).toBe(1000);
  });

  it('falls back to summing the moves when totals are absent', () => {
    const entry = parseExplorerResponse(START_KEY, {
      moves: [{ san: 'e4', uci: 'e2e4', white: 4, draws: 3, black: 3 }],
    });
    expect(entry!.total).toBe(10);
  });

  it('drops malformed move rows instead of trusting the payload', () => {
    const entry = parseExplorerResponse(START_KEY, {
      moves: [
        { san: 'e4', uci: 'e2e4', white: 10, draws: 0, black: 5 },
        { san: 'd4' }, // no uci or counts
        { san: 'c4', uci: 'c2c4', white: -1, draws: 0, black: 0 }, // negative count
        null,
      ],
    });
    expect(entry!.moves.map((m) => m.san)).toEqual(['e4']);
  });

  it('returns null for a payload that is not an explorer response', () => {
    expect(parseExplorerResponse(START_KEY, null)).toBeNull();
    expect(parseExplorerResponse(START_KEY, { error: 'nope' })).toBeNull();
    expect(parseExplorerResponse(START_KEY, 'html error page')).toBeNull();
  });
});

describe('validateExplorerFenKey', () => {
  it('accepts and normalizes a real position', () => {
    expect(validateExplorerFenKey(` ${START_KEY} `)).toBe(START_KEY);
  });

  it('rejects nonsense before spending a network call on it', () => {
    expect(() => validateExplorerFenKey('not-a-fen')).toThrow();
    expect(() => validateExplorerFenKey('')).toThrow();
  });
});
