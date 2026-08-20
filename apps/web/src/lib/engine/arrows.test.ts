import { describe, expect, it } from 'vitest';
import { engineArrows } from './arrows.ts';
import type { AnalysisProgress } from './engine.ts';

function progress(lines: { multipv: number; pv: string[] }[]): AnalysisProgress {
  return {
    fen: 'startpos',
    depth: 12,
    lines: lines.map((l) => ({ ...l, depth: 12, cp: 0 })),
    bestmove: null,
    done: false,
  };
}

describe('engineArrows', () => {
  it('returns nothing without progress (gated / idle engine clears the board)', () => {
    expect(engineArrows(null)).toEqual([]);
    expect(engineArrows(progress([]))).toEqual([]);
  });

  it('draws one arrow per line, ranked by multipv', () => {
    const shapes = engineArrows(
      progress([
        { multipv: 2, pv: ['g1f3', 'b8c6'] },
        { multipv: 1, pv: ['e2e4', 'e7e5'] },
      ]),
    );
    expect(shapes).toEqual([
      { orig: 'e2', dest: 'e4', brush: 'green' },
      { orig: 'g1', dest: 'f3', brush: 'blue' },
    ]);
  });

  it('honors max and skips unusable lines', () => {
    const shapes = engineArrows(
      progress([
        { multipv: 1, pv: ['e2e4'] },
        { multipv: 2, pv: [] },
        { multipv: 3, pv: ['d2d4'] },
      ]),
      { max: 1 },
    );
    expect(shapes).toEqual([{ orig: 'e2', dest: 'e4', brush: 'green' }]);
  });

  it('keeps promotion moves as plain from/to arrows', () => {
    expect(engineArrows(progress([{ multipv: 1, pv: ['e7e8q'] }]))).toEqual([
      { orig: 'e7', dest: 'e8', brush: 'green' },
    ]);
  });
});
