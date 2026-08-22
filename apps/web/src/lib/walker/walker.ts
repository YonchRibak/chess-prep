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
import { fenTurn, isUserMove, matchesLineScope, type Color, type LineScope } from '@chess-prep/shared';
import type { RepertoireFull, RepertoireMove, RepertoirePosition } from '../../api/client.ts';
import { buildDeepestOpeningIndex, type OpeningLookup } from '../openings/pathNames.ts';

export interface WalkerIndices {
  positionByKey: Map<string, RepertoirePosition>;
  positionById: Map<string, RepertoirePosition>;
  /**
   * Prep edges only. Phase 9d refutation shadow lines are **excluded here**, at
   * the single choke point every walker consumer goes through, rather than at
   * each of the dozen `.filter(!isDropped)` sites — a shadow line counted as
   * coverage would make a position look prepped when it isn't, and the walker
   * would silently stop asking about it.
   */
  movesByParent: Map<string, RepertoireMove[]>;
  /**
   * Every edge, shadow lines included. Used only where the question is "does
   * this SAN already exist here?" — auto-expansion must see shadow edges so it
   * never proposes a SAN that would collide with (and silently promote) one.
   */
  allMovesByParent: Map<string, RepertoireMove[]>;
}

export function buildIndices(rep: RepertoireFull): WalkerIndices {
  const positionByKey = new Map<string, RepertoirePosition>();
  const positionById = new Map<string, RepertoirePosition>();
  const movesByParent = new Map<string, RepertoireMove[]>();
  const allMovesByParent = new Map<string, RepertoireMove[]>();
  for (const p of rep.positions) {
    positionByKey.set(p.fenKey, p);
    positionById.set(p.id, p);
  }
  for (const m of rep.moves) {
    const all = allMovesByParent.get(m.parentPositionId) ?? [];
    all.push(m);
    allMovesByParent.set(m.parentPositionId, all);
    if (m.isRefutation) continue;
    const arr = movesByParent.get(m.parentPositionId) ?? [];
    arr.push(m);
    movesByParent.set(m.parentPositionId, arr);
  }
  return { positionByKey, positionById, movesByParent, allMovesByParent };
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
  /**
   * Phase 9a: keep building, but only inside one line. A candidate node is in
   * scope when the **edge that reached it** is — an attention node has no
   * outgoing moves of its own, so it has no tags or name to test.
   *
   * Consequence worth knowing: under a non-'all' scope the root itself is never
   * offered, because no edge leads into it. Scoped building only makes sense
   * once the line exists; use scope 'all' to start one.
   */
  scope?: LineScope;
  /** `fenKey → OpeningId`, required only for an `openingName` scope. */
  openingLookup?: OpeningLookup;
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
  const scope = options.scope;
  const scoped = scope !== undefined && scope.kind !== 'all' && Boolean(scope.value?.trim());
  const deepestByPositionId =
    scoped && scope!.kind === 'openingName'
      ? buildDeepestOpeningIndex(rep, options.openingLookup ?? (() => null))
      : null;

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
      if (scoped) {
        const edge = path[path.length - 1];
        const inScope =
          edge !== undefined &&
          matchesLineScope(scope, {
            deepestOpening: deepestByPositionId?.get(pos.id) ?? null,
            lineTags: edge.lineTags ?? [],
          });
        if (!inScope) continue; // out of the scoped line — keep looking.
      }
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

/* ---------------- Flow F2: line-first traversal (guided prepare) ---------------- */

export interface LineFirstOptions
  extends Pick<FindNextBuildNodeOptions, 'exclude' | 'scope' | 'openingLookup'> {
  /**
   * The position the session just extended. The traversal continues down that
   * branch first, backtracks to the nearest ancestor with another gap when the
   * branch is done, and only then jumps elsewhere.
   */
  lastReachedFenKey?: string;
  /**
   * Stop offering prompts at positions this many plies (or more) from the
   * root — the prep target's depth cap. Subtrees past the cap are not entered.
   */
  maxDepthPlies?: number;
}

/**
 * Guided-prepare sibling of `findNextBuildNode`: **line-at-a-time** instead of
 * tree-wide BFS. BFS round-robin is the right default for balanced growth, but
 * in a "prepare against X" session it jumps the board between unrelated
 * branches on every question — focused prep wants to finish the Advance line
 * to the target depth, rehearse it, then take the Classical.
 *
 * Order: (1) deepest-first inside the branch below `lastReachedFenKey`
 * (main line before alternatives), (2) backtrack ancestor by ancestor to the
 * nearest unexplored sibling branch, (3) with nothing in progress, the
 * shallowest gap in scope (plain BFS). Scope and skip semantics are identical
 * to `findNextBuildNode`; returns `null` when the scoped, capped subtree is
 * fully covered — the guided session's "done" signal.
 */
export function findNextBuildNodeLineFirst(
  rep: RepertoireFull,
  indices: WalkerIndices,
  options: LineFirstOptions = {},
): WalkerNode | null {
  const root = indices.positionByKey.get(rep.rootFenKey);
  if (!root) return null;
  const { exclude, scope, maxDepthPlies } = options;
  const scoped = scope !== undefined && scope.kind !== 'all' && Boolean(scope.value?.trim());
  const deepestByPositionId =
    scoped && scope!.kind === 'openingName'
      ? buildDeepestOpeningIndex(rep, options.openingLookup ?? (() => null))
      : null;

  // One BFS for depth-from-root, the in-edge, and the parent of every
  // live-reachable position. Insertion order of `depthById` IS BFS order,
  // which the fallback below relies on.
  const depthById = new Map<string, number>();
  const inEdgeById = new Map<string, RepertoireMove>();
  const parentById = new Map<string, string>();
  {
    const queue: string[] = [root.id];
    depthById.set(root.id, 0);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const d = depthById.get(id)!;
      for (const m of liveOut(indices, id)) {
        if (depthById.has(m.childPositionId)) continue;
        depthById.set(m.childPositionId, d + 1);
        inEdgeById.set(m.childPositionId, m);
        parentById.set(m.childPositionId, id);
        queue.push(m.childPositionId);
      }
    }
  }

  const color = rep.color as Color;
  const attentionAt = (posId: string): WalkerNode | null => {
    const pos = indices.positionById.get(posId);
    if (!pos) return null;
    if (liveOut(indices, posId).length > 0) return null;
    if (exclude?.has(posId)) return null;
    const depth = depthById.get(posId) ?? 0;
    if (maxDepthPlies !== undefined && depth >= maxDepthPlies) return null;
    if (scoped) {
      const edge = inEdgeById.get(posId);
      const inScope =
        edge !== undefined &&
        matchesLineScope(scope, {
          deepestOpening: deepestByPositionId?.get(posId) ?? null,
          lineTags: edge.lineTags ?? [],
        });
      if (!inScope) return null;
    }
    return {
      position: pos,
      kind: isUserMove(fenTurn(pos.fullFen), color) ? 'user-prep' : 'opponent-picks',
      depth,
      existingMoves: [],
      path: findPathToPosition(rep, indices, posId),
    };
  };

  /** DFS, main line first, self included. Stops at the depth cap. */
  const dfs = (startId: string): WalkerNode | null => {
    const visited = new Set<string>();
    const visit = (id: string): WalkerNode | null => {
      if (visited.has(id)) return null;
      visited.add(id);
      const here = attentionAt(id);
      if (here) return here;
      const depth = depthById.get(id);
      if (depth === undefined) return null;
      if (maxDepthPlies !== undefined && depth >= maxDepthPlies) return null;
      const out = [...liveOut(indices, id)].sort(byMainLineFirst);
      for (const m of out) {
        const found = visit(m.childPositionId);
        if (found) return found;
      }
      return null;
    };
    return visit(startId);
  };

  const last = options.lastReachedFenKey
    ? indices.positionByKey.get(options.lastReachedFenKey)
    : undefined;

  if (last && depthById.has(last.id)) {
    // (1) Finish the branch in progress.
    const below = dfs(last.id);
    if (below) return below;
    // (2) Backtrack to the nearest ancestor with an unexplored sibling gap.
    let from = last.id;
    let cur = parentById.get(last.id);
    while (cur !== undefined) {
      for (const m of [...liveOut(indices, cur)].sort(byMainLineFirst)) {
        if (m.childPositionId === from) continue;
        const found = dfs(m.childPositionId);
        if (found) return found;
      }
      from = cur;
      cur = parentById.get(cur);
    }
    return null;
  }

  // (3) Nothing in progress: shallowest gap in scope (BFS order).
  for (const id of depthById.keys()) {
    const node = attentionAt(id);
    if (node) return node;
  }
  return null;
}

