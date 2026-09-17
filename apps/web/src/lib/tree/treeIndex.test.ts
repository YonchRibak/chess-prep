/**
 * Tree-browsing primitives (S4 extraction from the editor). What matters:
 * the breadcrumb through a transposition prefers the main-line ancestor
 * (the same jump must always show the same path), `flattenTree` emits
 * variations in sibling order with balanced parentheses, and dropped edges
 * are still emitted — browsing shows the tree, drilling filters it.
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { fenKey, STARTING_FEN } from '@chess-prep/shared';
import type { RepertoireFull, RepertoireMove, RepertoirePosition } from '../../api/client.ts';
import { buildTreeIndices, computePathToFenKey, flattenTree, sortSiblings } from './treeIndex.ts';

let nextId = 0;
function pos(fullFen: string): RepertoirePosition {
  return { id: `p${nextId++}`, fenKey: fenKey(fullFen) as string, fullFen };
}
function move(
  parent: RepertoirePosition,
  child: RepertoirePosition,
  san: string,
  flags: Partial<RepertoireMove> = {},
): RepertoireMove {
  const c = new Chess(parent.fullFen);
  const m = c.move(san);
  return {
    id: `m${nextId++}`,
    parentPositionId: parent.id,
    childPositionId: child.id,
    parentFenKey: parent.fenKey,
    childFenKey: child.fenKey,
    san,
    uci: m.from + m.to,
    comment: null,
    annotation: null,
    isMainLine: false,
    priority: 0,
    isDropped: false,
    lineTags: [],
    isRefutation: false,
    origin: 'user',
    ...flags,
  };
}
function after(sans: string[]): string {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
}
function rep(positions: RepertoirePosition[], moves: RepertoireMove[]): RepertoireFull {
  return {
    id: 'r',
    name: 'r',
    color: 'white',
    tags: [],
    drillRules: {},
    autoExpand: false,
    source: null,
    rootFenKey: positions[0]!.fenKey,
    rootFullFen: positions[0]!.fullFen,
    createdAt: '',
    updatedAt: '',
    positions,
    moves,
  };
}

describe('computePathToFenKey', () => {
  it('walks back through the main-line incoming edge of a transposition', () => {
    nextId = 0;
    const root = pos(STARTING_FEN);
    const a1 = pos(after(['Nf3']));
    const a2 = pos(after(['Nf3', 'Nf6']));
    const b1 = pos(after(['Nc3']));
    const b2 = pos(after(['Nc3', 'Nf6']));
    const conv = pos(after(['Nf3', 'Nf6', 'Nc3']));
    // conv is reached by 1.Nf3 Nf6 2.Nc3 (main) and 1.Nc3 Nf6 2.Nf3 (variation).
    const r = rep(
      [root, a1, a2, b1, b2, conv],
      [
        move(root, a1, 'Nf3', { isMainLine: true }),
        move(a1, a2, 'Nf6', { isMainLine: true }),
        move(a2, conv, 'Nc3', { isMainLine: true }),
        move(root, b1, 'Nc3'),
        move(b1, b2, 'Nf6'),
        move(b2, conv, 'Nf3'),
      ],
    );
    const path = computePathToFenKey(r, buildTreeIndices(r), conv.fenKey);
    expect(path.map((m) => m.san)).toEqual(['Nf3', 'Nf6', 'Nc3']);
  });

  it('is empty at the root and stops at an unknown key', () => {
    nextId = 0;
    const root = pos(STARTING_FEN);
    const r = rep([root], []);
    const idx = buildTreeIndices(r);
    expect(computePathToFenKey(r, idx, root.fenKey)).toEqual([]);
    expect(computePathToFenKey(r, idx, 'nope')).toEqual([]);
  });
});

describe('flattenTree', () => {
  it('emits the main move, then each sibling in parentheses, dropped edges included', () => {
    nextId = 0;
    const root = pos(STARTING_FEN);
    const e4 = pos(after(['e4']));
    const c5 = pos(after(['e4', 'c5']));
    const e5 = pos(after(['e4', 'e5']));
    const d4 = pos(after(['d4']));
    const r = rep(
      [root, e4, c5, e5, d4],
      [
        move(root, e4, 'e4', { isMainLine: true }),
        move(root, d4, 'd4', { isDropped: true }),
        move(e4, c5, 'c5', { isMainLine: true }),
        move(e4, e5, 'e5', { priority: 1 }),
      ],
    );
    const tokens = flattenTree(r, buildTreeIndices(r));
    const text = tokens
      .map((t) => (t.kind === 'move' ? (t.needsNumberLabel ? `${t.fullMoveNumber}${t.isWhite ? '.' : '...'}` : '') + t.move!.san : t.kind === 'open-var' ? '(' : ')'))
      .join(' ');
    // The black move after a variation block keeps pair-flow (no `1...`)
    // — the editor's long-standing rendering, preserved by the extraction.
    expect(text).toBe('1.e4 ( 1.d4 ) c5 ( 1...e5 )');
    const opens = tokens.filter((t) => t.kind === 'open-var').length;
    const closes = tokens.filter((t) => t.kind === 'close-var').length;
    expect(opens).toBe(closes);
  });

  it('sortSiblings: main line first, then priority, then SAN', () => {
    nextId = 0;
    const root = pos(STARTING_FEN);
    const a = pos(after(['a3']));
    const b = pos(after(['b3']));
    const c = pos(after(['c3']));
    const ms = [
      move(root, c, 'c3', { priority: 2 }),
      move(root, b, 'b3', { priority: 1 }),
      move(root, a, 'a3', { isMainLine: true, priority: 9 }),
    ];
    expect(sortSiblings(ms).map((m) => m.san)).toEqual(['a3', 'b3', 'c3']);
  });
});
