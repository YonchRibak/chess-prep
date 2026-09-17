/**
 * The rehearsal session's queue (Study S5): every live hero move in scope,
 * shuffled, each with the line that reaches it.
 *
 * Deliberately NOT the smart queue: the session is "click a chapter, go", so
 * due dates, daily budgets and the stored drill rules do not decide what is
 * shown — a card the user answers still grades through FSRS, so the daily
 * session keeps its meaning. Only the line scope is applied.
 */
import { DEFAULT_DRILL_RULES, fenTurn, isUserMove, type Color, type SrsCardDto } from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';
import { buildDrillQueue, type DrillItem } from '../drill/queue.ts';
import { emptyCardFor } from '../srs/scheduler.ts';
import { buildIndices, findPathToPosition } from '../walker/walker.ts';
import { liveReachablePositionIds } from './reachable.ts';

export interface RehearseItem extends DrillItem {
  /** SANs from the root to the card's parent position. */
  pathSans: string[];
  parentFullFen: string;
}

export interface BuildRehearseQueueArgs {
  repertoire: RepertoireFull;
  cards: SrsCardDto[];
  /** A chapter tag to scope to; omitted = the whole study. */
  chapterTag?: string;
  rng?: () => number;
  now?: Date;
}

/**
 * Every live hero move is a card, whether or not the local card store has
 * heard of it yet: a move whose server card has not been pulled gets a stub
 * `emptyCardFor` card. Grading a stub pushes by `moveId`, so it lands on the
 * real card once it exists — nothing is invented server-side.
 *
 * Only for moves whose parent is **live-reachable**: a hero move under a
 * demoted alternate is not dropped itself, but the API never cards it and no
 * path from the root reaches it — stubbing it would queue a card the board
 * cannot show.
 */
export function withStubCards(
  repertoire: RepertoireFull,
  cards: SrsCardDto[],
  now: Date = new Date(),
): SrsCardDto[] {
  const known = new Set(cards.map((c) => c.moveId));
  const positionById = new Map(repertoire.positions.map((p) => [p.id, p]));
  const reachable = liveReachablePositionIds(repertoire);
  const stubs: SrsCardDto[] = [];
  for (const m of repertoire.moves) {
    if (m.isDropped || m.isRefutation || known.has(m.id)) continue;
    if (!reachable.has(m.parentPositionId)) continue;
    const parent = positionById.get(m.parentPositionId);
    if (!parent) continue;
    if (!isUserMove(fenTurn(parent.fullFen), repertoire.color as Color)) continue;
    stubs.push(emptyCardFor(m.id, now));
  }
  return stubs.length === 0 ? cards : [...cards, ...stubs];
}

export function buildRehearseQueue(args: BuildRehearseQueueArgs): RehearseItem[] {
  const { repertoire, chapterTag, rng, now } = args;
  const cards = withStubCards(repertoire, args.cards, now);
  const scope = chapterTag ? ({ kind: 'tag', value: chapterTag } as const) : DEFAULT_DRILL_RULES.scope;
  const items = buildDrillQueue({
    repertoire,
    cards,
    mode: 'random',
    rules: { ...DEFAULT_DRILL_RULES, scope },
    ...(rng ? { rng } : {}),
    ...(now ? { now } : {}),
  });
  const indices = buildIndices(repertoire);
  const reachable = liveReachablePositionIds(repertoire);
  const prefer = chapterTag ? (m: { lineTags: string[] }) => m.lineTags.includes(chapterTag) : undefined;
  return items
    // A server card can exist on a move whose parent became unreachable later
    // (a study re-import demoted the branch above it). Same rule as the stubs.
    .filter((it) => reachable.has(it.parentPosition.id))
    .map((it) => ({
      ...it,
      pathSans: findPathToPosition(repertoire, indices, it.parentPosition.id, { prefer }).map((m) => m.san),
      parentFullFen: it.parentPosition.fullFen,
    }));
}
