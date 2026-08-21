/**
 * Phase 9d interference detection, over the web's repertoire tree shape.
 *
 * The pure rule lives in `packages/shared/src/attempts.ts`; this module's job is
 * to feed it the right rows and to turn a hit into something worth showing —
 * "that's your move in the Advance Variation, not here".
 */
import {
  fenTurn,
  findInterference,
  isUserMove,
  type Color,
  type OpeningId,
  type PrepRef,
} from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';
import { buildDeepestOpeningIndex } from '../openings/pathNames.ts';

export interface InterferenceHit {
  moveId: string;
  san: string;
  /** Position where this SAN *is* the user's prep. */
  parentPositionId: string;
  parentFenKey: string;
  /** Deepest ECO name of the line that prep belongs to, when known. */
  opening: OpeningId | null;
}

/**
 * User-side, non-dropped, non-shadow moves only.
 *
 * An opponent reply that happens to share the SAN is a coincidence, not a
 * confusion; a dropped branch is a line the user has explicitly stopped
 * covering, so citing it as "your move" would be false; and a Phase 9d
 * refutation shadow line is a move the user played *by mistake* — reporting it
 * back as "that's your prep elsewhere" would be exactly backwards.
 */
function userPreps(repertoire: RepertoireFull): PrepRef[] {
  const positionById = new Map(repertoire.positions.map((p) => [p.id, p]));
  const out: PrepRef[] = [];
  for (const m of repertoire.moves) {
    if (m.isDropped || m.isRefutation) continue;
    const parent = positionById.get(m.parentPositionId);
    if (!parent) continue;
    if (!isUserMove(fenTurn(parent.fullFen), repertoire.color as Color)) continue;
    out.push({ moveId: m.id, parentPositionId: m.parentPositionId, san: m.san });
  }
  return out;
}

/**
 * Did the user play their own prep from somewhere else in this tree?
 *
 * `openingLookup` is optional and only enriches the message: without it the hit
 * still names the position, which is the part that makes the feedback true.
 */
export function detectInterference(
  repertoire: RepertoireFull,
  currentParentPositionId: string,
  playedSan: string,
  openingLookup?: (fenKey: string) => OpeningId | null,
): InterferenceHit[] {
  const hits = findInterference(playedSan, currentParentPositionId, userPreps(repertoire));
  if (hits.length === 0) return [];

  const positionById = new Map(repertoire.positions.map((p) => [p.id, p]));
  const deepestByPositionId = openingLookup
    ? buildDeepestOpeningIndex(repertoire, openingLookup)
    : null;

  return hits.map((h) => {
    const parent = positionById.get(h.parentPositionId);
    return {
      moveId: h.moveId,
      san: h.san,
      parentPositionId: h.parentPositionId,
      parentFenKey: parent?.fenKey ?? '',
      // The name is taken at the *parent* here, not the child as the scope
      // filter does: the message is about where the user stood when that move
      // is right, not about the line the move creates.
      opening: deepestByPositionId?.get(h.parentPositionId) ?? null,
    };
  });
}

/** One-line feedback for the drill UI, or null when there's nothing to say. */
export function describeInterference(hits: readonly InterferenceHit[]): string | null {
  const first = hits[0];
  if (!first) return null;
  const name = first.opening
    ? first.opening.variation
      ? `${first.opening.name}: ${first.opening.variation}`
      : first.opening.name
    : null;
  const where = name ? `in the ${name}` : 'at a different position';
  const more = hits.length > 1 ? ` (and ${hits.length - 1} more)` : '';
  return `${first.san} is your prep ${where}${more} — not here.`;
}
