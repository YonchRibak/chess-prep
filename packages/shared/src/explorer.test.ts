import { describe, expect, it } from 'vitest';
import {
  moveScore,
  rankUserCandidates,
  selectOpponentReplies,
  type ExplorerEntry,
  type ExplorerMoveStat,
} from './explorer.js';

function stat(san: string, white: number, draws: number, black: number): ExplorerMoveStat {
  return { san, uci: `uci-${san}`, white, draws, black };
}

function entry(moves: ExplorerMoveStat[], total?: number): ExplorerEntry {
  const sum = moves.reduce((n, m) => n + m.white + m.draws + m.black, 0);
  return {
    fenKey: 'k',
    source: 'lichess:test',
    total: total ?? sum,
    moves,
    fetchedAt: '2026-08-20T00:00:00Z',
  };
}

describe('moveScore', () => {
  it('counts a draw as half a point, from the mover’s side', () => {
    const m = stat('e4', 60, 20, 20); // 100 games
    expect(moveScore(m, 'w')).toBeCloseTo(0.7);
    expect(moveScore(m, 'b')).toBeCloseTo(0.3);
  });

  it('returns null under the minimum sample, rather than a meaningless 100%', () => {
    expect(moveScore(stat('e4', 3, 0, 0), 'w')).toBeNull();
  });
});

describe('selectOpponentReplies', () => {
  it('takes the most-played moves until the cumulative share is covered', () => {
    // 60 / 25 / 10 / 5 out of 100 games.
    const e = entry([
      stat('c5', 30, 15, 15),
      stat('e5', 12, 8, 5),
      stat('e6', 5, 3, 2),
      stat('c6', 2, 2, 1),
    ]);
    const out = selectOpponentReplies(e, 'b');
    // c5 (0.60) + e5 (0.25) = 0.85 ≥ 0.80 → stops there.
    expect(out.map((m) => m.san)).toEqual(['c5', 'e5']);
    expect(out[0]!.share).toBeCloseTo(0.6);
  });

  it('never returns more than the cap, however flat the distribution', () => {
    const e = entry([
      stat('a', 10, 0, 10),
      stat('b', 10, 0, 10),
      stat('c', 10, 0, 10),
      stat('d', 10, 0, 10),
      stat('e', 10, 0, 10),
    ]);
    // The cap is what stops auto-expansion from exploding the frontier.
    expect(selectOpponentReplies(e, 'b')).toHaveLength(3);
  });

  it('drops moves below the minimum share even when the budget is unspent', () => {
    const e = entry([stat('c5', 45, 0, 45), stat('h6', 2, 0, 2), stat('a6', 3, 0, 3)]);
    expect(selectOpponentReplies(e, 'b').map((m) => m.san)).toEqual(['c5']);
  });

  it('returns nothing for a cold or too-thin entry, so the caller falls back to the book', () => {
    expect(selectOpponentReplies(null, 'b')).toEqual([]);
    expect(selectOpponentReplies(entry([stat('c5', 3, 0, 2)]), 'b')).toEqual([]);
  });

  it('is deterministic when two moves are equally popular', () => {
    const e = entry([stat('e5', 25, 0, 25), stat('c5', 25, 0, 25)]);
    expect(selectOpponentReplies(e, 'b').map((m) => m.san)).toEqual(['c5', 'e5']);
  });
});

describe('rankUserCandidates', () => {
  const lines = [
    { san: 'Nf3', uci: 'g1f3', cp: 30 },
    { san: 'd4', uci: 'd2d4', cp: 25 },
    { san: 'Bc4', uci: 'f1c4', cp: 20 },
  ];

  it('promotes the more popular move among engine-equivalent ones', () => {
    const e = entry([
      { san: 'd4', uci: 'd2d4', white: 60, draws: 0, black: 40 },
      { san: 'Nf3', uci: 'g1f3', white: 5, draws: 0, black: 5 },
    ]);
    expect(rankUserCandidates(lines, e, 'w').map((c) => c.san)).toEqual(['d4', 'Nf3', 'Bc4']);
  });

  it('never promotes a popular move the engine considers bad', () => {
    const withBlunder = [
      { san: 'Nf3', uci: 'g1f3', cp: 30 },
      { san: 'h4', uci: 'h2h4', cp: -200 }, // way outside the loss budget
    ];
    const e = entry([{ san: 'h4', uci: 'h2h4', white: 90, draws: 0, black: 10 }]);
    expect(rankUserCandidates(withBlunder, e, 'w').map((c) => c.san)).toEqual(['Nf3']);
  });

  it('falls back to plain engine order with no explorer data (the offline path)', () => {
    const out = rankUserCandidates(lines, null, 'w');
    expect(out.map((c) => c.san)).toEqual(['Nf3', 'd4', 'Bc4']);
    expect(out.every((c) => c.share === null)).toBe(true);
  });

  it('keeps the engine rank so the UI can say "engine’s #2"', () => {
    const e = entry([{ san: 'd4', uci: 'd2d4', white: 60, draws: 0, black: 40 }]);
    const out = rankUserCandidates(lines, e, 'w');
    expect(out[0]).toMatchObject({ san: 'd4', engineRank: 2 });
  });

  it('respects the limit', () => {
    expect(rankUserCandidates(lines, null, 'w', { limit: 2 })).toHaveLength(2);
  });

  it('keeps a mate line and discards non-mating alternatives', () => {
    const mateLines = [
      { san: 'Qh7#', uci: 'd3h7', mate: 1 },
      { san: 'Qd8', uci: 'd3d8', cp: 400 },
    ];
    expect(rankUserCandidates(mateLines, null, 'w').map((c) => c.san)).toEqual(['Qh7#']);
  });
});
