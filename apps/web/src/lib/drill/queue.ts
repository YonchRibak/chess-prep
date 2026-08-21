import {
  fenTurn,
  isUserMove,
  matchesLineScope,
  mergeDrillRules,
  rankMistakes,
  type Color,
  type DrillAttemptDto,
  type DrillMode,
  type DrillRules,
  type OpeningId,
  type SrsCardDto,
} from '@chess-prep/shared';
import type { RepertoireFull, RepertoireMove, RepertoirePosition } from '../../api/client.ts';
import { buildDeepestOpeningIndex } from '../openings/pathNames.ts';

export interface DrillItem {
  card: SrsCardDto;
  move: RepertoireMove;
  parentPosition: RepertoirePosition;
  /** Ply distance from the repertoire root to the parent position. */
  depth: number;
  /**
   * Opponent's prepared response (SAN) to play immediately after the user's
   * correct move, leading naturally into the next card. Only populated in
   * `walkthrough` mode, and only when the next item in the queue follows
   * this one through one opponent ply.
   */
  opponentResponseSan?: string;
}

export interface BuildQueueArgs {
  repertoire: RepertoireFull;
  cards: SrsCardDto[];
  mode: DrillMode;
  rules: DrillRules;
  /** "Now" for due-card filtering — defaults to current time. */
  now?: Date;
  /** RNG for the 'random' mode; defaults to Math.random. */
  rng?: () => number;
  /**
   * Phase 9a: `fenKey → OpeningId` for deriving each card's opening name, used
   * only by `rules.scope.kind === 'openingName'`. Callers get one from
   * [lib/openings/nameCache.ts](../openings/nameCache.ts).
   *
   * Omitting it while an opening-name scope is active yields an EMPTY queue,
   * not an unfiltered one — a scoped session that silently widens to the whole
   * tree is indistinguishable from a correct one until the user notices they're
   * drilling the wrong opening.
   */
  openingLookup?: (fenKey: string) => OpeningId | null;
  /**
   * Phase 9d: the local drill-attempt log, required by `mode === 'mistakes'`
   * and ignored by every other mode. Omitting it yields an EMPTY mistakes queue
   * rather than a full one — "you have no recent mistakes" is a true and useful
   * answer, whereas silently degrading to "drill everything" is neither.
   */
  attempts?: readonly DrillAttemptDto[];
}

/**
 * Build a drill queue for a given mode + rules.
 * The result is the ordered list of items to present to the user.
 */
