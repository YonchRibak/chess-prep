/**
 * Phase 7 walker: a position-keyed traversal of a repertoire tree that finds
 * the next node needing attention. The walker is the engine behind both seeds:
 *
 * - **Build seed:** BFS from the root, returning the first position where the
 *   tree needs the user to act:
 *     - user-turn parent with NO outgoing live (non-dropped) prep move →
 *       "What's your move?" prompt
 *     - opponent-turn parent with NO outgoing live (non-dropped) response →
 *       "Which responses?" prompt
 *   BFS gives the natural round-robin: ply 3 user-turns across all branches
 *   before any ply 4, etc. Dropped moves and their subtrees are skipped.
 *
 * - **Drill seed:** the drill queue (oldest-due-first) drives node selection;
 *   when the queue lands on an unprepped opponent reply target, the walker
 *   falls through to the build path for that one node (drill-pauses-for-build).
 *
 * Coverage is **derived, not stored**. Nothing on a Position says "covered"
 * — we compute it by inspecting that position's outgoing moves at each step.
 */
import { fenTurn, isUserMove, type Color } from '@chess-prep/shared';
import type { RepertoireFull, RepertoireMove, RepertoirePosition } from '../../api/client.ts';

export interface WalkerIndices {
  positionByKey: Map<string, RepertoirePosition>;
  positionById: Map<string, RepertoirePosition>;
  movesByParent: Map<string, RepertoireMove[]>;
}

export function buildIndices(rep: RepertoireFull): WalkerIndices {
  const positionByKey = new Map<string, RepertoirePosition>();
  const positionById = new Map<string, RepertoirePosition>();
  const movesByParent = new Map<string, RepertoireMove[]>();
  for (const p of rep.positions) {
    positionByKey.set(p.fenKey, p);
    positionById.set(p.id, p);
  }
  for (const m of rep.moves) {
    const arr = movesByParent.get(m.parentPositionId) ?? [];
    arr.push(m);
    movesByParent.set(m.parentPositionId, arr);
  }
  return { positionByKey, positionById, movesByParent };
}

export type WalkerNodeKind = 'user-prep' | 'opponent-picks';

export interface WalkerNode {
  position: RepertoirePosition;
  /** Why this position needs attention. */
  kind: WalkerNodeKind;
  /** Ply distance from the root, for header / progress display. */
  depth: number;
  /** Live (non-dropped) outgoing moves already saved from this position. */
  existingMoves: RepertoireMove[];
  /** Path of moves from the root to this position (best-effort main-line). */
  path: RepertoireMove[];
}

export interface FindNextBuildNodeOptions {
  /** Start BFS from this position instead of the root. */
  fromFenKey?: string;
  /**
   * Position IDs to pass over (session-local "skip for now"). Excluded nodes
   * are not reported; BFS simply continues to the next candidate. Since an
   * attention node has zero live children by definition, there is nothing to
   * descend into — skipping means moving on to sibling branches.
   */
  exclude?: Set<string>;
}

/**
 * BFS the tree from the root; return the FIRST position needing attention.
 * Round-robin emerges naturally from BFS — all ply-3 user-turn positions are
 * visited before any ply-4 (or deeper) ones.
 *
 * Returns `null` when every reachable, non-dropped node is fully covered (or
 * has no outgoing moves and was already covered earlier — i.e. an internal
 * leaf where there's nothing to prompt about).
 *
 * A position needs attention when:
 *   - user-turn: it has NO live outgoing user-side Move (= no prep here)
 *   - opponent-turn: it has NO live outgoing opponent-side Move (= no
 *     responses picked here)
 *
 * Exception: the root of a freshly-blank repertoire (which always has zero
 * outgoing moves) is reported as needing attention only if it isn't yet
 * "skipped" — which it never can be in v1 since skip is ephemeral. So the
 * blank-root case is the natural starting prompt for the build seed.
 */
export function findNextBuildNode(
  rep: RepertoireFull,
  indices: WalkerIndices,
  options: FindNextBuildNodeOptions = {},
): WalkerNode | null {
  const start = options.fromFenKey
    ? indices.positionByKey.get(options.fromFenKey)
    : indices.positionByKey.get(rep.rootFenKey);
  if (!start) return null;
  const color = rep.color as Color;
  const exclude = options.exclude;

  // BFS queue: positions + the path-of-moves taken to reach them.
  type Step = { posId: string; path: RepertoireMove[] };
  const queue: Step[] = [{ posId: start.id, path: [] }];
  const visited = new Set<string>([start.id]);

  while (queue.length > 0) {
    const { posId, path } = queue.shift()!;
    const pos = indices.positionById.get(posId);
    if (!pos) continue;
    const turn = fenTurn(pos.fullFen);
    const liveOut = (indices.movesByParent.get(pos.id) ?? []).filter((m) => !m.isDropped);
    const userTurn = isUserMove(turn, color);

    if (liveOut.length === 0) {
      if (exclude?.has(pos.id)) continue; // skipped this session — move on.
      return {
        position: pos,
        kind: userTurn ? 'user-prep' : 'opponent-picks',
        depth: path.length,
        existingMoves: [],
        path,
      };
    }

    // Already covered at this position — descend into all live children.
    for (const m of liveOut) {
      if (visited.has(m.childPositionId)) continue;
      visited.add(m.childPositionId);
      queue.push({ posId: m.childPositionId, path: [...path, m] });
    }
  }

  return null;
}

/**
 * Variant: starting BFS from a given position (not the root). Used by the
 * "Keep building this branch" prompt after drill-pauses-for-build, so the
 * walker descends into the just-added branch instead of jumping back to the
 * shallowest gap in the whole tree.
 */
