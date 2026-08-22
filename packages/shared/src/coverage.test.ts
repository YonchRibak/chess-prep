/**
 * Flow F3.2: game-weighted coverage math on fixture trees, and the honest
 * degradation when explorer entries are missing.
 */
import { describe, expect, it } from 'vitest';
import {
  computeGameWeightedCoverage,
  gameWeightedCoverageUsable,
  type CoverageNode,
} from './coverage.js';
import type { ExplorerEntry } from './explorer.js';

function entry(fenKey: string, moves: Array<[string, string, number]>, total?: number): ExplorerEntry {
  const t = total ?? moves.reduce((n, [, , games]) => n + games, 0);
  return {
    fenKey,
    source: 'test',
    total: t,
    moves: moves.map(([san, uci, games]) => ({ san, uci, white: games, draws: 0, black: 0 })),
    fetchedAt: '2026-08-01T00:00:00Z',
  };
}

/**
 * White walk from `w0`:
 *   w0 (user) -e4-> b1 (opponent: e5 60%, c5 30%, d5 10%) — prepared: e5, c5
 *     e5 → w2 (user, prepped Nf3) → b3 (opponent, leaf in our tree)
 *     c5 → w4 (user, NO prep)
 */
const NODES = new Map<string, CoverageNode>([
  ['w0', { isUserTurn: true, moves: [{ san: 'e4', uci: 'e2e4', childFenKey: 'b1' }] }],
  [
    'b1',
    {
      isUserTurn: false,
      moves: [
        { san: 'e5', uci: 'e7e5', childFenKey: 'w2' },
        { san: 'c5', uci: 'c7c5', childFenKey: 'w4' },
      ],
    },
  ],
  ['w2', { isUserTurn: true, moves: [{ san: 'Nf3', uci: 'g1f3', childFenKey: 'b3' }] }],
  ['b3', { isUserTurn: false, moves: [] }],
  ['w4', { isUserTurn: true, moves: [] }],
]);

const ENTRIES = new Map<string, ExplorerEntry>([
  ['b1', entry('b1', [['e5', 'e7e5', 60], ['c5', 'c7c5', 30], ['d5', 'd7d5', 10]])],
]);

describe('computeGameWeightedCoverage', () => {
  it('weights covered/uncovered mass by reply shares', () => {
    const cov = computeGameWeightedCoverage({
      rootFenKey: 'w0',
      nodes: NODES,
      getEntry: (k) => ENTRIES.get(k) ?? null,
      maxDepthPlies: 4,
    });
    // 60% follows e5 → Nf3 → b3, which has no prepared replies → uncovered.
    // 30% follows c5 → w4, an unprepped user turn → uncovered.
    // 10% (d5) is unprepared at b1 → uncovered.
    expect(cov.coveredShare).toBeCloseTo(0, 5);
    expect(cov.uncoveredShare).toBeCloseTo(1, 5);
    expect(cov.nodesWithData).toBe(1);
  });

  it('mass that reaches the depth cap inside prep counts as covered', () => {
    const cov = computeGameWeightedCoverage({
      rootFenKey: 'w0',
      nodes: NODES,
      getEntry: (k) => ENTRIES.get(k) ?? null,
      maxDepthPlies: 3, // e4, e5, Nf3 — b3 sits AT the cap
    });
    expect(cov.coveredShare).toBeCloseTo(0.6, 5); // the e5 line reached target
    expect(cov.uncoveredShare).toBeCloseTo(0.4, 5); // c5 line + d5 tail
  });

  it('the truncated tail of unlisted rare moves counts as uncovered', () => {
    // Explorer lists moves for only 90% of games; the remaining 10% cannot be
    // prepared for by definition.
    const entries = new Map([
      ['b1', entry('b1', [['e5', 'e7e5', 60], ['c5', 'c7c5', 30]], 100)],
    ]);
    const cov = computeGameWeightedCoverage({
      rootFenKey: 'w0',
      nodes: NODES,
      getEntry: (k) => entries.get(k) ?? null,
      maxDepthPlies: 3,
    });
    expect(cov.coveredShare).toBeCloseTo(0.6, 5);
    expect(cov.uncoveredShare).toBeCloseTo(0.4, 5);
  });

  it('a cold opponent node parks its mass as unknown instead of guessing', () => {
    const cov = computeGameWeightedCoverage({
      rootFenKey: 'w0',
      nodes: NODES,
      getEntry: () => null,
      maxDepthPlies: 6,
    });
    expect(cov.unknownShare).toBe(1);
    expect(cov.nodesWithoutData).toBe(1);
    expect(gameWeightedCoverageUsable(cov)).toBe(false);
  });

  it('mixed warm/cold: only the cold branch degrades', () => {
    // b3 warm-or-cold decides the e5 line's fate; b1 is warm either way.
    const withB3 = new Map(NODES);
    withB3.set('b3', {
      isUserTurn: false,
      moves: [{ san: 'Nc6', uci: 'b8c6', childFenKey: 'w5' }],
    });
    const cov = computeGameWeightedCoverage({
      rootFenKey: 'w0',
      nodes: withB3,
      getEntry: (k) => (k === 'b1' ? ENTRIES.get('b1')! : null),
      maxDepthPlies: 8,
    });
    expect(cov.unknownShare).toBeCloseTo(0.6, 5); // the e5 mass parked at cold b3
    expect(cov.uncoveredShare).toBeCloseTo(0.4, 5);
    expect(gameWeightedCoverageUsable(cov)).toBe(false); // 60% unknown is too much
  });

  it('usable when unknown mass is small', () => {
    expect(
      gameWeightedCoverageUsable({
        coveredShare: 0.7,
        uncoveredShare: 0.2,
        unknownShare: 0.1,
        nodesWithData: 5,
        nodesWithoutData: 1,
      }),
    ).toBe(true);
  });
});