export function buildDrillQueue(args: BuildQueueArgs): DrillItem[] {
  const {
    repertoire,
    cards,
    mode,
    rules: rulesIn,
    now = new Date(),
    rng = Math.random,
    openingLookup,
    attempts,
  } = args;
  const rules = mergeDrillRules(rulesIn);
  const scope = rules.scope;
  // The name index is only built when a name scope is active — it's a full BFS
  // and every other scope kind ignores it.
  const deepestByPositionId =
    scope.kind === 'openingName'
      ? buildDeepestOpeningIndex(repertoire, openingLookup ?? (() => null))
      : null;

  // Index lookups.
  const cardByMoveId = new Map(cards.map((c) => [c.moveId, c]));
  const positionById = new Map(repertoire.positions.map((p) => [p.id, p]));
  // Phase 9d: refutation shadow lines are dropped here, before anything else
  // looks at the tree. They carry no card, so they could never become a drill
  // item — but they WOULD distort BFS depth and the walkthrough's main-line
  // walk, which follow edges rather than cards.
  const prepMoves = repertoire.moves.filter((m) => !m.isRefutation);
  const movesByParentId = new Map<string, RepertoireMove[]>();
  for (const m of prepMoves) {
    const arr = movesByParentId.get(m.parentPositionId) ?? [];
    arr.push(m);
    movesByParentId.set(m.parentPositionId, arr);
  }

  // BFS depth from the root to each position (ply count).
  const rootPosition = repertoire.positions.find((p) => p.fenKey === repertoire.rootFenKey);
  const depthByPositionId = new Map<string, number>();
  if (rootPosition) {
    const queue: Array<{ id: string; depth: number }> = [{ id: rootPosition.id, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depthByPositionId.has(id)) continue;
      depthByPositionId.set(id, depth);
      const out = movesByParentId.get(id) ?? [];
      for (const m of out) queue.push({ id: m.childPositionId, depth: depth + 1 });
    }
  }

  // Build the candidate item list, then filter by rules.
  const items: DrillItem[] = [];
  for (const m of prepMoves) {
    if (m.isDropped) continue; // Phase 7: walker skips dropped branches.
    const card = cardByMoveId.get(m.id);
    if (!card) continue;
    const parent = positionById.get(m.parentPositionId);
    if (!parent) continue;
    if (!isUserMove(fenTurn(parent.fullFen), repertoire.color as Color)) continue;

    const depth = depthByPositionId.get(parent.id) ?? 0;

    if (rules.minDepth && depth < rules.minDepth) continue;
    if (rules.maxDepth && rules.maxDepth > 0 && depth > rules.maxDepth) continue;
    if (rules.branching === 'main_line_only' && !m.isMainLine) continue;

    // Phase 9a scope. The name is taken at the move's CHILD position — the
    // card belongs to the line it creates, so a move that first enters the
    // Advance Variation is in scope for "…Advance Variation".
    if (
      !matchesLineScope(scope, {
        deepestOpening: deepestByPositionId?.get(m.childPositionId) ?? null,
        lineTags: m.lineTags ?? [],
      })
    ) {
      continue;
    }

    items.push({ card, move: m, parentPosition: parent, depth });
  }

  switch (mode) {
    case 'due': {
      const dueOnly = items.filter((it) => new Date(it.card.due) <= now);
      dueOnly.sort((a, b) => new Date(a.card.due).getTime() - new Date(b.card.due).getTime());
      return dueOnly;
    }
    case 'weak': {
      items.sort((a, b) => {
        // Most lapsed first; tiebreak by lowest stability.
        if (a.card.lapses !== b.card.lapses) return b.card.lapses - a.card.lapses;
        if (a.card.stability !== b.card.stability) return a.card.stability - b.card.stability;
        return new Date(a.card.due).getTime() - new Date(b.card.due).getTime();
      });
      return items;
    }
    case 'mistakes': {
      // Recency-weighted, and NOT filtered by due date: the point of the mode
      // is to rehearse a move the user just got wrong, which FSRS has by
      // definition scheduled for later.
      const ranked = rankMistakes(attempts ?? [], { now });
      const rankByMoveId = new Map(ranked.map((m, i) => [m.moveId, i]));
      return items
        .filter((it) => rankByMoveId.has(it.move.id))
        .sort((a, b) => rankByMoveId.get(a.move.id)! - rankByMoveId.get(b.move.id)!);
    }
    case 'random': {
      // Fisher-Yates shuffle
      const arr = items.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = tmp;
      }
      return arr;
    }
    case 'walkthrough': {
      // Walk the main line from root, emitting user-side cards as we go and
      // remembering the opponent's main-line response after each one so the
      // session can auto-play it for visual continuity.
      const path: DrillItem[] = [];
      if (!rootPosition) return path;
      const visited = new Set<string>();
      let currentId = rootPosition.id;
      let lastUserItem: DrillItem | null = null;
      while (true) {
        if (visited.has(currentId)) break;
        visited.add(currentId);
        const out = (movesByParentId.get(currentId) ?? [])
          .filter((m) => !m.isDropped)
          .sort(sortMainLineFirst);
        const next = out[0];
        if (!next) break;
        const item = items.find((it) => it.move.id === next.id);
        const parent = positionById.get(next.parentPositionId);
        // Whether this ply is the user's is a property of the position, NOT of
        // membership in `items` — a user move can be missing from `items`
        // because a rule (depth, branching, scope) filtered it out, and
        // mistaking it for an opponent reply would auto-play the user's own
        // move onto the board.
        const isUserPly = parent
          ? isUserMove(fenTurn(parent.fullFen), repertoire.color as Color)
          : false;
        if (item) {
          path.push(item);
          lastUserItem = item;
        } else if (!isUserPly && lastUserItem && lastUserItem.opponentResponseSan === undefined) {
          // First opponent move after the last user card — wire it as the
          // auto-play response so the board flows into the next card.
          lastUserItem.opponentResponseSan = next.san;
        }
        currentId = next.childPositionId;
      }
      return path;
    }
  }
}

function sortMainLineFirst(a: RepertoireMove, b: RepertoireMove): number {
  if (a.isMainLine !== b.isMainLine) return a.isMainLine ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.san.localeCompare(b.san);
}

