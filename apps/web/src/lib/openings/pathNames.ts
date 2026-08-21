/**
 * Phase 9a: deepest-book-name per position, for a whole repertoire at once.
 *
 * Opening identity is a **path walk**, not a single-FEN lookup: a position
 * reachable by transposition often isn't in the book itself but inherits its
 * name from an ancestor that is (see
 * [opening-database.md](../../../../../knowledge/03-domain/opening-database.md)).
 * The queue builders and the walker's build seed both need that name for every
 * node, so computing it once per tree — BFS from the root, carrying the last
 * non-null match down — is cheaper and more consistent than per-node lookups.
 *
 * The traversal deliberately follows **all** edges, including dropped ones:
 * naming answers "where am I in theory", which doesn't change because the user
 * decided not to prep a branch. Coverage filtering happens elsewhere.
 */
import type { OpeningId } from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';

export type OpeningLookup = (fenKey: string) => OpeningId | null;

/** positionId → deepest book name along the path from the root. */
export function buildDeepestOpeningIndex(
  rep: RepertoireFull,
  lookup: OpeningLookup,
): Map<string, OpeningId | null> {
  const out = new Map<string, OpeningId | null>();
  const root = rep.positions.find((p) => p.fenKey === rep.rootFenKey);
  if (!root) return out;

  const movesByParent = new Map<string, typeof rep.moves>();
  // Phase 9d: a refutation shadow line must not name a position. It is a
  // punishment of a mistake, so letting it reach a position first would put
  // that position (and everything below it) into a line the user never chose,
  // and an `openingName`-scoped session would then include or exclude the
  // wrong branches.
  for (const m of rep.moves) {
    if (m.isRefutation) continue;
    const arr = movesByParent.get(m.parentPositionId) ?? [];
    arr.push(m);
    movesByParent.set(m.parentPositionId, arr);
  }
  const fenById = new Map(rep.positions.map((p) => [p.id, p.fenKey]));

  out.set(root.id, lookup(root.fenKey));
  const queue: string[] = [root.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const inherited = out.get(id) ?? null;
    for (const m of movesByParent.get(id) ?? []) {
      if (out.has(m.childPositionId)) continue; // first path in wins (shallowest)
      const childKey = fenById.get(m.childPositionId) ?? '';
      out.set(m.childPositionId, lookup(childKey) ?? inherited);
      queue.push(m.childPositionId);
    }
  }
  return out;
}
