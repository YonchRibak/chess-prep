/**
 * Test-only helper: build a `RepertoireFull` from SAN lines with chess.js so
 * every position has a real FEN (hero-turn detection needs it). Positions are
 * keyed by `fenKey`, so lines that transpose share a node.
 */
import { Chess } from 'chess.js';
import { fenKey, STARTING_FEN } from '@chess-prep/shared';
import type { RepertoireFull, RepertoireMove, RepertoirePosition } from '../../api/client.ts';

export interface TestLine {
  sans: string[];
  tags?: string[];
  mainLine?: boolean;
}

export function makeTestRepertoire(
  color: 'white' | 'black',
  lines: TestLine[],
  overrides: Partial<RepertoireMove>[] = [],
): RepertoireFull {
  const positions = new Map<string, RepertoirePosition>();
  const moves = new Map<string, RepertoireMove>();
  const posFor = (fullFen: string): RepertoirePosition => {
    const key = fenKey(fullFen);
    let p = positions.get(key);
    if (!p) {
      p = { id: `p:${key}`, fenKey: key, fullFen };
      positions.set(key, p);
    }
    return p;
  };
  posFor(STARTING_FEN);
  for (const line of lines) {
    const chess = new Chess();
    for (const san of line.sans) {
      const parent = posFor(chess.fen());
      const mv = chess.move(san);
      if (!mv) throw new Error(`illegal ${san}`);
      const child = posFor(chess.fen());
      const key = `${parent.id}::${mv.san}`;
      const existing = moves.get(key);
      if (existing) {
        for (const t of line.tags ?? []) if (!existing.lineTags.includes(t)) existing.lineTags.push(t);
        existing.isMainLine = existing.isMainLine || Boolean(line.mainLine);
        continue;
      }
      moves.set(key, {
        id: `m:${key}`,
        parentPositionId: parent.id,
        childPositionId: child.id,
        parentFenKey: parent.fenKey,
        childFenKey: child.fenKey,
        san: mv.san,
        uci: mv.from + mv.to + (mv.promotion ?? ''),
        comment: null,
        annotation: null,
        isMainLine: Boolean(line.mainLine),
        priority: 0,
        isDropped: false,
        lineTags: [...(line.tags ?? [])],
        isRefutation: false,
        origin: 'study',
      });
    }
  }
  const all = [...moves.values()];
  for (const o of overrides) {
    const m = all.find((x) => x.san === o.san && (!o.parentFenKey || x.parentFenKey === o.parentFenKey));
    if (m) Object.assign(m, o);
  }
  const rootKey = fenKey(STARTING_FEN);
  return {
    id: 'rep',
    name: 'test',
    color,
    tags: [],
    drillRules: {},
    autoExpand: false,
    source: null,
    rootFenKey: rootKey,
    rootFullFen: STARTING_FEN,
    createdAt: '',
    updatedAt: '',
    positions: [...positions.values()],
    moves: all,
  };
}

export function moveBySan(rep: RepertoireFull, san: string, parentSans: string[] = []): RepertoireMove {
  const chess = new Chess();
  for (const s of parentSans) chess.move(s);
  const parentKey = fenKey(chess.fen());
  const m = rep.moves.find((x) => x.san === san && x.parentFenKey === parentKey);
  if (!m) throw new Error(`no move ${san} after ${parentSans.join(' ')}`);
  return m;
}
