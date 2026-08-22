/**
 * Flow F3.2: game-weighted coverage — "what share of games that reach this
 * line am I prepared for?", the number the guided meter shows.
 *
 * Pure: the caller supplies the (scoped) tree as a fenKey-keyed map and an
 * explorer entry per opponent-turn node. Probability mass starts at 1 at the
 * walk's root and flows down: at an opponent node each explorer-listed reply
 * carries its share of games — prepared replies keep flowing, unprepared ones
 * are *uncovered*; a user-turn node with no prep is uncovered outright; mass
 * that survives to the depth cap (or past the tree's prepared frontier) is
 * *covered*.
 *
 * Cold data degrades honestly rather than optimistically: an opponent node
 * with no entry moves its whole mass to `unknownShare` instead of guessing,
 * and the caller falls back to the structural meter when unknown dominates —
 * a made-up 90% would defeat the point of having a finish line.
 */
import { moveShare, type ExplorerEntry } from './explorer.js';

/** One tree node, minimal shape — client and server reps both project to it. */
export interface CoverageNode {
  isUserTurn: boolean;
  /** Live (non-dropped, non-refutation) out-edges. */
  moves: Array<{ uci: string; san: string; childFenKey: string }>;
}

export interface GameWeightedCoverage {
  /** Mass that stayed inside prepared lines to the cap / frontier edge, 0..1. */
  coveredShare: number;
  /** Mass that hit an unprepared reply or an unprepped user turn, 0..1. */
  uncoveredShare: number;
  /** Mass parked at opponent nodes with no explorer data, 0..1. */
  unknownShare: number;
  /** Opponent-turn nodes that had / lacked an entry — the warmth signal. */
  nodesWithData: number;
  nodesWithoutData: number;
}

export interface GameWeightedCoverageArgs {
  /** Where the walk starts — the scope's stem (the repertoire root for 'all'). */
  rootFenKey: string;
  nodes: ReadonlyMap<string, CoverageNode>;
  /** Explorer data per fenKey; return null/undefined for a cold position. */
  getEntry: (fenKey: string) => ExplorerEntry | null | undefined;
  /** Stop counting past this many plies below the walk's root. */
  maxDepthPlies?: number;
}

export function computeGameWeightedCoverage(
  args: GameWeightedCoverageArgs,
): GameWeightedCoverage {
  const { rootFenKey, nodes, getEntry, maxDepthPlies } = args;
  const out: GameWeightedCoverage = {
    coveredShare: 0,
    uncoveredShare: 0,
    unknownShare: 0,
    nodesWithData: 0,
    nodesWithoutData: 0,
  };

  const visit = (fenKey: string, depth: number, mass: number): void => {
    if (mass <= 0) return;
    if (maxDepthPlies !== undefined && depth >= maxDepthPlies) {
      out.coveredShare += mass; // reached the target depth still in prep
      return;
    }
    const node = nodes.get(fenKey);
    if (!node) {
      // Past the supplied tree via a prepared move — the caller's cap, treat
      // like the frontier edge.
      out.coveredShare += mass;
      return;
    }
    if (node.isUserTurn) {
      if (node.moves.length === 0) {
        out.uncoveredShare += mass; // games arrive here and we have no move
        return;
      }
      // One-prep invariant: a user turn has (at most) one live prep move.
      visit(node.moves[0]!.childFenKey, depth + 1, mass);
      return;
    }
    // Opponent turn: weight by how often each reply is actually played.
    if (node.moves.length === 0) {
      out.uncoveredShare += mass; // no replies prepared at all
      return;
    }
    const entry = getEntry(fenKey);
    if (!entry || entry.total <= 0) {
      out.nodesWithoutData++;
      out.unknownShare += mass;
      return;
    }
    out.nodesWithData++;
    const preparedByUci = new Map(node.moves.map((m) => [m.uci, m]));
    const preparedBySan = new Map(node.moves.map((m) => [m.san, m]));
    let accounted = 0;
    for (const stat of entry.moves) {
      const share = moveShare(stat, entry.total);
      if (share <= 0) continue;
      accounted += share;
      const prepared = preparedByUci.get(stat.uci) ?? preparedBySan.get(stat.san);
      if (prepared) visit(prepared.childFenKey, depth + 1, mass * share);
      else out.uncoveredShare += mass * share;
    }
    // The tail lichess truncates off the move list: games where the opponent
    // played something too rare to be listed — by definition not prepared.
    const tail = Math.max(0, 1 - accounted);
    out.uncoveredShare += mass * tail;
  };

  visit(rootFenKey, 0, 1);
  return out;
}

/**
 * Display heuristic: trust the game-weighted number only while the unknown
 * mass stays small; otherwise the structural count is the honest meter.
 */
export function gameWeightedCoverageUsable(
  cov: GameWeightedCoverage,
  maxUnknownShare = 0.25,
): boolean {
  return cov.nodesWithData > 0 && cov.unknownShare <= maxUnknownShare;
}
