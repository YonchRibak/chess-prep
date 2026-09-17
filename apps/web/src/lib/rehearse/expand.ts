/**
 * "Expand variations" (Study S5): the pure half.
 *
 * A study covers the opponent replies its author thought of. This mode walks
 * the opponent-turn positions of a chapter and offers the popular replies the
 * study does NOT cover, so the user can record their answer. Sourcing order is
 * explorer (real frequency) → engine MultiPV → ECO book → nothing, and a cold
 * explorer must never block: the session has to work offline.
 *
 * Unlike Phase 9c auto-expansion, nothing here writes silently — the user
 * picks the deviation and plays the reply — so the book and the engine are
 * acceptable sources: the user sees where a list came from and judges it.
 */
import {
  fenTurn,
  isUserMove,
  selectOpponentReplies,
  type Color,
  type EngineCandidate,
  type ExplorerEntry,
  type RankedReply,
} from '@chess-prep/shared';
import type { BookContinuation, RepertoireFull, RepertoireMove, RepertoirePosition } from '../../api/client.ts';
import { bookAsReplies } from '../openings/candidates.ts';
import type { WalkerIndices } from '../walker/walker.ts';

export interface ExpandTarget {
  position: RepertoirePosition;
  depth: number;
  /** SANs from the root to `position`. */
  pathSans: string[];
  /** Every edge at this parent — live, dropped and shadow — for `uncoveredReplies`. */
  existing: RepertoireMove[];
}

/**
 * Opponent-turn positions reachable over live edges, shallow-first, each
 * once. With a `chapterTag`, only positions reached by an edge carrying the
 * tag (or the root, when a tagged edge leaves it).
 */
export function collectExpandTargets(
  rep: RepertoireFull,
  indices: WalkerIndices,
  chapterTag?: string,
): ExpandTarget[] {
  const root = indices.positionByKey.get(rep.rootFenKey);
  if (!root) return [];
  const inTag = (m: RepertoireMove) => !chapterTag || m.lineTags.includes(chapterTag);
  const liveOut = (id: string) => (indices.movesByParent.get(id) ?? []).filter((m) => !m.isDropped);

  const out: ExpandTarget[] = [];
  const visited = new Set<string>([root.id]);
  const queue: Array<{ id: string; depth: number; path: string[]; tagged: boolean }> = [
    { id: root.id, depth: 0, path: [], tagged: liveOut(root.id).some(inTag) },
  ];
  while (queue.length > 0) {
    const { id, depth, path, tagged } = queue.shift()!;
    const pos = indices.positionById.get(id);
    if (!pos) continue;
    if (tagged && !isUserMove(fenTurn(pos.fullFen), rep.color as Color)) {
      out.push({ position: pos, depth, pathSans: path, existing: indices.allMovesByParent.get(id) ?? [] });
    }
    for (const m of liveOut(id)) {
      if (visited.has(m.childPositionId)) continue;
      visited.add(m.childPositionId);
      queue.push({ id: m.childPositionId, depth: depth + 1, path: [...path, m.san], tagged: inTag(m) });
    }
  }
  return out;
}

/**
 * Candidates minus anything already at the parent — live, dropped **and**
 * shadow. Offering a dropped SAN would re-add what the user rejected;
 * offering a shadow SAN would silently promote a refutation line to prep.
 */
export function uncoveredReplies(
  candidates: readonly RankedReply[],
  existing: readonly RepertoireMove[],
): RankedReply[] {
  const taken = new Set(existing.map((m) => m.san));
  return candidates.filter((c) => !taken.has(c.san));
}

export type DeviationSource = 'explorer' | 'engine' | 'book' | 'none';

export interface DeviationSources {
  explorer: ExplorerEntry | null;
  sideToMove: 'w' | 'b';
  /** Engine MultiPV first moves for exactly this position, or none yet. */
  engine: readonly EngineCandidate[];
  book: readonly BookContinuation[];
}

/** First source with something to say, in order of how much it knows. */
export function pickDeviationSource(s: DeviationSources): {
  replies: RankedReply[];
  source: DeviationSource;
} {
  const explorer = selectOpponentReplies(s.explorer, s.sideToMove, { maxReplies: 5, minShare: 0.03 });
  if (explorer.length > 0) return { replies: explorer, source: 'explorer' };
  if (s.engine.length > 0) {
    return {
      replies: s.engine.map((c) => ({ san: c.san, uci: c.uci, share: 0, games: 0, score: null })),
      source: 'engine',
    };
  }
  const book = bookAsReplies(s.book);
  if (book.length > 0) return { replies: book, source: 'book' };
  return { replies: [], source: 'none' };
}