function liveOut(indices: WalkerIndices, posId: string): RepertoireMove[] {
  return (indices.movesByParent.get(posId) ?? []).filter((m) => !m.isDropped);
}

function byMainLineFirst(a: RepertoireMove, b: RepertoireMove): number {
  if (a.isMainLine !== b.isMainLine) return a.isMainLine ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.san.localeCompare(b.san);
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
  scopeOptions?: Pick<FindNextBuildNodeOptions, 'scope' | 'openingLookup'>,
): WalkerNode | null {
  return findNextBuildNode(rep, indices, { fromFenKey, exclude, ...scopeOptions });
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
  // Shadow lines are not part of the repertoire's size in either direction —
  // they are neither covered prep nor a branch the user declined.
  const prepMoves = rep.moves.filter((m) => !m.isRefutation);
  const liveMoves = prepMoves.filter((m) => !m.isDropped).length;
  const droppedMoves = prepMoves.length - liveMoves;
  return {
    totalPositions: reachable.size,
    inFlight,
    uncovered,
    liveMoves,
    droppedMoves,
  };
}

/**
 * Flow F2: coverage within a scope + depth cap — the guided session's
 * "covered / to target" meter. Structural v1 (attention-node counts); the
 * game-weighted upgrade is F3. `toBuild` counts the nodes
 * `findNextBuildNodeLineFirst` would still offer (modulo session-local skips,
 * which stay counted — a deferred prompt is still work to do).
 */
