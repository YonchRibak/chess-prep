/**
 * Flow F3.2: feed the guided session's meter with game-weighted coverage.
 *
 * Projects the scoped subtree into the pure `computeGameWeightedCoverage`
 * shape and reads explorer entries through the API with `cachedOnly` — the
 * meter must never trigger live lichess fetches (the prefetcher warms the
 * frontier; a cold entry is an honest "unknown", not a reason to hammer the
 * network). Returns `null` when the result isn't trustworthy (cold cache) —
 * the caller falls back to the structural meter.
 */
import {
  computeGameWeightedCoverage,
  gameWeightedCoverageUsable,
  matchesLineScope,
  type CoverageNode,
  type GameWeightedCoverage,
  type LineScope,
} from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';
import { fetchExplorerEntry } from '../openings/candidates.ts';
import { buildDeepestOpeningIndex, type OpeningLookup } from '../openings/pathNames.ts';
import type { WalkerIndices } from './walker.ts';
import { fenTurn, isUserMove, type Color, type ExplorerEntry } from '@chess-prep/shared';

/** Cap on cachedOnly entry reads per computation — bounds request fan-out. */
const MAX_ENTRY_READS = 60;

export async function computeGuidedGameCoverage(args: {
  rep: RepertoireFull;
  indices: WalkerIndices;
  scope?: LineScope;
  openingLookup?: OpeningLookup;
  /** The prep target's cap, in plies from the REPERTOIRE root. */
  maxDepthPlies: number;
}): Promise<GameWeightedCoverage | null> {
  const { rep, indices, scope, openingLookup, maxDepthPlies } = args;
  const root = indices.positionByKey.get(rep.rootFenKey);
  if (!root) return null;
  const scoped = scope !== undefined && scope.kind !== 'all' && Boolean(scope.value?.trim());
  const deepest = scoped && scope!.kind === 'openingName'
    ? buildDeepestOpeningIndex(rep, openingLookup ?? (() => null))
    : null;

  // Walk root = the scope's stem: the shallowest position whose in-edge is in
  // scope ("% of games" means % of games that reach this line). Multiple stems
  // are possible for a name scope; the shallowest wins — documented v1.
  let stemId = root.id;
  let stemDepth = 0;
  if (scoped) {
    type Step = { id: string; depth: number };
    const queue: Step[] = [{ id: root.id, depth: 0 }];
    const visited = new Set<string>([root.id]);
    let found: Step | null = null;
    while (queue.length > 0 && !found) {
      const { id, depth } = queue.shift()!;
      for (const m of (indices.movesByParent.get(id) ?? []).filter((x) => !x.isDropped)) {
        if (visited.has(m.childPositionId)) continue;
        visited.add(m.childPositionId);
        const inScope = matchesLineScope(scope, {
          deepestOpening: deepest?.get(m.childPositionId) ?? null,
          lineTags: m.lineTags ?? [],
        });
        if (inScope) {
          found = { id: m.childPositionId, depth: depth + 1 };
          break;
        }
        queue.push({ id: m.childPositionId, depth: depth + 1 });
      }
    }
    if (!found) return null; // scope matches nothing — structural meter's job
    stemId = found.id;
    stemDepth = found.depth;
  }

  // Project the subtree into CoverageNodes keyed by fenKey.
  const nodes = new Map<string, CoverageNode>();
  const opponentKeys: string[] = [];
  {
    const queue: string[] = [stemId];
    const visited = new Set<string>([stemId]);
    let depthGuard = 0;
    while (queue.length > 0 && depthGuard++ < 10_000) {
      const id = queue.shift()!;
      const pos = indices.positionById.get(id);
      if (!pos) continue;
      const isUserTurn = isUserMove(fenTurn(pos.fullFen), rep.color as Color);
      const live = (indices.movesByParent.get(id) ?? []).filter((m) => !m.isDropped);
      nodes.set(pos.fenKey, {
        isUserTurn,
        moves: live.map((m) => ({ uci: m.uci, san: m.san, childFenKey: m.childFenKey })),
      });
      if (!isUserTurn && live.length > 0) opponentKeys.push(pos.fenKey);
      for (const m of live) {
        if (visited.has(m.childPositionId)) continue;
        visited.add(m.childPositionId);
        queue.push(m.childPositionId);
      }
    }
  }

  const entries = new Map<string, ExplorerEntry | null>();
  await Promise.all(
    opponentKeys.slice(0, MAX_ENTRY_READS).map(async (k) => {
      entries.set(k, await fetchExplorerEntry(k, { cachedOnly: true }));
    }),
  );

  const stemPos = indices.positionById.get(stemId)!;
  const cov = computeGameWeightedCoverage({
    rootFenKey: stemPos.fenKey,
    nodes,
    getEntry: (k) => entries.get(k) ?? null,
    maxDepthPlies: Math.max(1, maxDepthPlies - stemDepth),
  });
  return gameWeightedCoverageUsable(cov) ? cov : null;
}
