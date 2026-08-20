import { describe, expect, it } from 'vitest';
import { STARTING_FEN } from '@chess-prep/shared';
import { bookAsReplies, engineLinesToCandidates } from './candidates.ts';
import type { EngineLine } from '../engine/engine.ts';

function line(pv: string[], extra: Partial<EngineLine> = {}): EngineLine {
  return { multipv: 1, depth: 20, pv, ...extra };
}

describe('engineLinesToCandidates', () => {
  it('converts the first UCI move of each line to SAN', () => {
    const out = engineLinesToCandidates(STARTING_FEN, [
      line(['e2e4', 'e7e5'], { cp: 30 }),
      line(['g1f3'], { cp: 25, multipv: 2 }),
    ]);
    expect(out.map((c) => c.san)).toEqual(['e4', 'Nf3']);
    expect(out[0]!.cp).toBe(30);
  });

  it('drops a line whose move is illegal here (a stale analysis arriving late)', () => {
    const out = engineLinesToCandidates(STARTING_FEN, [line(['e2e4']), line(['e7e5'])]);
    expect(out.map((c) => c.san)).toEqual(['e4']);
  });

  it('de-duplicates the same move repeated across depth updates', () => {
    const out = engineLinesToCandidates(STARTING_FEN, [
      line(['e2e4'], { depth: 18 }),
      line(['e2e4'], { depth: 20 }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('ignores lines with an empty PV', () => {
    expect(engineLinesToCandidates(STARTING_FEN, [line([])])).toEqual([]);
  });

  it('carries a mate score through instead of inventing a centipawn value', () => {
    const out = engineLinesToCandidates(STARTING_FEN, [line(['e2e4'], { mate: 3 })]);
    expect(out[0]).toMatchObject({ san: 'e4', mate: 3 });
    expect(out[0]!.cp).toBeUndefined();
  });
});

describe('bookAsReplies', () => {
  it('keeps book order and marks the absence of frequency data', () => {
    const out = bookAsReplies([
      { san: 'c5', childFenKey: 'k1', opening: null },
      { san: 'e5', childFenKey: 'k2', opening: null },
    ]);
    expect(out.map((r) => r.san)).toEqual(['c5', 'e5']);
    // share/games of 0 is "unknown", not "never played" — the UI must not
    // render a 0% next to a book suggestion.
    expect(out.every((r) => r.games === 0 && r.score === null)).toBe(true);
  });
});