export interface ScopedCoverageStats {
  /** In-scope positions (within the cap) that already have a live continuation. */
  covered: number;
  /** In-scope attention nodes (within the cap) still to prompt about. */
  toBuild: number;
}

export function computeScopedCoverage(
  rep: RepertoireFull,
  indices: WalkerIndices,
  options: Pick<LineFirstOptions, 'scope' | 'openingLookup' | 'maxDepthPlies'> = {},
): ScopedCoverageStats {
  const root = indices.positionByKey.get(rep.rootFenKey);
  if (!root) return { covered: 0, toBuild: 0 };
  const { scope, maxDepthPlies } = options;
  const scoped = scope !== undefined && scope.kind !== 'all' && Boolean(scope.value?.trim());
  const deepestByPositionId =
    scoped && scope!.kind === 'openingName'
      ? buildDeepestOpeningIndex(rep, options.openingLookup ?? (() => null))
      : null;

  let covered = 0;
  let toBuild = 0;
  type Step = { id: string; depth: number; inEdge: RepertoireMove | null };
  const queue: Step[] = [{ id: root.id, depth: 0, inEdge: null }];
  const visited = new Set<string>([root.id]);
  while (queue.length > 0) {
    const { id, depth, inEdge } = queue.shift()!;
    if (maxDepthPlies !== undefined && depth >= maxDepthPlies) continue;
    const out = liveOut(indices, id);
    const inScope = !scoped
      ? true
      : inEdge !== null &&
        matchesLineScope(scope, {
          deepestOpening: deepestByPositionId?.get(id) ?? null,
          lineTags: inEdge.lineTags ?? [],
        });
    if (inScope) {
      if (out.length > 0) covered++;
      else toBuild++;
    }
    for (const m of out) {
      if (visited.has(m.childPositionId)) continue;
      visited.add(m.childPositionId);
      queue.push({ id: m.childPositionId, depth: depth + 1, inEdge: m });
    }
  }
  return { covered, toBuild };
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
