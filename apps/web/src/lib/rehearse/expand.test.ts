import { describe, expect, it } from 'vitest';
import type { ExplorerEntry } from '@chess-prep/shared';
import { buildIndices } from '../walker/walker.ts';
import { collectExpandTargets, pickDeviationSource, uncoveredReplies } from './expand.ts';
import { makeTestRepertoire, moveBySan } from './testTree.ts';

function rep() {
  return makeTestRepertoire('white', [
    { sans: ['e4', 'c5', 'Nf3', 'd6', 'd4'], tags: ['Sicilian'] },
    { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'], tags: ['Open'] },
  ]);
}

describe('collectExpandTargets', () => {
  it('lists opponent-turn positions shallow-first, leaves included', () => {
    const r = rep();
    const t = collectExpandTargets(r, buildIndices(r));
    expect(t.map((x) => x.pathSans.join(' '))).toEqual([
      'e4',
      'e4 c5 Nf3',
      'e4 e5 Nf3',
      'e4 c5 Nf3 d6 d4',
      'e4 e5 Nf3 Nc6 Bb5',
    ]);
    expect(t[0]!.existing.map((m) => m.san).sort()).toEqual(['c5', 'e5']);
  });

  it('keeps only positions reached through the chapter’s edges', () => {
    const r = rep();
    const t = collectExpandTargets(r, buildIndices(r), 'Open');
    expect(t.map((x) => x.pathSans.join(' '))).toEqual(['e4', 'e4 e5 Nf3', 'e4 e5 Nf3 Nc6 Bb5']);
  });

  it('does not descend into dropped branches', () => {
    const r = rep();
    moveBySan(r, 'e5', ['e4']).isDropped = true;
    const t = collectExpandTargets(r, buildIndices(r));
    expect(t.some((x) => x.pathSans.includes('e5'))).toBe(false);
  });
});

describe('uncoveredReplies', () => {
  it('removes live, dropped and shadow SANs alike', () => {
    const r = rep();
    const e4 = moveBySan(r, 'e4');
    const idx = buildIndices(r);
    const existing = idx.allMovesByParent.get(e4.childPositionId)!;
    existing.push({ ...moveBySan(r, 'c5', ['e4']), id: 'shadow', san: 'a6', isRefutation: true });
    existing.push({ ...moveBySan(r, 'c5', ['e4']), id: 'dropped', san: 'd5', isDropped: true });
    const cands = ['c5', 'e5', 'e6', 'a6', 'd5', 'c6'].map((san) => ({ san, uci: '', share: 0.1, games: 10, score: null }));
    expect(uncoveredReplies(cands, existing).map((c) => c.san)).toEqual(['e6', 'c6']);
  });
});

describe('pickDeviationSource', () => {
  const entry: ExplorerEntry = {
    fenKey: 'x',
    total: 1000,
    moves: [
      { san: 'c5', uci: 'c7c5', white: 300, draws: 100, black: 200 },
      { san: 'e5', uci: 'e7e5', white: 200, draws: 50, black: 150 },
    ],
  } as unknown as ExplorerEntry;

  it('prefers the explorer when it has data', () => {
    const r = pickDeviationSource({ explorer: entry, sideToMove: 'b', engine: [{ san: 'd5', uci: 'd7d5' }], book: [] });
    expect(r.source).toBe('explorer');
    expect(r.replies.map((x) => x.san)).toEqual(['c5', 'e5']);
  });

  it('falls back to engine lines, then the book, then nothing — never blocking on a cold explorer', () => {
    const engine = pickDeviationSource({ explorer: null, sideToMove: 'b', engine: [{ san: 'd5', uci: 'd7d5', cp: -20 }], book: [] });
    expect(engine).toMatchObject({ source: 'engine', replies: [{ san: 'd5', share: 0 }] });
    const book = pickDeviationSource({
      explorer: null,
      sideToMove: 'b',
      engine: [],
      book: [{ san: 'c6', fenKey: 'y', opening: null } as never],
    });
    expect(book.source).toBe('book');
    expect(book.replies[0]!.san).toBe('c6');
    expect(pickDeviationSource({ explorer: null, sideToMove: 'b', engine: [], book: [] })).toEqual({
      replies: [],
      source: 'none',
    });
  });
});
