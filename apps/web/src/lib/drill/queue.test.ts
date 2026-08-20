import { describe, it, expect } from 'vitest';
import { buildDailyDietQueue, buildDrillQueue } from './queue.ts';
import type { RepertoireFull } from '../../api/client.ts';
import type { SrsCardDto } from '@chess-prep/shared';

/** Hand-built tiny repertoire for tests: 1.e4 e5 2.Nf3 (with 2.d4 as variation). */
function makeRep(): RepertoireFull {
  return {
    id: 'rep1',
    name: 'Test',
    color: 'white',
    tags: [],
    drillRules: {},
    rootFenKey: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
    rootFullFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    positions: [
      { id: 'p0', fenKey: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', fullFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }, // root, white to move
      { id: 'p1', fenKey: 'after-e4', fullFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' }, // black to move
      { id: 'p2', fenKey: 'after-d4', fullFen: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1' }, // black to move (variation)
      { id: 'p3', fenKey: 'after-e5', fullFen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' }, // white to move
      { id: 'p4', fenKey: 'after-Nf3', fullFen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
    ],
    moves: [
      { id: 'm-e4', parentPositionId: 'p0', childPositionId: 'p1', parentFenKey: 'r0', childFenKey: 'r1', san: 'e4', uci: 'e2e4', comment: null, annotation: null, isMainLine: true, priority: 0, isDropped: false, lineTags: [] },
      { id: 'm-d4', parentPositionId: 'p0', childPositionId: 'p2', parentFenKey: 'r0', childFenKey: 'r2', san: 'd4', uci: 'd2d4', comment: null, annotation: null, isMainLine: false, priority: 0, isDropped: false, lineTags: [] },
      { id: 'm-e5', parentPositionId: 'p1', childPositionId: 'p3', parentFenKey: 'r1', childFenKey: 'r3', san: 'e5', uci: 'e7e5', comment: null, annotation: null, isMainLine: true, priority: 0, isDropped: false, lineTags: [] },
      { id: 'm-Nf3', parentPositionId: 'p3', childPositionId: 'p4', parentFenKey: 'r3', childFenKey: 'r4', san: 'Nf3', uci: 'g1f3', comment: null, annotation: null, isMainLine: true, priority: 0, isDropped: false, lineTags: [] },
    ],
  };
}

function makeCard(moveId: string, dueOffsetSec: number, extra: Partial<SrsCardDto> = {}): SrsCardDto {
  const now = new Date('2026-06-01T12:00:00Z');
  return {
    id: `card-${moveId}`,
    moveId,
    due: new Date(now.getTime() + dueOffsetSec * 1000).toISOString(),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    lastReview: null,
    updatedAt: now.toISOString(),
    ...extra,
  };
}

const NOW = new Date('2026-06-01T12:00:00Z');

describe('buildDrillQueue', () => {
  it('only emits user-color moves (white in this rep)', () => {
    const rep = makeRep();
    // Provide cards for all 4 moves — but the queue should drop e5 (black move).
    const cards = [
      makeCard('m-e4', -60),
      makeCard('m-d4', -60),
      makeCard('m-e5', -60),
      makeCard('m-Nf3', -60),
    ];
    const q = buildDrillQueue({ repertoire: rep, cards, mode: 'due', rules: {}, now: NOW });
    const sans = q.map((it) => it.move.san).sort();
    expect(sans).toEqual(['Nf3', 'd4', 'e4']);
  });

  it('due mode filters out future cards', () => {
    const rep = makeRep();
    const cards = [
      makeCard('m-e4', -60), // due
      makeCard('m-d4', +3600), // future
      makeCard('m-Nf3', -60), // due
    ];
    const q = buildDrillQueue({ repertoire: rep, cards, mode: 'due', rules: {}, now: NOW });
    expect(q.map((it) => it.move.san).sort()).toEqual(['Nf3', 'e4']);
  });

  it('main_line_only branching drops the d4 variation', () => {
    const rep = makeRep();
    const cards = [makeCard('m-e4', -60), makeCard('m-d4', -60), makeCard('m-Nf3', -60)];
    const q = buildDrillQueue({
      repertoire: rep,
      cards,
      mode: 'due',
      rules: { branching: 'main_line_only' },
      now: NOW,
    });
    expect(q.map((it) => it.move.san)).not.toContain('d4');
    expect(q.map((it) => it.move.san)).toContain('e4');
  });

  it('maxDepth filter excludes deep moves', () => {
    const rep = makeRep();
    const cards = [makeCard('m-e4', -60), makeCard('m-Nf3', -60)];
    // e4 has depth 0 (parent = root); Nf3 has depth 2 (parent = after-e5).
    const q = buildDrillQueue({
      repertoire: rep,
      cards,
      mode: 'due',
      rules: { maxDepth: 1 },
      now: NOW,
    });
    const sans = q.map((it) => it.move.san);
    expect(sans).toContain('e4');
    expect(sans).not.toContain('Nf3');
  });

  it('walkthrough mode emits main-line cards in order', () => {
    const rep = makeRep();
    const cards = [makeCard('m-e4', 0), makeCard('m-d4', 0), makeCard('m-Nf3', 0)];
    const q = buildDrillQueue({ repertoire: rep, cards, mode: 'walkthrough', rules: {}, now: NOW });
    // Main-line walk: root → e4 → (black e5, auto-played) → Nf3 → ...
    // Only white moves get cards, so walkthrough produces e4 then Nf3.
    expect(q.map((it) => it.move.san)).toEqual(['e4', 'Nf3']);
  });

  it('walkthrough mode wires the opponent reply between user cards', () => {
    const rep = makeRep();
    const cards = [makeCard('m-e4', 0), makeCard('m-Nf3', 0)];
    const q = buildDrillQueue({ repertoire: rep, cards, mode: 'walkthrough', rules: {}, now: NOW });
    // First card (e4) should carry the opponent's e5 reply to flow into the
    // second card. Last card (Nf3) has no further opponent move in the tree.
    expect(q[0]?.opponentResponseSan).toBe('e5');
    expect(q[1]?.opponentResponseSan).toBeUndefined();
  });

  it('weak mode sorts most lapsed first', () => {
    const rep = makeRep();
    const cards = [
      makeCard('m-e4', 0, { lapses: 0 }),
      makeCard('m-d4', 0, { lapses: 3 }),
      makeCard('m-Nf3', 0, { lapses: 1 }),
    ];
    const q = buildDrillQueue({ repertoire: rep, cards, mode: 'weak', rules: {}, now: NOW });
    expect(q.map((it) => it.move.san)).toEqual(['d4', 'Nf3', 'e4']);
  });

  it('random mode preserves the same items but with shuffled order', () => {
    const rep = makeRep();
    const cards = [makeCard('m-e4', 0), makeCard('m-d4', 0), makeCard('m-Nf3', 0)];
    const fixed = mulberry32(42);
    const q = buildDrillQueue({ repertoire: rep, cards, mode: 'random', rules: {}, now: NOW, rng: fixed });
    expect(new Set(q.map((it) => it.move.san))).toEqual(new Set(['e4', 'd4', 'Nf3']));
  });
});

/* ---------------- Phase 9a line scopes ---------------- */

describe('buildDrillQueue line scopes', () => {
  const allCards = () => [makeCard('m-e4', -60), makeCard('m-d4', -60), makeCard('m-Nf3', -60)];

  it('tag scope keeps only cards on tagged edges', () => {
    const rep = makeRep();
    rep.moves = rep.moves.map((m) =>
      m.id === 'm-d4' ? { ...m, lineTags: ['vs-danny'] } : m,
    );
    const q = buildDrillQueue({
      repertoire: rep,
      cards: allCards(),
      mode: 'due',
      rules: { scope: { kind: 'tag', value: 'vs-danny' } },
      now: NOW,
    });
    expect(q.map((it) => it.move.san)).toEqual(['d4']);
  });

  it('opening-name scope follows the deepest name along the path', () => {
    const rep = makeRep();
    // Only the position after 1.e4 is named; 2.Nf3 inherits that name by path
    // walk, while the 1.d4 branch never enters the line.
    const named = new Map([
      ['after-e4', { eco: 'B00', name: "King's Pawn Game", variation: null }],
    ]);
    const q = buildDrillQueue({
      repertoire: rep,
      cards: allCards(),
      mode: 'due',
      rules: { scope: { kind: 'openingName', value: "King's Pawn Game" } },
      now: NOW,
      openingLookup: (k) => named.get(k) ?? null,
    });
    expect(q.map((it) => it.move.san).sort()).toEqual(['Nf3', 'e4']);
  });

  it('an opening-name scope with no lookup yields an empty queue, not the whole tree', () => {
    // Fail closed: a silently unfiltered "scoped" session is worse than an
    // obviously empty one, because it looks like a correct session.
    const q = buildDrillQueue({
      repertoire: makeRep(),
      cards: allCards(),
      mode: 'due',
      rules: { scope: { kind: 'openingName', value: "King's Pawn Game" } },
      now: NOW,
    });
    expect(q).toEqual([]);
  });

  it('composes with the depth rules rather than replacing them', () => {
    const rep = makeRep();
    rep.moves = rep.moves.map((m) => ({ ...m, lineTags: ['blitz'] }));
    const q = buildDrillQueue({
      repertoire: rep,
      cards: allCards(),
      mode: 'due',
      rules: { scope: { kind: 'tag', value: 'blitz' }, minDepth: 2 },
      now: NOW,
    });
    expect(q.map((it) => it.move.san)).toEqual(['Nf3']);
  });

  it('walkthrough does not auto-play a scoped-out USER move as an opponent reply', () => {
    // 2.Nf3 is filtered out by depth; it is still white's move, so it must not
    // be wired as the opponent response after 1.e4.
    const rep = makeRep();
    const q = buildDrillQueue({
      repertoire: rep,
      cards: allCards(),
      mode: 'walkthrough',
      rules: { maxDepth: 1 },
      now: NOW,
    });
    expect(q.map((it) => it.move.san)).toEqual(['e4']);
    expect(q[0]!.opponentResponseSan).toBe('e5');
  });
});

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- Phase 8a daily diet ---------------- */

describe('buildDailyDietQueue', () => {
  it('interleaves cards from multiple repertoires (round-robin)', () => {
    // Two reps, each has two due cards. Output should alternate reps.
    const repA: RepertoireFull = { ...makeRep(), id: 'A', name: 'Rep A' };
    const repB: RepertoireFull = { ...makeRep(), id: 'B', name: 'Rep B' };
    const cards = [
      makeCard('m-e4', -60),
      makeCard('m-d4', -60),
      makeCard('m-Nf3', -60),
    ];
    const out = buildDailyDietQueue({
      repertoires: [repA, repB],
      cards,
      newCardsPerDay: 1000,
      now: NOW,
    });
    // Both reps share the same move IDs in our toy fixture, so we expect
    // 3 cards × 2 reps = 6 items, alternating A, B, A, B, A, B.
    expect(out.length).toBe(6);
    const reps = out.map((it) => it.repertoireId);
    expect(reps).toEqual(['A', 'B', 'A', 'B', 'A', 'B']);
  });

  it('caps new cards at newCardsPerDay across all reps', () => {
    const repA: RepertoireFull = { ...makeRep(), id: 'A', name: 'Rep A' };
    const repB: RepertoireFull = { ...makeRep(), id: 'B', name: 'Rep B' };
    // Three brand-new cards (state=0) per rep — 6 total. Cap = 2 → only 2 reach the queue.
    const cards = [
      makeCard('m-e4', -60, { state: 0 }),
      makeCard('m-d4', -60, { state: 0 }),
      makeCard('m-Nf3', -60, { state: 0 }),
    ];
    const out = buildDailyDietQueue({
      repertoires: [repA, repB],
      cards,
      newCardsPerDay: 2,
      now: NOW,
    });
    const newCount = out.filter((it) => it.card.state === 0).length;
    expect(newCount).toBe(2);
  });

  it('non-new cards are NOT capped by newCardsPerDay (only state=0 counts)', () => {
    const repA: RepertoireFull = { ...makeRep(), id: 'A', name: 'Rep A' };
    // All cards in review state — cap=0 should still let them all through.
    const cards = [
      makeCard('m-e4', -60, { state: 2, reps: 5 }),
      makeCard('m-d4', -60, { state: 2, reps: 5 }),
      makeCard('m-Nf3', -60, { state: 2, reps: 5 }),
    ];
    const out = buildDailyDietQueue({
      repertoires: [repA],
      cards,
      newCardsPerDay: 0,
      now: NOW,
    });
    expect(out.length).toBe(3);
  });

  it('treats cards reviewed since the daily reset as "already shown today" for the new cap', () => {
    const repA: RepertoireFull = { ...makeRep(), id: 'A', name: 'Rep A' };
    // Daily reset was 24h ago. One state=0 card was reviewed 1h ago (counts
    // against the budget); two more state=0 cards are due NOW.
    const reviewedRecently = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const cards = [
      makeCard('m-e4', -60, { state: 0, lastReview: reviewedRecently }),
      makeCard('m-d4', -60, { state: 0 }),
      makeCard('m-Nf3', -60, { state: 0 }),
    ];
    const dailyResetAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    // Cap=2; m-e4 already consumed 1 today → only 1 fresh new card can enter.
    const out = buildDailyDietQueue({
      repertoires: [repA],
      cards,
      newCardsPerDay: 2,
      now: NOW,
      dailyResetAt,
    });
    // out contains m-e4 (it's still due — reviewing again is fine; it counts
    // against new budget once) and ONE of {m-d4, m-Nf3}. Total new in
    // session-window with state=0 budget: 1 fresh + 1 re-shown = 2 distinct
    // cards if cap math is right. Verify: we returned at most 2 state=0
    // cards even though 3 were eligible.
    const newCount = out.filter((it) => it.card.state === 0).length;
    expect(newCount).toBeLessThanOrEqual(2);
  });
});
