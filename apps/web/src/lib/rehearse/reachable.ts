/**
 * Position ids reachable from the root over live edges (not dropped, not a
 * refutation shadow) — the client-side twin of `liveReachablePositions` in
 * shared, which the API uses to decide what gets carded.
 *
 * The queue builder only skips a dropped move *itself*; a hero move below a
 * demoted alternate is not dropped, has no server card, and is never played
 * in rehearsal. Anything that synthesizes cards or paths must therefore
 * filter on reachability, or the board ends up at the root with nothing to
 * replay (the S5 launch bug).
 */
import type { RepertoireFull } from '../../api/client.ts';

export function liveReachablePositionIds(rep: RepertoireFull): Set<string> {
  const root = rep.positions.find((p) => p.fenKey === rep.rootFenKey);
  const out = new Set<string>();
  if (!root) return out;
  const children = new Map<string, string[]>();
  for (const m of rep.moves) {
    if (m.isDropped || m.isRefutation) continue;
    const list = children.get(m.parentPositionId);
    if (list) list.push(m.childPositionId);
    else children.set(m.parentPositionId, [m.childPositionId]);
  }
  const queue = [root.id];
  out.add(root.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const c of children.get(id) ?? []) {
      if (out.has(c)) continue;
      out.add(c);
      queue.push(c);
    }
  }
  return out;
}
