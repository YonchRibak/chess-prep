import { describe, expect, it } from 'vitest';
import { describeInterference, detectInterference } from './interference.ts';
import type { RepertoireFull } from '../../api/client.ts';

/**
 * Same tiny white repertoire as queue.test.ts: 1.e4 e5 2.Nf3, with 1.d4 as a
 * variation. `e4` is the user's prep at the root, so playing it at the
 * post-1.e4 e5 position is exactly the transposition mix-up this detects.
 */
function makeRep(): RepertoireFull {
  return {
    id: 'rep1',
    name: 'Test',
    color: 'white',
    tags: [],
    drillRules: {},
    autoExpand: false,
    rootFenKey: 'root',
    rootFullFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    positions: [
      { id: 'p0', fenKey: 'root', fullFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
      { id: 'p1', fenKey: 'after-e4', fullFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
      { id: 'p3', fenKey: 'after-e5', fullFen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
      { id: 'p4', fenKey: 'after-Nf3', fullFen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
    ],
    moves: [
      move('m-e4', 'p0', 'p1', 'e4'),
      move('m-e5', 'p1', 'p3', 'e5'),
      move('m-Nf3', 'p3', 'p4', 'Nf3'),
    ],
  };
}

function move(
  id: string,
  parentPositionId: string,
  childPositionId: string,
  san: string,
  extra: Partial<RepertoireFull['moves'][number]> = {},
): RepertoireFull['moves'][number] {
  return {
    id,
    parentPositionId,
    childPositionId,
    parentFenKey: parentPositionId,
    childFenKey: childPositionId,
    san,
    uci: '',
    comment: null,
    annotation: null,
    isMainLine: true,
    priority: 0,
    isDropped: false,
    lineTags: [],
    ...extra,
  };
}

describe('detectInterference', () => {
  it('names the other position where the played SAN is the user prep', () => {
    const hits = detectInterference(makeRep(), 'p3', 'e4');
    expect(hits.map((h) => h.moveId)).toEqual(['m-e4']);
    expect(hits[0]!.parentFenKey).toBe('root');
  });

  it('never reports the position the user is standing on', () => {
    expect(detectInterference(makeRep(), 'p0', 'e4')).toEqual([]);
  });

  // An opponent reply sharing the SAN is a coincidence, not a confusion —
  // calling it "your move" would train the user to distrust the hint.
  it('ignores opponent-side moves', () => {
    expect(detectInterference(makeRep(), 'p0', 'e5')).toEqual([]);
  });

  // A dropped branch is a standing "won't cover"; citing it as the user's prep
  // would be false.
  it('ignores dropped branches', () => {
    const rep = makeRep();
    rep.moves = rep.moves.map((m) => (m.id === 'm-e4' ? { ...m, isDropped: true } : m));
    expect(detectInterference(rep, 'p3', 'e4')).toEqual([]);
  });

  it('says nothing about a move that is prepped nowhere', () => {
    expect(detectInterference(makeRep(), 'p3', 'Qh5')).toEqual([]);
  });
});

describe('describeInterference', () => {
  it('falls back to a position-agnostic phrasing without an opening name', () => {
    const hits = detectInterference(makeRep(), 'p3', 'e4');
    expect(describeInterference(hits)).toBe('e4 is your prep at a different position — not here.');
  });

  it('returns null when there is nothing to say', () => {
    expect(describeInterference([])).toBeNull();
  });

  it('names the line when the book knows it', () => {
    const msg = describeInterference([
      {
        moveId: 'm',
        san: 'Bd3',
        parentPositionId: 'p9',
        parentFenKey: 'k',
        opening: { eco: 'B12', name: 'Caro-Kann Defense', variation: 'Advance Variation' },
      },
    ]);
    expect(msg).toBe('Bd3 is your prep in the Caro-Kann Defense: Advance Variation — not here.');
  });
});
