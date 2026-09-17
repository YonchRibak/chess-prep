/**
 * Per-chapter (per line tag) progress for the Studies home rows (Study S5):
 * how many hero moves the chapter has, how many are due, how many are
 * "mastered" — in FSRS review state and not yet due again.
 */
import { fenTurn, isUserMove, type Color, type SrsCardDto } from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';

export interface ChapterStats {
  /** Live hero moves carrying the tag — the cards a chapter rehearsal shows. */
  cards: number;
  /** Cards due now, plus hero moves with no card yet (new). */
  due: number;
  /** Cards in review state whose next due date is in the future. */
  mastered: number;
}

export function computeChapterStats(
  rep: RepertoireFull,
  cards: SrsCardDto[],
  now: Date = new Date(),
): Map<string, ChapterStats> {
  const cardByMoveId = new Map(cards.map((c) => [c.moveId, c]));
  const positionById = new Map(rep.positions.map((p) => [p.id, p]));
  const out = new Map<string, ChapterStats>();
  for (const m of rep.moves) {
    if (m.isDropped || m.isRefutation) continue;
    const parent = positionById.get(m.parentPositionId);
    if (!parent || !isUserMove(fenTurn(parent.fullFen), rep.color as Color)) continue;
    const card = cardByMoveId.get(m.id);
    const due = !card || new Date(card.due) <= now;
    const mastered = Boolean(card && card.state === 2 && new Date(card.due) > now);
    for (const tag of m.lineTags) {
      const s = out.get(tag) ?? { cards: 0, due: 0, mastered: 0 };
      s.cards += 1;
      if (due) s.due += 1;
      if (mastered) s.mastered += 1;
      out.set(tag, s);
    }
  }
  return out;
}
