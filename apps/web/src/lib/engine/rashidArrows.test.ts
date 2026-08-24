/**
 * Rashid R4 arrow mapping (style of arrows.test.ts): band thresholds at
 * their boundaries, the reward→thickness clamp (with mate at max), and that
 * the shape set encodes best-vs-secondary exactly as the spec's visual
 * design says — full-opacity badge on the best, pale unlabeled runners-up,
 * capped, and an empty board when nothing lights up.
 */
import { describe, it, expect } from 'vitest';
import { MATE_BASE, type RashidLine, type RashidResult } from '@chess-prep/shared';
import {
  RASHID_BRUSHES,
  rashidShapes,
  rewardLineWidth,
  riskBand,
} from './rashidArrows.ts';

function line(overrides: Partial<RashidLine>): RashidLine {
  return {
    rootUci: 'e2e4',
    line: ['e2e4'],
    pinchPoints: [],
    length: 1,
    riskScore: 0,
    rewardFloor: 100,
    rewardMax: 100,
    sacrifice: 0,
    ...overrides,
  };
}

function resultWith(best: RashidLine, ...rest: RashidLine[]): RashidResult {
  return {
    lightsUp: true,
    best,
    lines: [best, ...rest],
    bestRootScore: 0,
    candidates: [],
  };
}

describe('riskBand', () => {
  it('quantizes at the spec boundaries', () => {
    expect(riskBand(30)).toBe('free');
    expect(riskBand(29)).toBe('safe');
    expect(riskBand(-20)).toBe('safe');
    expect(riskBand(-21)).toBe('gambit');
    expect(riskBand(-50)).toBe('gambit');
    expect(riskBand(-51)).toBe('speculative');
  });
});

describe('rewardLineWidth', () => {
  it('clamps the spec scale and maxes out on mate', () => {
    expect(rewardLineWidth(50)).toBe(8); // floor of the scale
    expect(rewardLineWidth(0)).toBe(8); // below scale still clamps
    expect(rewardLineWidth(300)).toBe(16); // top of the cp scale
    expect(rewardLineWidth(1000)).toBe(16); // clamped
    expect(rewardLineWidth(MATE_BASE - 3)).toBe(18); // mate = max thickness
    expect(rewardLineWidth(null)).toBe(8);
    expect(rewardLineWidth(175)).toBe(12); // midpoint sanity
  });
});

describe('rashidShapes', () => {
  it('encodes the best line as hue + thickness + length badge', () => {
    const r = resultWith(line({ rootUci: 'd1h5', riskScore: 40, rewardFloor: 300, length: 2 }));
    expect(rashidShapes(r)).toEqual([
      {
        orig: 'd1',
        dest: 'h5',
        brush: 'rashidFree',
        modifiers: { lineWidth: 16 },
        label: { text: '2' },
      },
    ]);
  });

  it('draws runners-up pale and unlabeled, capped at maxSecondary', () => {
    const r = resultWith(
      line({ rootUci: 'e2e4' }),
      line({ rootUci: 'd2d4', riskScore: -60 }),
      line({ rootUci: 'c2c4' }),
      line({ rootUci: 'b2b4' }),
    );
    const shapes = rashidShapes(r);
    expect(shapes).toHaveLength(3); // best + 2 secondary
    expect(shapes[1]).toMatchObject({ orig: 'd2', dest: 'd4', brush: 'rashidSpecPale' });
    expect(shapes[1]?.label).toBeUndefined();
    expect(rashidShapes(r, { maxSecondary: 0 })).toHaveLength(1);
  });

  it('clears the board when nothing lights up', () => {
    expect(rashidShapes(null)).toEqual([]);
    expect(
      rashidShapes({ lightsUp: false, best: null, lines: [], bestRootScore: 0, candidates: [] }),
    ).toEqual([]);
  });

  it('every brush a shape can name is registered, in primary and pale form', () => {
    for (const band of ['rashidFree', 'rashidSafe', 'rashidGambit', 'rashidSpec']) {
      expect(RASHID_BRUSHES[band]).toBeDefined();
      expect(RASHID_BRUSHES[`${band}Pale`]).toBeDefined();
      expect(RASHID_BRUSHES[`${band}Pale`]?.opacity ?? 1).toBeLessThan(
        RASHID_BRUSHES[band]?.opacity ?? 0,
      );
    }
  });
});
