import { describe, expect, it } from 'vitest';
import {
  findInterference,
  rankMistakes,
  type DrillAttemptDto,
  type PrepRef,
} from './attempts.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function attempt(
  moveId: string,
  wasCorrect: boolean,
  daysAgo: number,
  playedSan = 'Nf3',
): DrillAttemptDto {
  return {
    id: `${moveId}-${daysAgo}-${wasCorrect}`,
    moveId,
    repertoireId: 'rep',
    playedSan,
    wasCorrect,
    at: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  };
}

describe('rankMistakes', () => {
  it('ranks a recent miss above an older one', () => {
    const ranked = rankMistakes([attempt('old', false, 10), attempt('fresh', false, 1)], {
      now: NOW,
    });
    expect(ranked.map((m) => m.moveId)).toEqual(['fresh', 'old']);
  });

  it('ignores misses outside the window', () => {
    const ranked = rankMistakes([attempt('ancient', false, 40)], { now: NOW });
    expect(ranked).toEqual([]);
  });

  it('never ranks a move that was only answered correctly', () => {
    const ranked = rankMistakes([attempt('clean', true, 1), attempt('clean', true, 2)], {
      now: NOW,
    });
    expect(ranked).toEqual([]);
  });

  // The payback rule is what stops the mode from becoming a permanent hall of
  // shame: a move missed once and since repaired must fall behind a fresh miss.
  it('lets subsequent correct answers demote a repaired mistake', () => {
    const repaired = [
      attempt('repaired', false, 6),
      attempt('repaired', true, 3),
      attempt('repaired', true, 1),
    ];
    const ranked = rankMistakes([...repaired, attempt('fresh', false, 2)], { now: NOW });
    expect(ranked.map((m) => m.moveId)).toEqual(['fresh', 'repaired']);
    expect(ranked.find((m) => m.moveId === 'repaired')!.score).toBeGreaterThanOrEqual(0);
  });

  it('reports miss count and last miss time inside the window', () => {
    const ranked = rankMistakes([attempt('m', false, 5), attempt('m', false, 2)], { now: NOW });
    expect(ranked[0]!.misses).toBe(2);
    expect(ranked[0]!.lastMissAt).toBe(new Date(NOW.getTime() - 2 * DAY).toISOString());
  });

  it('tolerates unparseable and future timestamps', () => {
    const junk: DrillAttemptDto[] = [
      { ...attempt('a', false, 1), at: 'not-a-date' },
      { ...attempt('b', false, 1), at: new Date(NOW.getTime() + DAY).toISOString() },
    ];
    expect(rankMistakes(junk, { now: NOW })).toEqual([]);
  });
});

describe('findInterference', () => {
  const preps: PrepRef[] = [
    { moveId: 'here', parentPositionId: 'p1', san: 'Bd3' },
    { moveId: 'elsewhere', parentPositionId: 'p2', san: 'Nf3' },
    { moveId: 'third', parentPositionId: 'p3', san: 'Nf3' },
  ];

  it('finds the same SAN prepped at a different position', () => {
    expect(findInterference('Nf3', 'p1', preps).map((h) => h.moveId)).toEqual([
      'elsewhere',
      'third',
    ]);
  });

  it('never reports the current position itself', () => {
    expect(findInterference('Nf3', 'p2', preps).map((h) => h.moveId)).toEqual(['third']);
  });

  it('returns nothing for a SAN that is not prepped anywhere', () => {
    expect(findInterference('Qh5', 'p1', preps)).toEqual([]);
  });

  it('returns nothing for an empty SAN', () => {
    expect(findInterference('  ', 'p1', preps)).toEqual([]);
  });
});
