/**
 * Flow F1: line-navigator aggregation.
 *
 * The load-bearing property: an entry's `dueCount` equals the length of the
 * 'due' queue its Start button launches with the same scope. Everything else
 * (nesting, tags, exclusions) mirrors the queue builders and the walker.
 */
import { describe, it, expect } from 'vitest';
import type { DrillAttemptDto, OpeningId, SrsCardDto } from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';
import { buildDrillQueue } from '../drill/queue.ts';
import { buildIndices } from '../walker/walker.ts';
import { buildLineIndex, namePrefixes } from './lineIndex.ts';

const NOW = new Date('2026-06-01T12:00:00Z');

/** 1.e4 e5 2.Nf3 main line with 1.d4 as a second branch (same as queue tests). */
function makeRep(): RepertoireFull {
  return {
    id: 'rep1',
    name: 'Test',
    color: 'white',
    tags: [],
    drillRules: {},
    autoExpand: false,
    rootFenKey: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
    rootFullFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    positions: [
      { id: 'p0', fenKey: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', fullFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
      { id: 'p1', fenKey: 'after-e4', fullFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
      { id: 'p2', fenKey: 'after-d4', fullFen: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1' },
      { id: 'p3', fenKey: 'after-e5', fullFen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
      { id: 'p4', fenKey: 'after-Nf3', fullFen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
    ],
    moves: [
      { id: 'm-e4', parentPositionId: 'p0', childPositionId: 'p1', parentFenKey: 'r0', childFenKey: 'r1', san: 'e4', uci: 'e2e4', comment: null, annotation: null, isMainLine: true, priority: 0, isDropped: false, lineTags: [], isRefutation: false },
      { id: 'm-d4', parentPositionId: 'p0', childPositionId: 'p2', parentFenKey: 'r0', childFenKey: 'r2', san: 'd4', uci: 'd2d4', comment: null, annotation: null, isMainLine: false, priority: 0, isDropped: false, lineTags: [], isRefutation: false },
      { id: 'm-e5', parentPositionId: 'p1', childPositionId: 'p3', parentFenKey: 'r1', childFenKey: 'r3', san: 'e5', uci: 'e7e5', comment: null, annotation: null, isMainLine: true, priority: 0, isDropped: false, lineTags: [], isRefutation: false },
      { id: 'm-Nf3', parentPositionId: 'p3', childPositionId: 'p4', parentFenKey: 'r3', childFenKey: 'r4', san: 'Nf3', uci: 'g1f3', comment: null, annotation: null, isMainLine: true, priority: 0, isDropped: false, lineTags: [], isRefutation: false },
    ],
  };
}

function makeCard(moveId: string, dueOffsetSec: number, extra: Partial<SrsCardDto> = {}): SrsCardDto {
  return {
    id: `card-${moveId}`,
    moveId,
    due: new Date(NOW.getTime() + dueOffsetSec * 1000).toISOString(),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    lastReview: null,
    updatedAt: NOW.toISOString(),
    ...extra,
  };
}

/** after-e4 is the King's Pawn Game; after-Nf3 deepens into a variation. */
const NAMES = new Map<string, OpeningId>([
  ['after-e4', { eco: 'B00', name: "King's Pawn Game", variation: null }],
  ['after-Nf3', { eco: 'C40', name: "King's Pawn Game", variation: "King's Knight Variation" }],
]);
const lookup = (k: string) => NAMES.get(k) ?? null;

function index(rep: RepertoireFull, cards: SrsCardDto[], attempts: DrillAttemptDto[] = []) {
  return buildLineIndex({
    repertoire: rep,
    indices: buildIndices(rep),
    openingLookup: lookup,
    cards,
    attempts,
    now: NOW,
  });
}

describe('buildLineIndex', () => {
  const allCards = () => [makeCard('m-e4', -60), makeCard('m-d4', -60), makeCard('m-Nf3', +3600)];

  it('puts "All lines" first, counting everything the un-scoped queues see', () => {
    const entries = index(makeRep(), allCards());
    const all = entries[0]!;
    expect(all.scope).toEqual({ kind: 'all' });
    expect(all.cardCount).toBe(3);
    expect(all.dueCount).toBe(2); // Nf3's card is in the future
    // p2 (after 1.d4) and p4 (after 2.Nf3) have no continuations yet.
    expect(all.toBuild).toBe(2);
  });

  it('nests name entries by boundary prefix and aggregates counts upward', () => {
    const entries = index(makeRep(), allCards());
    const names = entries.filter((e) => e.scope.kind === 'openingName');
    expect(names.map((e) => [e.label, e.depth])).toEqual([
      ["King's Pawn Game", 0],
      ["King's Knight Variation", 1],
    ]);
    const [kpg, kkv] = names;
    // The parent catches its variation's cards (boundary prefix matching).
    expect(kpg!.cardCount).toBe(2); // e4 + Nf3; d4 never enters the line
    expect(kkv!.cardCount).toBe(1); // Nf3 only
    // Attention node p4 sits inside the variation; p2 is outside both.
    expect(kpg!.toBuild).toBe(1);
    expect(kkv!.toBuild).toBe(1);
  });

  it('adds one entry per distinct tag on live edges', () => {
    const rep = makeRep();
    rep.moves = rep.moves.map((m) => (m.id === 'm-d4' ? { ...m, lineTags: ['vs-danny'] } : m));
    const entries = index(rep, allCards());
    const tags = entries.filter((e) => e.scope.kind === 'tag');
    expect(tags.map((e) => e.label)).toEqual(['vs-danny']);
    expect(tags[0]!.cardCount).toBe(1);
    expect(tags[0]!.dueCount).toBe(1);
    // The tagged branch's leaf (p2) is its build TODO.
    expect(tags[0]!.toBuild).toBe(1);
  });

  it('dropped branches contribute nothing anywhere', () => {
    const rep = makeRep();
    rep.moves = rep.moves.map((m) => (m.id === 'm-d4' ? { ...m, isDropped: true } : m));
    const entries = index(rep, allCards());
    const all = entries[0]!;
    expect(all.cardCount).toBe(2); // d4's card is gone
    expect(all.toBuild).toBe(1); // p2 is no longer reachable
  });

  it('refutation shadow edges contribute nothing, even with a card', () => {
    const rep = makeRep();
    rep.moves.push({
      id: 'm-shadow', parentPositionId: 'p3', childPositionId: 'p4',
      parentFenKey: 'r3', childFenKey: 'r4', san: 'Qh5', uci: 'd1h5',
      comment: null, annotation: null, isMainLine: false, priority: 0,
      isDropped: false, lineTags: ['shadow-tag'], isRefutation: true,
    });
    const entries = index(rep, [...allCards(), makeCard('m-shadow', -999)]);
    expect(entries[0]!.cardCount).toBe(3);
    // A tag that exists only on a shadow edge is not a line.
    expect(entries.filter((e) => e.scope.kind === 'tag')).toEqual([]);
  });

  it('counts recent misses per line from the attempt log', () => {
    const attempts: DrillAttemptDto[] = [
      {
        id: 'a1', moveId: 'm-Nf3', repertoireId: 'rep1', playedSan: 'Qh5',
        wasCorrect: false, at: new Date(NOW.getTime() - 60_000).toISOString(),
      },
    ];
    const entries = index(makeRep(), allCards(), attempts);
    const byLabel = new Map(entries.map((e) => [e.label, e]));
    expect(byLabel.get('All lines')!.recentMisses).toBe(1);
    expect(byLabel.get("King's Pawn Game")!.recentMisses).toBe(1);
    expect(byLabel.get("King's Knight Variation")!.recentMisses).toBe(1);
  });

  // THE property the navigator exists to keep: the badge is the session.
  it('dueCount equals the length of the due queue each entry launches', () => {
    const rep = makeRep();
    rep.moves = rep.moves.map((m) => (m.id === 'm-d4' ? { ...m, lineTags: ['vs-danny'] } : m));
    const cards = allCards();
    const entries = index(rep, cards);
    expect(entries.length).toBeGreaterThan(2);
    for (const e of entries) {
      const queue = buildDrillQueue({
        repertoire: rep,
        cards,
        mode: 'due',
        rules: { ...rep.drillRules, scope: e.scope },
        now: NOW,
        openingLookup: lookup,
      });
      expect(e.dueCount, `entry ${e.label}`).toBe(queue.length);
    }
  });

  it("respects the stored rules' depth filter, since launched sessions will too", () => {
    const rep = makeRep();
    rep.drillRules = { maxDepth: 1 };
    const entries = index(rep, allCards());
    // Nf3 (depth 2) is beyond maxDepth for any session from this repertoire.
    expect(entries[0]!.cardCount).toBe(2);
  });
});

describe('namePrefixes', () => {
  it('splits at name boundaries only', () => {
    expect(namePrefixes('Caro-Kann Defense: Advance Variation, Botvinnik-Carls Defense')).toEqual([
      'Caro-Kann Defense',
      'Caro-Kann Defense: Advance Variation',
      'Caro-Kann Defense: Advance Variation, Botvinnik-Carls Defense',
    ]);
    expect(namePrefixes('French Defense')).toEqual(['French Defense']);
  });
});
