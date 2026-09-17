/**
 * Rashid R5 precompute (test seams, no engine): priority enumeration — BFS
 * depth order, hero turns only, dropped/refutation subtrees excluded,
 * transpositions once — and the run loop's accounting: cached vs computed vs
 * failed vs lit, cancellation mid-run, and the drill pause that waits
 * instead of aborting (the no-leak guarantee applied to a worker the
 * singleton's gate cannot reach).
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { fenKey, STARTING_FEN, type RashidResult } from '@chess-prep/shared';
import type { RepertoireFull, RepertoireMove, RepertoirePosition } from '../../api/client.ts';
import { heroPositionsInPriorityOrder, runRashidPrecompute } from './rashidPrecompute.ts';

/* ---------------- fixture: a tiny White repertoire ---------------- */

let nextId = 0;
function pos(fullFen: string): RepertoirePosition {
  return { id: `p${nextId++}`, fenKey: fenKey(fullFen) as string, fullFen };
}

function move(
  parent: RepertoirePosition,
  child: RepertoirePosition,
  uci: string,
  flags: Partial<Pick<RepertoireMove, 'isDropped' | 'isRefutation'>> = {},
): RepertoireMove {
  return {
    id: `m${nextId++}`,
    parentPositionId: parent.id,
    childPositionId: child.id,
    parentFenKey: parent.fenKey,
    childFenKey: child.fenKey,
    san: uci,
    uci,
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

function fenAfter(sans: string[]): string {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
}

/**
 * White repertoire:
 *   root (W) ─e4→ B ─e5→ W2 ─Nf3→ B2 ─Nc6→ W3
 *        └─d4→ Bd (dropped subtree: ─d5→ Wd)
 *   B ─h5→ Wr (refutation shadow)
 */
function fixture(): {
  rep: RepertoireFull;
  root: RepertoirePosition;
  w2: RepertoirePosition;
  w3: RepertoirePosition;
} {
  nextId = 0;
  const root = pos(STARTING_FEN);
  const b1 = pos(fenAfter(['e4']));
  const w2 = pos(fenAfter(['e4', 'e5']));
  const b2 = pos(fenAfter(['e4', 'e5', 'Nf3']));
  const w3 = pos(fenAfter(['e4', 'e5', 'Nf3', 'Nc6']));
  const bd = pos(fenAfter(['d4']));
  const wd = pos(fenAfter(['d4', 'd5']));
  const wr = pos(fenAfter(['e4', 'h5']));

  const rep = {
    id: 'rep1',
    color: 'white',
    rootFenKey: root.fenKey,
    positions: [root, b1, w2, b2, w3, bd, wd, wr],
    moves: [
      move(root, b1, 'e2e4'),
      move(b1, w2, 'e7e5'),
      move(w2, b2, 'g1f3'),
      move(b2, w3, 'b8c6'),
      move(root, bd, 'd2d4', { isDropped: true }),
      move(bd, wd, 'd7d5'),
      move(b1, wr, 'h7h5', { isRefutation: true }),
    ],
  } as unknown as RepertoireFull;
  return { rep, root, w2, w3 };
}

const LIT: RashidResult = {
  lightsUp: true,
  best: null,
  lines: [],
  bestRootScore: 0,
  candidates: [],
};
const DARK: RashidResult = { ...LIT, lightsUp: false };

describe('heroPositionsInPriorityOrder', () => {
  it('BFS depth order, hero turns only, dropped/refutation subtrees excluded', () => {
    const { rep, root, w2, w3 } = fixture();
    expect(heroPositionsInPriorityOrder(rep).map((p) => p.id)).toEqual([root.id, w2.id, w3.id]);
  });

  it('includeDropped visits hero positions under a dropped edge, never a shadow line', () => {
    const { rep, root, w2, w3 } = fixture();
    const ids = heroPositionsInPriorityOrder(rep, { includeDropped: true }).map((p) => p.id);
    // wd (after 1.d4 d5) is white-to-move under the dropped 1.d4; wr is a shadow.
    const wd = rep.positions.find((p) => p.id === 'p6')!;
    expect(ids).toEqual([root.id, w2.id, wd.id, w3.id]);
    expect(ids).not.toContain('p7');
  });

  it('analyzes a transposition once', () => {
    nextId = 0;
    // 1.Nf3 Nf6 2.Nc3 Nc6 and 1.Nc3 Nc6 2.Nf3 Nf6 converge on one
    // white-to-move position (knights only — no en-passant field noise).
    const root = pos(STARTING_FEN);
    const a1 = pos(fenAfter(['Nf3']));
    const a2 = pos(fenAfter(['Nf3', 'Nf6']));
    const a3 = pos(fenAfter(['Nf3', 'Nf6', 'Nc3']));
    const conv = pos(fenAfter(['Nf3', 'Nf6', 'Nc3', 'Nc6']));
    const b1 = pos(fenAfter(['Nc3']));
    const b2 = pos(fenAfter(['Nc3', 'Nc6']));
    const b3 = pos(fenAfter(['Nc3', 'Nc6', 'Nf3']));
    const rep = {
      id: 'rep2',
      color: 'white',
      rootFenKey: root.fenKey,
      positions: [root, a1, a2, a3, conv, b1, b2, b3],
      moves: [
        move(root, a1, 'g1f3'),
        move(a1, a2, 'g8f6'),
        move(a2, a3, 'b1c3'),
        move(a3, conv, 'b8c6'),
        move(root, b1, 'b1c3'),
        move(b1, b2, 'b8c6'),
        move(b2, b3, 'g1f3'),
        move(b3, conv, 'g8f6'),
      ],
    } as unknown as RepertoireFull;
    const ids = heroPositionsInPriorityOrder(rep).map((p) => p.id);
    expect(ids.filter((id) => id === conv.id)).toHaveLength(1);
    expect(ids).toEqual([root.id, a2.id, b2.id, conv.id]); // depth order holds through the merge
  });
});

describe('runRashidPrecompute', () => {
  it('accounts computed / cached / lit and clears current at the end', async () => {
    const { rep, w2 } = fixture();
    const calls: string[] = [];
    const final = await runRashidPrecompute(rep, {
      sleep: async () => {},
      compute: async (fen) => {
        calls.push(fenKey(fen) as string);
        return fenKey(fen) === w2.fenKey
          ? { result: LIT, fromCache: true }
          : { result: DARK, fromCache: false };
      },
    });
    expect(calls).toHaveLength(3);
    expect(final).toMatchObject({
      total: 3,
      done: 3,
      computed: 2,
      cached: 1,
      lit: 1,
      failed: 0,
      current: null,
      paused: false,
    });
  });

  it('reports every processed position through onResult', async () => {
    const { rep, w2 } = fixture();
    const seen: Array<[string, boolean, boolean]> = [];
    await runRashidPrecompute(rep, {
      sleep: async () => {},
      compute: async (fen) =>
        fenKey(fen) === w2.fenKey
          ? { result: LIT, fromCache: true }
          : { result: DARK, fromCache: false },
      onResult: (pos, result, fromCache) => seen.push([pos.id, result.lightsUp, fromCache]),
    });
    expect(seen).toEqual([
      ['p0', false, false],
      [w2.id, true, true],
      ['p4', false, false],
    ]);
  });

  it('a failing position is counted and does not sink the run', async () => {
    const { rep, root } = fixture();
    const final = await runRashidPrecompute(rep, {
      sleep: async () => {},
      compute: async (fen) => {
        if (fenKey(fen) === root.fenKey) throw new Error('terminal');
        return { result: DARK, fromCache: false };
      },
    });
    expect(final).toMatchObject({ done: 3, computed: 2, failed: 1 });
  });

  it('cancellation stops between positions', async () => {
    const { rep } = fixture();
    let calls = 0;
    const final = await runRashidPrecompute(rep, {
      sleep: async () => {},
      shouldCancel: () => calls >= 1,
      compute: async () => {
        calls += 1;
        return { result: DARK, fromCache: false };
      },
    });
    expect(calls).toBe(1);
    expect(final.done).toBe(1);
  });

  it('waits while a drill is running instead of computing through it', async () => {
    const { rep } = fixture();
    let drillChecks = 0;
    let sleeps = 0;
    const pausedStates: boolean[] = [];
    const final = await runRashidPrecompute(rep, {
      // Drilling during the first two checks, then the session ends.
      isDrilling: () => {
        drillChecks += 1;
        return drillChecks <= 2;
      },
      sleep: async () => {
        sleeps += 1;
      },
      onProgress: (p) => pausedStates.push(p.paused),
      compute: async () => ({ result: DARK, fromCache: false }),
    });
    expect(sleeps).toBeGreaterThanOrEqual(2); // actually waited, twice
    expect(pausedStates).toContain(true); // surfaced the pause to the UI
    expect(final.done).toBe(3); // and then finished the whole run
    expect(final.paused).toBe(false);
  });
});