export function findNextBuildNodeFrom(
  rep: RepertoireFull,
  indices: WalkerIndices,
  fromFenKey: string,
  exclude?: Set<string>,
): WalkerNode | null {
  return findNextBuildNode(rep, indices, { fromFenKey, exclude });
}

/**
 * Shortest path of live (non-dropped) moves from the repertoire root to a
 * target position. Used to reconstruct the SAN line for display (move list,
 * opening-name header) and to replay the board into a position so the
 * last-move highlight shows how we got there.
 *
 * Returns `[]` for the root itself AND for unreachable positions — callers
 * that need to distinguish should check `targetPositionId` against the root.
 */
export function findPathToPosition(
  rep: RepertoireFull,
  indices: WalkerIndices,
  targetPositionId: string,
): RepertoireMove[] {
  const root = indices.positionByKey.get(rep.rootFenKey);
  if (!root || root.id === targetPositionId) return [];

  // BFS over live moves, remembering the edge used to first reach each node.
  const cameBy = new Map<string, RepertoireMove>();
  const queue: string[] = [root.id];
  const visited = new Set<string>([root.id]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const liveOut = (indices.movesByParent.get(id) ?? []).filter((m) => !m.isDropped);
    for (const m of liveOut) {
      if (visited.has(m.childPositionId)) continue;
      visited.add(m.childPositionId);
      cameBy.set(m.childPositionId, m);
      if (m.childPositionId === targetPositionId) {
        const path: RepertoireMove[] = [];
        let cur = targetPositionId;
        while (cur !== root.id) {
          const edge = cameBy.get(cur);
          if (!edge) return [];
          path.push(edge);
          cur = edge.parentPositionId;
        }
        return path.reverse();
      }
      queue.push(m.childPositionId);
    }
  }
  return [];
}

/**
 * Pure summary stats for the walker header. "in flight" = positions with at
 * least one outgoing live move; "uncovered" = positions with none (= the
 * walker's TODO list). Counted across the whole tree, derived from current
 * state — no caching, runs in O(positions + moves).
 */
export interface CoverageStats {
  /** Total positions in the tree (including the root). */
  totalPositions: number;
  /** Positions with at least one live outgoing move. */
  inFlight: number;
  /** Positions with zero live outgoing moves (= walker TODO). */
  uncovered: number;
  /** Live (non-dropped) moves in the tree. */
  liveMoves: number;
  /** Dropped moves in the tree (the "won't cover" count). */
  droppedMoves: number;
}

export function computeCoverage(rep: RepertoireFull, indices: WalkerIndices): CoverageStats {
  let inFlight = 0;
  let uncovered = 0;
  const reachable = reachablePositions(rep, indices);
  for (const posId of reachable) {
    const liveOut = (indices.movesByParent.get(posId) ?? []).filter((m) => !m.isDropped);
    if (liveOut.length > 0) inFlight++;
    else uncovered++;
  }
  const liveMoves = rep.moves.filter((m) => !m.isDropped).length;
  const droppedMoves = rep.moves.length - liveMoves;
  return {
    totalPositions: reachable.size,
    inFlight,
    uncovered,
    liveMoves,
    droppedMoves,
  };
}

/** Set of position IDs reachable from the root via live (non-dropped) moves. */
function reachablePositions(rep: RepertoireFull, indices: WalkerIndices): Set<string> {
  const visited = new Set<string>();
  const root = indices.positionByKey.get(rep.rootFenKey);
  if (!root) return visited;
  const queue: string[] = [root.id];
  visited.add(root.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const liveOut = (indices.movesByParent.get(id) ?? []).filter((m) => !m.isDropped);
    for (const m of liveOut) {
      if (visited.has(m.childPositionId)) continue;
      visited.add(m.childPositionId);
      queue.push(m.childPositionId);
    }
  }
  return visited;
}

/**
 * For drill-mode opponent-reply selection: when a parent has multiple opponent
 * branches, pick the one whose user-side **child** has the most-due card (per
 * spec §7 → "most-due-child wins"). If no child has a card or all are equally
 * due, falls back to main-line/priority/alpha order.
 *
 * `cardDueByMoveId` is a map from `move.id` → ISO due string; callers can pass
 * an empty map when card data isn't loaded and the function will fall back
 * cleanly.
 */
export function pickOpponentReplyForDrill(
  parentPositionId: string,
  indices: WalkerIndices,
  cardDueByMoveId: Map<string, string>,
): RepertoireMove | null {
  const branches = (indices.movesByParent.get(parentPositionId) ?? []).filter(
    (m) => !m.isDropped,
  );
  if (branches.length === 0) return null;
  if (branches.length === 1) return branches[0]!;

  // For each opponent branch, look at the user-side response cards under the
  // child (one or more). Take the earliest due across that child's children.
  const scored = branches.map((b) => {
    const grandKids = (indices.movesByParent.get(b.childPositionId) ?? []).filter(
      (m) => !m.isDropped,
    );
    let earliestDueMs = Number.POSITIVE_INFINITY;
    for (const gk of grandKids) {
      const due = cardDueByMoveId.get(gk.id);
      if (!due) continue;
      const ms = new Date(due).getTime();
      if (ms < earliestDueMs) earliestDueMs = ms;
    }
    return { b, earliestDueMs };
  });

  scored.sort((a, b) => {
    if (a.earliestDueMs !== b.earliestDueMs) return a.earliestDueMs - b.earliestDueMs;
    if (a.b.isMainLine !== b.b.isMainLine) return a.b.isMainLine ? -1 : 1;
    if (a.b.priority !== b.b.priority) return a.b.priority - b.b.priority;
    return a.b.san.localeCompare(b.b.san);
  });

  return scored[0]!.b;
}