/* ---------------- Phase 8a daily-diet queue ---------------- */

export interface DailyDietItem extends DrillItem {
  /** Which repertoire this card came from — used for interleaving and stats. */
  repertoireId: string;
  repertoireName: string;
  repertoireColor: 'white' | 'black';
}

export interface BuildDailyDietArgs {
  /** All repertoires matching the chosen side scope (white / black / mixed). */
  repertoires: RepertoireFull[];
  /** All cards across all repertoires; queue filters per rep automatically. */
  cards: SrsCardDto[];
  /** Max cards in FSRS state=new that may enter this session. Default 20. */
  newCardsPerDay?: number;
  /** "Now" for due filtering. */
  now?: Date;
  /**
   * Daily reset boundary. New cards `lastReview` after this counted as
   * "already shown today" (so a reload doesn't double-count). Defaults to
   * 24h before `now`.
   */
  dailyResetAt?: Date;
  /**
   * Phase 9a: needed only if some repertoire's rules carry an opening-name
   * scope — per-repertoire scopes are honored here too, so a scoped repertoire
   * contributes only its scoped cards to the daily diet.
   */
  openingLookup?: (fenKey: string) => OpeningId | null;
}

/**
 * Phase 8a daily-diet queue: per-repertoire FSRS-due queues unioned and
 * **interleaved by repertoire** (round-robin) so consecutive cards typically
 * come from different openings. Caps new-state cards at `newCardsPerDay`
 * (counted as "would be new today" = state==0 AND lastReview <= dailyResetAt).
 *
 * - Refactored on top of `buildDrillQueue` ("due" mode) — single source of
 *   truth for per-rep filtering, deepest/branching rules, dropped-move skips.
 * - Round-robin (rather than pure shuffle) so the user feels mode-switching
 *   between openings rather than spotty repetition.
 */
export function buildDailyDietQueue(args: BuildDailyDietArgs): DailyDietItem[] {
  const {
    repertoires,
    cards,
    newCardsPerDay = 20,
    now = new Date(),
    dailyResetAt = new Date(now.getTime() - 24 * 60 * 60 * 1000),
    openingLookup,
  } = args;

  // Per-repertoire "due" queues, each already filtered by the per-rep drill rules.
  const perRep: DailyDietItem[][] = [];
  for (const rep of repertoires) {
    const repCards = cards; // queue filters by moveId membership internally
    const items = buildDrillQueue({
      repertoire: rep,
      cards: repCards,
      mode: 'due',
      rules: rep.drillRules,
      now,
      openingLookup,
    });
    perRep.push(
      items.map<DailyDietItem>((it) => ({
        ...it,
        repertoireId: rep.id,
        repertoireName: rep.name,
        repertoireColor: rep.color as 'white' | 'black',
      })),
    );
  }

  // Apply new-card cap across the WHOLE diet: count cards already shown today
  // (state==0 AND lastReview AFTER the reset boundary) as already consumed.
  const consumedToday = cards.filter(
    (c) =>
      c.state === 0 &&
      c.lastReview != null &&
      new Date(c.lastReview).getTime() > dailyResetAt.getTime(),
  ).length;
  let newBudget = Math.max(0, newCardsPerDay - consumedToday);

  // Filter each per-rep queue to stay under the new-card budget; non-new
  // (learning/review/relearning) cards are unconditionally included.
  const filtered: DailyDietItem[][] = perRep.map((items) => {
    const kept: DailyDietItem[] = [];
    for (const it of items) {
      const isNew = it.card.state === 0;
      if (!isNew) {
        kept.push(it);
        continue;
      }
      if (newBudget > 0) {
        newBudget--;
        kept.push(it);
      }
    }
    return kept;
  });

  // Round-robin interleave so consecutive cards alternate repertoires.
  // Within a rep, items keep their per-rep order (oldest-due first).
  const out: DailyDietItem[] = [];
  const cursors = filtered.map(() => 0);
  let exhausted = false;
  while (!exhausted) {
    exhausted = true;
    for (let i = 0; i < filtered.length; i++) {
      const arr = filtered[i]!;
      const c = cursors[i]!;
      if (c < arr.length) {
        out.push(arr[c]!);
        cursors[i] = c + 1;
        exhausted = false;
      }
    }
  }
  return out;
}
