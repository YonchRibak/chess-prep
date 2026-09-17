/**
 * Pure tree-browsing primitives over a `RepertoireFull`, shared by the
 * repertoire editor and the study browser (S4). Extracted from the editor so
 * the two views cannot disagree on sibling order, path choice, or how a
 * variation tree flattens into PGN-shaped tokens.
 *
 * Unlike the walker's indices these keep *every* edge (dropped, refutation)
 * — browsing must show what is in the tree; only drilling filters it.
 */
import type { RepertoireFull, RepertoireMove, RepertoirePosition } from '../../api/client.ts';

export interface TreeIndices {
  positionByKey: Map<string, RepertoirePosition>;
  positionById: Map<string, RepertoirePosition>;
  movesByParent: Map<string, RepertoireMove[]>;
  parentMovesByChildId: Map<string, RepertoireMove[]>;
}

export function buildTreeIndices(rep: RepertoireFull | null): TreeIndices {
  const positionByKey = new Map<string, RepertoirePosition>();
  const positionById = new Map<string, RepertoirePosition>();
  const movesByParent = new Map<string, RepertoireMove[]>();
  const parentMovesByChildId = new Map<string, RepertoireMove[]>();
  if (rep) {
    for (const p of rep.positions) {
      positionByKey.set(p.fenKey, p);
      positionById.set(p.id, p);
    }
    for (const m of rep.moves) {
      const arr = movesByParent.get(m.parentPositionId) ?? [];
      arr.push(m);
      movesByParent.set(m.parentPositionId, arr);
      const carr = parentMovesByChildId.get(m.childPositionId) ?? [];
      carr.push(m);
      parentMovesByChildId.set(m.childPositionId, carr);
    }
  }
  return { positionByKey, positionById, movesByParent, parentMovesByChildId };
}

/** Main line first, then priority, then SAN — the same order PGN export uses. */
export function sortSiblings(moves: RepertoireMove[]): RepertoireMove[] {
  return [...moves].sort((a, b) => {
    if (a.isMainLine !== b.isMainLine) return a.isMainLine ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.san.localeCompare(b.san);
  });
}

/**
 * Best-effort path from the root to `fenKey`, choosing main-line ancestors.
 * A position can have several incoming edges (transpositions), so the choice
 * is made deterministic via `sortSiblings` — the same jump must always show
 * the same breadcrumb.
 */
export function computePathToFenKey(
  rep: RepertoireFull,
  indices: TreeIndices,
  fenKey: string,
): RepertoireMove[] {
  const path: RepertoireMove[] = [];
  let cursorKey = fenKey;
  const visited = new Set<string>();
  while (cursorKey !== rep.rootFenKey) {
    if (visited.has(cursorKey)) break;
    visited.add(cursorKey);
    const position = indices.positionByKey.get(cursorKey);
    if (!position) break;
    const incoming = indices.parentMovesByChildId.get(position.id);
    if (!incoming || incoming.length === 0) break;
    const chosen = sortSiblings(incoming)[0]!;
    path.unshift(chosen);
    const parentPos = indices.positionById.get(chosen.parentPositionId);
    if (!parentPos) break;
    cursorKey = parentPos.fenKey;
  }
  return path;
}

export function parseFenMeta(fen: string): { fullMoveNumber: number; turn: 'w' | 'b' } {
  const parts = fen.trim().split(/\s+/);
  return {
    turn: (parts[1] ?? 'w') as 'w' | 'b',
    fullMoveNumber: Number(parts[5] ?? 1),
  };
}

export interface TreeRenderToken {
  kind: 'move' | 'open-var' | 'close-var';
  move?: RepertoireMove;
  fullMoveNumber?: number;
  isWhite?: boolean;
  needsNumberLabel?: boolean;
  depth: number;
}

/**
 * Flatten the tree into PGN-shaped tokens: the main move, then each sibling
 * variation in parentheses (recursively), then the main line continues. A
 * transposed position's subtree is emitted once, at its first visit.
 */
export function flattenTree(rep: RepertoireFull, indices: TreeIndices): TreeRenderToken[] {
  const out: TreeRenderToken[] = [];
  const visited = new Set<string>();

  function walk(parentPositionId: string, parentFullFen: string, depth: number, isLineStart: boolean) {
    const children = sortSiblings(indices.movesByParent.get(parentPositionId) ?? []);
    if (children.length === 0) return;
    const currentFullFen = parentFullFen;
    const pairFlow = !isLineStart;

    for (let idx = 0; idx < children.length; idx++) {
      const m = children[idx]!;
      const isMain = idx === 0;
      const meta = parseFenMeta(currentFullFen);

      if (isMain) {
        out.push({
          kind: 'move',
          move: m,
          fullMoveNumber: meta.fullMoveNumber,
          isWhite: meta.turn === 'w',
          needsNumberLabel: meta.turn === 'w' || !pairFlow,
          depth,
        });
      } else {
        out.push({ kind: 'open-var', depth });
        out.push({
          kind: 'move',
          move: m,
          fullMoveNumber: meta.fullMoveNumber,
          isWhite: meta.turn === 'w',
          needsNumberLabel: true,
          depth: depth + 1,
        });
        const childPosForVar = indices.positionById.get(m.childPositionId);
        if (childPosForVar && !visited.has(childPosForVar.id)) {
          visited.add(childPosForVar.id);
          walk(childPosForVar.id, childPosForVar.fullFen, depth + 1, false);
        }
        out.push({ kind: 'close-var', depth });
      }
    }

    // Continue down the main line after emitting siblings.
    const main = children[0]!;
    const mainChildPos = indices.positionById.get(main.childPositionId);
    if (mainChildPos && !visited.has(mainChildPos.id)) {
      visited.add(mainChildPos.id);
      walk(mainChildPos.id, mainChildPos.fullFen, depth, children.length > 1 ? false : true);
    }
  }

  const root = indices.positionByKey.get(rep.rootFenKey);
  if (root) {
    visited.add(root.id);
    walk(root.id, root.fullFen, 0, true);
  }
  return out;
}
