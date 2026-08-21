/**
 * Per-repertoire at-a-glance stats for the home screen: due cards, total
 * cards, and open build gaps. Computed client-side from the locally cached
 * full snapshot + the local SRS card store, so it works offline and always
 * reflects the cards the drill would actually use.
 */
import type { SrsCardDto } from '@chess-prep/shared';
import type { RepertoireFull } from '../api/client.ts';
import { buildIndices, computeCoverage } from './walker/walker.ts';

export interface RepStats {
  totalCards: number;
  dueCards: number;
  newCards: number;
  /** Positions with no live continuation — the walker's build TODO. */
  uncovered: number;
  liveMoves: number;
}

export function computeRepStats(
  rep: RepertoireFull,
  cards: SrsCardDto[],
  now: Date = new Date(),
): RepStats {
  const indices = buildIndices(rep);
  const cov = computeCoverage(rep, indices);
  const liveMoveIds = new Set(
    rep.moves.filter((m) => !m.isDropped && !m.isRefutation).map((m) => m.id),
  );

  let totalCards = 0;
  let dueCards = 0;
  let newCards = 0;
  for (const c of cards) {
    if (!liveMoveIds.has(c.moveId)) continue;
    totalCards++;
    if (new Date(c.due) <= now) dueCards++;
    if (c.state === 0) newCards++;
  }
  return {
    totalCards,
    dueCards,
    newCards,
    uncovered: cov.uncovered,
    liveMoves: cov.liveMoves,
  };
}
