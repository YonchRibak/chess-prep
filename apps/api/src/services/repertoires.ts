import { and, eq, inArray, ne } from 'drizzle-orm';
import { Chess } from 'chess.js';
import {
  fenKey as makeFenKey,
  fenTurn,
  inheritLineTags,
  isUserMove,
  MAX_REFUTATION_PLIES,
  parseLineScope,
  pgnToTree,
  treeToPgn,
  STARTING_FEN,
  STARTING_FEN_KEY,
  type Color,
  type DrillRules,
  type FenKey,
  type RepertoireTree,
  type TreeMoveInput,
} from '@chess-prep/shared';
import { db } from '../db/client.js';
import { moves, positions, repertoires, srsCards } from '../db/schema.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RepertoireSummary {
  id: string;
  name: string;
  color: Color;
  tags: string[];
  drillRules: DrillRules;
  /** Phase 9c: silently auto-expand opponent replies while building. */
  autoExpand: boolean;
  rootFenKey: string;
  rootFullFen: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepertoireFull extends RepertoireSummary {
  positions: { id: string; fenKey: string; fullFen: string }[];
  moves: {
    id: string;
    parentPositionId: string;
    childPositionId: string;
    parentFenKey: string;
    childFenKey: string;
    san: string;
    uci: string;
    comment: string | null;
    annotation: string | null;
    isMainLine: boolean;
    priority: number;
    isDropped: boolean;
    lineTags: string[];
    isRefutation: boolean;
  }[];
}

const ALLOWED_COLORS: ReadonlySet<Color> = new Set(['white', 'black']);

function ensureColor(c: unknown): Color {
  if (typeof c !== 'string' || !ALLOWED_COLORS.has(c as Color)) {
    throw new HttpError(400, 'color must be "white" or "black"');
  }
  return c as Color;
}

function ensureNonEmptyName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new HttpError(400, 'name is required');
  }
  if (name.length > 200) throw new HttpError(400, 'name too long (max 200)');
  return name.trim();
}

export async function listRepertoires(userId: string): Promise<RepertoireSummary[]> {
  const rows = await db
    .select()
    .from(repertoires)
    .where(eq(repertoires.userId, userId))
    .orderBy(repertoires.updatedAt);
  return rows.map(toSummary);
}

export async function createRepertoire(
  userId: string,
  input: {
    name: unknown;
    color: unknown;
    tags?: unknown;
    rootFen?: unknown;
    /**
     * Phase 7 "guided builder" seed: a list of SAN moves to auto-insert from
     * the root position as soon as the repertoire is created. Used for the
     * opening-grounded "New repertoire" flow — e.g. picking "French Defense"
     * seeds `['e4','e6']`. Each user-side move in the seed prefix also gets
     * an SRS card.
     */
    seedSans?: unknown;
  },
): Promise<RepertoireSummary> {
  const name = ensureNonEmptyName(input.name);
  const color = ensureColor(input.color);
  const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : [];
  const rootFullFen = typeof input.rootFen === 'string' && input.rootFen ? input.rootFen : STARTING_FEN;
  const rootFenKey = makeFenKey(rootFullFen);

  let seedSans: string[] = [];
  if (input.seedSans !== undefined) {
    if (!Array.isArray(input.seedSans) || input.seedSans.some((s) => typeof s !== 'string')) {
      throw new HttpError(400, 'seedSans must be an array of strings');
    }
    seedSans = input.seedSans as string[];
  }

  return await db.transaction(async (tx) => {
    const [rep] = await tx
      .insert(repertoires)
      .values({ userId, name, color, tags, rootFenKey, rootFullFen })
      .returning();
    if (!rep) throw new HttpError(500, 'Failed to create repertoire');

    // Always seed the root position.
    const [rootPos] = await tx
      .insert(positions)
      .values({
        repertoireId: rep.id,
        fenKey: rootFenKey,
        fullFen: rootFullFen,
      })
      .returning();
    if (!rootPos) throw new HttpError(500, 'Failed to create root position');

    // Phase 7: auto-insert the chosen opening's canonical move sequence so
    // the build session opens at the position after the prefix with cards
    // already created for the user-side moves in it.
    if (seedSans.length > 0) {
      await appendLineCore(tx, {
        userId,
        repertoire: { id: rep.id, color: rep.color as Color },
        fromPosition: { id: rootPos.id, fenKey: rootPos.fenKey, fullFen: rootPos.fullFen },
        sans: seedSans,
        onConflict: 'refuse',
      });
    }

    return toSummary(rep);
  });
}

export async function getRepertoire(userId: string, id: string): Promise<RepertoireFull> {
  const rep = await db.query.repertoires.findFirst({
    where: and(eq(repertoires.id, id), eq(repertoires.userId, userId)),
  });
  if (!rep) throw new HttpError(404, 'Repertoire not found');

  const posRows = await db.select().from(positions).where(eq(positions.repertoireId, id));
  const moveRows = await db.select().from(moves).where(eq(moves.repertoireId, id));

  const fenByPosId = new Map(posRows.map((p) => [p.id, p.fenKey]));

  return {
    ...toSummary(rep),
    positions: posRows.map((p) => ({ id: p.id, fenKey: p.fenKey, fullFen: p.fullFen })),
    moves: moveRows.map((m) => ({
      id: m.id,
      parentPositionId: m.parentPositionId,
      childPositionId: m.childPositionId,
      parentFenKey: fenByPosId.get(m.parentPositionId) ?? '',
      childFenKey: fenByPosId.get(m.childPositionId) ?? '',
      san: m.san,
      uci: m.uci,
      comment: m.comment,
      annotation: m.annotation,
      isMainLine: m.isMainLine,
      priority: m.priority,
      isDropped: m.isDropped,
      lineTags: m.lineTags,
      isRefutation: m.isRefutation,
    })),
  };
}

export async function patchRepertoire(
  userId: string,
  id: string,
  input: { name?: unknown; tags?: unknown; autoExpand?: unknown },
): Promise<RepertoireSummary> {
  const update: Partial<{ name: string; tags: string[]; autoExpand: boolean; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (input.autoExpand !== undefined) update.autoExpand = Boolean(input.autoExpand);
  if (input.name !== undefined) update.name = ensureNonEmptyName(input.name);
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw new HttpError(400, 'tags must be an array of strings');
    update.tags = input.tags.filter((t): t is string => typeof t === 'string');
  }

  const [row] = await db
    .update(repertoires)
    .set(update)
    .where(and(eq(repertoires.id, id), eq(repertoires.userId, userId)))
    .returning();
  if (!row) throw new HttpError(404, 'Repertoire not found');
  return toSummary(row);
}

export async function deleteRepertoire(userId: string, id: string): Promise<void> {
  const result = await db
    .delete(repertoires)
    .where(and(eq(repertoires.id, id), eq(repertoires.userId, userId)))
    .returning({ id: repertoires.id });
  if (result.length === 0) throw new HttpError(404, 'Repertoire not found');
}

/**
 * Delete every repertoire this user owns, in one statement.
 *
 * A single `DELETE ... WHERE user_id = $1` rather than a loop over
 * `deleteRepertoire`, so the wipe is atomic: a loop that fails on repertoire 7
 * of 12 leaves the user staring at a half-deleted list with no way to tell
 * which half went. Positions, moves and SRS cards all cascade from the
 * repertoire row (see the schema's `onDelete: 'cascade'`).
 *
 * Returns the count so the UI can report what actually happened instead of
 * assuming the list it rendered was current.
 */
export async function deleteAllRepertoires(userId: string): Promise<{ deleted: number }> {
  const rows = await db
    .delete(repertoires)
    .where(eq(repertoires.userId, userId))
    .returning({ id: repertoires.id });
  return { deleted: rows.length };
}

/* ---------------- moves ---------------- */

export interface AddedMove {
  id: string;
  parentPositionId: string;
  childPositionId: string;
  parentFenKey: string;
  childFenKey: string;
  san: string;
  uci: string;
  isMainLine: boolean;
  priority: number;
  comment: string | null;
  annotation: string | null;
  isDropped: boolean;
  lineTags: string[];
  isRefutation: boolean;
  /** True if this call also created a new position node (vs. linking to existing). */
  childPositionCreated: boolean;
}

export async function addMove(
  userId: string,
  repertoireId: string,
  input: {
    parentFenKey: unknown;
    san: unknown;
    isMainLine?: unknown;
    onConflict?: unknown;
    lineTags?: unknown;
  },
): Promise<AddedMove> {
  if (typeof input.parentFenKey !== 'string') throw new HttpError(400, 'parentFenKey is required');
  if (typeof input.san !== 'string') throw new HttpError(400, 'san is required');
  const onConflict = parseOnConflict(input.onConflict);
  const explicitTags = parseLineTags(input.lineTags);

  return await db.transaction(async (tx) => {
    // 1. Verify repertoire ownership and grab root for context.
    const rep = await tx.query.repertoires.findFirst({
      where: and(eq(repertoires.id, repertoireId), eq(repertoires.userId, userId)),
    });
    if (!rep) throw new HttpError(404, 'Repertoire not found');

    // 2. Find parent position.
    const parent = await tx.query.positions.findFirst({
      where: and(
        eq(positions.repertoireId, repertoireId),
        eq(positions.fenKey, input.parentFenKey as string),
      ),
    });
    if (!parent) throw new HttpError(400, 'Parent position is not in this repertoire');

    // 3. Apply move via chess.js to compute SAN + child FEN.
    const chess = new Chess(parent.fullFen);
    let moveObj;
    try {
      moveObj = chess.move(input.san as string);
    } catch {
      throw new HttpError(400, `Illegal move "${input.san}" at position ${parent.fenKey}`);
    }
    if (!moveObj) {
      throw new HttpError(400, `Illegal move "${input.san}" at position ${parent.fenKey}`);
    }
    const childFullFen = chess.fen();
    const childFenKey = makeFenKey(childFullFen);

    // 4. Find or create child position.
    let childPositionCreated = false;
    let child = await tx.query.positions.findFirst({
      where: and(
        eq(positions.repertoireId, repertoireId),
        eq(positions.fenKey, childFenKey),
      ),
    });
    if (!child) {
      const [created] = await tx
        .insert(positions)
        .values({ repertoireId, fenKey: childFenKey, fullFen: childFullFen })
        .returning();
      if (!created) throw new HttpError(500, 'Failed to create position');
      child = created;
      childPositionCreated = true;
    }

    // 5. v1 invariant (see PROJECT_SPEC §4 + §7): at most one user-side prep
    //    Move per user-turn parent position. Enforce here in case the caller
    //    is trying to add a *different* SAN where a prep already exists.
    if (isUserMove(fenTurn(parent.fullFen), rep.color as Color)) {
      await enforceOnePrepPerUserPosition(tx, repertoireId, parent.id, moveObj.san, onConflict);
    }

    // 6. Insert or fetch the move (unique on parent + san).
    const isMainLine = Boolean(input.isMainLine ?? false);
    const lineTags = inheritLineTags(
      await parentEdgeTags(tx, repertoireId, parent.id),
      explicitTags,
    );
    const inserted = await tx
      .insert(moves)
      .values({
        repertoireId,
        parentPositionId: parent.id,
        childPositionId: child.id,
        san: moveObj.san,
        uci: moveObj.from + moveObj.to + (moveObj.promotion ?? ''),
        isMainLine,
        priority: 0,
        lineTags,
      })
      .onConflictDoNothing()
      .returning();

    let moveRow = inserted[0];
    if (!moveRow) {
      // Already existed — fetch it.
      moveRow = await tx.query.moves.findFirst({
        where: and(
          eq(moves.repertoireId, repertoireId),
          eq(moves.parentPositionId, parent.id),
          eq(moves.san, moveObj.san),
        ),
      });
      if (!moveRow) throw new HttpError(500, 'Move insert+fetch race');
      // Adding a move by hand is always a prep write, so a shadow edge here is
      // being promoted (see promoteIfShadowed).
      moveRow = await promoteIfShadowed(tx, moveRow, false, {
        userId,
        color: rep.color as Color,
        parentFullFen: parent.fullFen,
      });
    }

    // 7. Auto-create an SRS card if this move is one the user plays.
    if (isUserMove(fenTurn(parent.fullFen), rep.color as Color)) {
      await tx
        .insert(srsCards)
        .values({
          userId,
          moveId: moveRow.id,
          due: new Date(),
        })
        .onConflictDoNothing();
    }

    // Bump updatedAt
    await tx.update(repertoires).set({ updatedAt: new Date() }).where(eq(repertoires.id, repertoireId));

    return {
      id: moveRow.id,
      parentPositionId: parent.id,
      childPositionId: child.id,
      parentFenKey: parent.fenKey,
      childFenKey,
      san: moveRow.san,
      uci: moveRow.uci,
      isMainLine: moveRow.isMainLine,
      priority: moveRow.priority,
      comment: moveRow.comment,
      annotation: moveRow.annotation,
      isDropped: moveRow.isDropped,
      lineTags: moveRow.lineTags,
      isRefutation: moveRow.isRefutation,
      childPositionCreated,
    };
  });
}

/**
 * Append a sequence of SAN moves to a repertoire starting from a known parent
 * position, in one transaction. Idempotent: any (parent, san) edge that
 * already exists is reused, not duplicated. Used by the Phase 6 "Add to my
 * repertoire" flow AND the Phase 7 guided builder. New SRS cards are created
 * for any newly-inserted move where it's the user's turn at the parent.
 *
 * **One prep per user-turn position** (v1 application-level invariant; see
 * PROJECT_SPEC §4 + §7). When the next SAN would create a *new* user-side
 * Move at a parent that already has a different user-side Move:
 *   - `onConflict: 'refuse'` (default) → throw 409. Safe for idempotent flows
 *     like the Phase 6 "Add to my repertoire" reuse path.
 *   - `onConflict: 'swap'` → delete the old user-side Move (cascade drops its
 *     SrsCard, per spec — SRS history is NOT preserved through a swap in v1)
 *     before inserting the new one. Used when the user explicitly changes a
 *     prep move.
 */
export async function appendLine(
  userId: string,
  repertoireId: string,
  input: { fromFenKey: unknown; sans: unknown; onConflict?: unknown; lineTags?: unknown },
): Promise<{ added: number; reused: number; finalFenKey: string }> {
  if (typeof input.fromFenKey !== 'string') throw new HttpError(400, 'fromFenKey is required');
  if (!Array.isArray(input.sans) || input.sans.some((s) => typeof s !== 'string')) {
    throw new HttpError(400, 'sans must be an array of strings');
  }
  const sans = input.sans as string[];
  const onConflict = parseOnConflict(input.onConflict);
  const explicitTags = parseLineTags(input.lineTags);

  return await db.transaction(async (tx) => {
    const rep = await tx.query.repertoires.findFirst({
      where: and(eq(repertoires.id, repertoireId), eq(repertoires.userId, userId)),
    });
    if (!rep) throw new HttpError(404, 'Repertoire not found');

    const initial = await tx.query.positions.findFirst({
      where: and(eq(positions.repertoireId, repertoireId), eq(positions.fenKey, input.fromFenKey as string)),
    });
    if (!initial) {
      throw new HttpError(400, 'fromFenKey is not in this repertoire');
    }

    const result = await appendLineCore(tx, {
      userId,
      repertoire: { id: rep.id, color: rep.color as Color },
      fromPosition: { id: initial.id, fenKey: initial.fenKey, fullFen: initial.fullFen },
      sans,
      onConflict,
      lineTags: explicitTags,
    });

    if (result.added > 0) {
      await tx.update(repertoires).set({ updatedAt: new Date() }).where(eq(repertoires.id, repertoireId));
    }
    return result;
  });
}

/**
 * Phase 9d: store a refutation shadow line — the engine's punishment of a move
 * the user played by mistake, a few plies deep, starting from the position the
 * mistake was made in.
 *
 * The whole point of the feature is what it does *not* do: no SRS card is
 * created for any move it inserts, the one-prep invariant is neither consulted
 * nor enforced, and every consumer (walker build seed, both queue builders,
 * PGN export) filters `isRefutation` out. If a shadow line ever produces a
 * card, this feature is wrong — see the test in repertoires.invariant.test.ts.
 *
 * Idempotent like `appendLine`: re-saving the same refutation reuses its edges.
 * Existing prep edges along the path are reused **as prep** and never demoted.
 */
export async function appendRefutation(
  userId: string,
  repertoireId: string,
  input: { fromFenKey: unknown; sans: unknown },
): Promise<{ added: number; reused: number; finalFenKey: string }> {
  if (typeof input.fromFenKey !== 'string') throw new HttpError(400, 'fromFenKey is required');
  if (!Array.isArray(input.sans) || input.sans.some((s) => typeof s !== 'string')) {
    throw new HttpError(400, 'sans must be an array of strings');
  }
  const sans = input.sans as string[];
  if (sans.length === 0) throw new HttpError(400, 'sans must not be empty');
  if (sans.length > MAX_REFUTATION_PLIES) {
    throw new HttpError(400, `A refutation is at most ${MAX_REFUTATION_PLIES} plies`);
  }

  return await db.transaction(async (tx) => {
    const rep = await tx.query.repertoires.findFirst({
      where: and(eq(repertoires.id, repertoireId), eq(repertoires.userId, userId)),
    });
    if (!rep) throw new HttpError(404, 'Repertoire not found');

    const initial = await tx.query.positions.findFirst({
      where: and(
        eq(positions.repertoireId, repertoireId),
        eq(positions.fenKey, input.fromFenKey as string),
      ),
    });
    if (!initial) throw new HttpError(400, 'fromFenKey is not in this repertoire');

    const result = await appendLineCore(tx, {
      userId,
      repertoire: { id: rep.id, color: rep.color as Color },
      fromPosition: { id: initial.id, fenKey: initial.fenKey, fullFen: initial.fullFen },
      sans,
      onConflict: 'refuse',
      isRefutation: true,
    });

    if (result.added > 0) {
      await tx
        .update(repertoires)
        .set({ updatedAt: new Date() })
        .where(eq(repertoires.id, repertoireId));
    }
    return result;
  });
}

export async function patchMove(
  userId: string,
  repertoireId: string,
  moveId: string,
  input: {
    comment?: unknown;
    annotation?: unknown;
    isMainLine?: unknown;
    priority?: unknown;
    isDropped?: unknown;
    lineTags?: unknown;
  },
): Promise<void> {
  // Verify ownership via join: look up the move and check the repertoire.
  const move = await db.query.moves.findFirst({
    where: and(eq(moves.id, moveId), eq(moves.repertoireId, repertoireId)),
  });
  if (!move) throw new HttpError(404, 'Move not found');

  const rep = await db.query.repertoires.findFirst({
    where: and(eq(repertoires.id, repertoireId), eq(repertoires.userId, userId)),
  });
  if (!rep) throw new HttpError(404, 'Repertoire not found');

  const update: Partial<{
    comment: string | null;
    annotation: string | null;
    isMainLine: boolean;
    priority: number;
    isDropped: boolean;
  }> = {};

  if (input.comment !== undefined) {
    update.comment = typeof input.comment === 'string' ? input.comment : null;
  }
  if (input.annotation !== undefined) {
    update.annotation = typeof input.annotation === 'string' ? input.annotation : null;
  }
  if (input.isMainLine !== undefined) update.isMainLine = Boolean(input.isMainLine);
  if (input.priority !== undefined) {
    const p = Number(input.priority);
    if (!Number.isFinite(p)) throw new HttpError(400, 'priority must be a number');
    update.priority = Math.trunc(p);
  }
  if (input.isDropped !== undefined) update.isDropped = Boolean(input.isDropped);

  // Phase 9a: retagging an edge re-roots inheritance, so it cascades to the
  // subtree below (see retagSubtree) — a tag on the branch point alone would
  // scope a session down to a single move.
  const newTags = input.lineTags === undefined ? undefined : parseLineTags(input.lineTags) ?? [];

  if (Object.keys(update).length === 0 && newTags === undefined) return;
  await db.transaction(async (tx) => {
    if (Object.keys(update).length > 0) {
      await tx.update(moves).set(update).where(eq(moves.id, moveId));
    }
    if (newTags !== undefined) {
      await retagSubtree(tx, repertoireId, move, newTags);
    }
    await tx
      .update(repertoires)
      .set({ updatedAt: new Date() })
      .where(eq(repertoires.id, repertoireId));
  });
}

export async function deleteMove(userId: string, repertoireId: string, moveId: string): Promise<void> {
  const rep = await db.query.repertoires.findFirst({
    where: and(eq(repertoires.id, repertoireId), eq(repertoires.userId, userId)),
  });
  if (!rep) throw new HttpError(404, 'Repertoire not found');

  const result = await db
    .delete(moves)
    .where(and(eq(moves.id, moveId), eq(moves.repertoireId, repertoireId)))
    .returning({ id: moves.id });
  if (result.length === 0) throw new HttpError(404, 'Move not found');

  await db.update(repertoires).set({ updatedAt: new Date() }).where(eq(repertoires.id, repertoireId));
}

/* ---------------- PGN import/export ---------------- */

export async function importPgn(
  userId: string,
  input: { name: unknown; color: unknown; pgn: unknown; tags?: unknown; startFen?: unknown },
): Promise<RepertoireFull> {
  const name = ensureNonEmptyName(input.name);
  const color = ensureColor(input.color);
  const pgn = typeof input.pgn === 'string' && input.pgn.trim() ? input.pgn : null;
  if (!pgn) throw new HttpError(400, 'pgn is required');
  const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : [];
  const startFen = typeof input.startFen === 'string' ? input.startFen : undefined;

  let tree: RepertoireTree;
  try {
    tree = pgnToTree(pgn, startFen ? { startFen } : undefined);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }

  return await db.transaction(async (tx) => {
    const [rep] = await tx
      .insert(repertoires)
      .values({
        userId,
        name,
        color,
        tags,
        rootFenKey: tree.rootFenKey,
        rootFullFen: tree.rootFullFen,
      })
      .returning();
    if (!rep) throw new HttpError(500, 'Failed to create repertoire');

    // Bulk insert positions, then map fenKey → id.
    const posInserts = tree.positions.map((p) => ({
      repertoireId: rep.id,
      fenKey: p.fenKey,
      fullFen: p.fullFen,
    }));
    const insertedPositions = posInserts.length
      ? await tx.insert(positions).values(posInserts).returning({ id: positions.id, fenKey: positions.fenKey })
      : [];
    const posIdByKey = new Map(insertedPositions.map((p) => [p.fenKey as FenKey, p.id]));

    // Bulk insert moves.
    const fenFullByKey = new Map(tree.positions.map((p) => [p.fenKey, p.fullFen]));
    const moveInserts = tree.moves
      .map((m) => {
        const parentId = posIdByKey.get(m.parentFenKey);
        const childId = posIdByKey.get(m.childFenKey);
        if (!parentId || !childId) return null;
        return {
          repertoireId: rep.id,
          parentPositionId: parentId,
          childPositionId: childId,
          san: m.san,
          uci: m.uci,
          comment: m.comment,
          annotation: m.annotation,
          isMainLine: m.isMainLine,
          priority: m.priority,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const insertedMoves = moveInserts.length
      ? await tx
          .insert(moves)
          .values(moveInserts)
          .returning({
            id: moves.id,
            parentPositionId: moves.parentPositionId,
          })
      : [];

    // Bulk-create SRS cards for moves where it's the user's turn at the parent.
    if (insertedMoves.length) {
      const parentFullFenById = new Map<string, string>();
      for (const m of insertedMoves) {
        const parentFen = positionFenById(posInserts, insertedPositions, m.parentPositionId, fenFullByKey);
        if (parentFen) parentFullFenById.set(m.parentPositionId, parentFen);
      }
      const cardInserts = insertedMoves
        .filter((m) => {
          const fen = parentFullFenById.get(m.parentPositionId);
          return fen ? isUserMove(fenTurn(fen), color) : false;
        })
        .map((m) => ({
          userId,
          moveId: m.id,
          due: new Date(),
        }));
      if (cardInserts.length) {
        await tx.insert(srsCards).values(cardInserts).onConflictDoNothing();
      }
    }

    // Re-fetch the full repertoire via the same path used by GET.
    return await getRepertoireWithTx(tx, userId, rep.id);
  });
}

function positionFenById(
  posInserts: Array<{ fenKey: string; fullFen: string }>,
  insertedPositions: Array<{ id: string; fenKey: string }>,
  positionId: string,
  fenFullByKey: Map<string, string>,
): string | null {
  const ip = insertedPositions.find((p) => p.id === positionId);
  if (!ip) return null;
  return fenFullByKey.get(ip.fenKey) ?? null;
}

export async function patchDrillRules(
  userId: string,
  id: string,
  rules: unknown,
): Promise<RepertoireSummary> {
  if (!rules || typeof rules !== 'object') {
    throw new HttpError(400, 'drillRules must be an object');
  }
  // Rules are stored as opaque partial jsonb, but a malformed `scope` would
  // only surface later as a session that silently drills the wrong set — so
  // validate that one field on the way in.
  let normalized = rules as DrillRules;
  try {
    const scope = parseLineScope((rules as DrillRules).scope);
    if (scope) normalized = { ...normalized, scope };
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const [row] = await db
    .update(repertoires)
    .set({ drillRules: normalized, updatedAt: new Date() })
    .where(and(eq(repertoires.id, id), eq(repertoires.userId, userId)))
    .returning();
  if (!row) throw new HttpError(404, 'Repertoire not found');
  return toSummary(row);
}

export async function exportPgn(userId: string, repertoireId: string): Promise<string> {
  const full = await getRepertoire(userId, repertoireId);
  const tree: RepertoireTree = {
    rootFenKey: full.rootFenKey as FenKey,
    rootFullFen: full.rootFullFen,
    positions: full.positions.map((p) => ({ fenKey: p.fenKey as FenKey, fullFen: p.fullFen })),
    // Phase 9d: shadow lines are the engine's punishment of *mistakes*, not
    // prep — exporting them would put moves the user never intends to play
    // into their PGN, and a re-import would turn them into real branches.
    moves: full.moves
      .filter((m) => !m.isRefutation)
      .map<TreeMoveInput>((m) => ({
        parentFenKey: m.parentFenKey as FenKey,
        childFenKey: m.childFenKey as FenKey,
        san: m.san,
        uci: m.uci,
        comment: m.comment,
        annotation: m.annotation,
        isMainLine: m.isMainLine,
        priority: m.priority,
      })),
  };
  return treeToPgn(tree, {
    headers: {
      Event: 'Chess Prep repertoire',
      White: full.color === 'white' ? full.name : '?',
      Black: full.color === 'black' ? full.name : '?',
      Result: '*',
    },
  });
}

/* ---------------- helpers ---------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type OnConflict = 'refuse' | 'swap';

/**
 * Explicit `line_tags` from a request body. `undefined` means "inherit"; an
 * empty array means "clear inheritance here" — the two are deliberately not the
 * same thing.
 */
function parseLineTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) {
    throw new HttpError(400, 'lineTags must be an array of strings');
  }
  return inheritLineTags(null, raw as string[]);
}

function parseOnConflict(raw: unknown): OnConflict {
  if (raw === undefined || raw === null) return 'refuse';
  if (raw === 'refuse' || raw === 'swap') return raw;
  throw new HttpError(400, "onConflict must be 'refuse' or 'swap'");
}

/**
 * Phase 7 invariant: at most ONE user-side prep Move per user-turn parent
 * position. If a different SAN already exists at this parent, either refuse
 * (default) or delete it before inserting (swap).
 *
 * Only call when the parent's side-to-move IS the rep's color — opponent-turn
 * positions are allowed multiple Moves (the user picks which responses to
 * prepare against).
 */
async function enforceOnePrepPerUserPosition(
  tx: Tx,
  repertoireId: string,
  parentPositionId: string,
  newSan: string,
  onConflict: OnConflict,
): Promise<void> {
  const conflicting = await tx.query.moves.findFirst({
    where: and(
      eq(moves.repertoireId, repertoireId),
      eq(moves.parentPositionId, parentPositionId),
      ne(moves.san, newSan),
      // Phase 9d: a refutation shadow line is not prep and never holds the one
      // prep slot. Counting one here would 409 the user out of prepping a
      // position simply because they once played the wrong move there.
      eq(moves.isRefutation, false),
    ),
  });
  if (!conflicting) return;
  if (onConflict === 'refuse') {
    throw new HttpError(
      409,
      `A prep move already exists at this position (${conflicting.san}). ` +
        `One prep per user-turn position. Use onConflict='swap' to replace.`,
    );
  }
  // swap: cascade drops the old SrsCard so the new move starts FSRS state=new
  await tx.delete(moves).where(eq(moves.id, conflicting.id));
}

/**
 * Phase 9d: a prep write that lands on an existing refutation shadow edge
 * promotes it to real prep — and, where it is the user's turn, gives it the
 * SRS card it was denied while it was only a shadow.
 *
 * The asymmetry is deliberate. Shadow → prep is a decision the user just made
 * ("that punishment line is actually what I want to play"); prep → shadow would
 * silently strip a card the user has SRS history on, so a refutation walk that
 * crosses existing prep leaves it untouched.
 */
async function promoteIfShadowed<T extends { id: string; isRefutation: boolean }>(
  tx: Tx,
  moveRow: T,
  writingAsRefutation: boolean,
  prep: { userId: string; color: Color; parentFullFen: string },
): Promise<T> {
  if (writingAsRefutation || !moveRow.isRefutation) return moveRow;
  await tx.update(moves).set({ isRefutation: false }).where(eq(moves.id, moveRow.id));
  if (isUserMove(fenTurn(prep.parentFullFen), prep.color)) {
    await tx
      .insert(srsCards)
      .values({ userId: prep.userId, moveId: moveRow.id, due: new Date() })
      .onConflictDoNothing();
  }
  return { ...moveRow, isRefutation: false };
}

/**
 * Phase 9a: the `line_tags` a move inserted at `parentPositionId` should
 * inherit — the tags of the edge leading *into* that parent.
 *
 * A position can have several incoming edges (transpositions collapse to one
 * node), so the choice is made deterministic: main line first, then priority,
 * then SAN. Picking arbitrarily would make the same build action produce
 * different tags on different runs, which is exactly the kind of silent drift
 * scopes exist to avoid.
 */
async function parentEdgeTags(
  tx: Tx,
  repertoireId: string,
  parentPositionId: string,
): Promise<string[]> {
  const incoming = await tx
    .select({
      lineTags: moves.lineTags,
      isMainLine: moves.isMainLine,
      priority: moves.priority,
      san: moves.san,
    })
    .from(moves)
    .where(
      and(eq(moves.repertoireId, repertoireId), eq(moves.childPositionId, parentPositionId)),
    );
  if (incoming.length === 0) return []; // the root has no incoming edge.
  incoming.sort((a, b) => {
    if (a.isMainLine !== b.isMainLine) return a.isMainLine ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.san.localeCompare(b.san);
  });
  return incoming[0]!.lineTags ?? [];
}

/**
 * Retagging an existing edge re-roots inheritance, so the tags must be pushed
 * down the live subtree — otherwise tagging a branch point after the fact tags
 * exactly one move and a tag-scoped session drills that one move.
 *
 * Walks live *and* dropped edges: a dropped branch can be un-dropped later, and
 * finding it untagged then would be the same silent gap.
 */
async function retagSubtree(
  tx: Tx,
  repertoireId: string,
  rootMove: { id: string; childPositionId: string },
  tags: string[],
): Promise<void> {
  const all = await tx
    .select({
      id: moves.id,
      parentPositionId: moves.parentPositionId,
      childPositionId: moves.childPositionId,
    })
    .from(moves)
    .where(eq(moves.repertoireId, repertoireId));
  const byParent = new Map<string, typeof all>();
  for (const m of all) {
    const arr = byParent.get(m.parentPositionId) ?? [];
    arr.push(m);
    byParent.set(m.parentPositionId, arr);
  }

  const ids = [rootMove.id];
  const seenPositions = new Set<string>([rootMove.childPositionId]);
  const queue = [rootMove.childPositionId];
  while (queue.length > 0) {
    const posId = queue.shift()!;
    for (const m of byParent.get(posId) ?? []) {
      ids.push(m.id);
      if (seenPositions.has(m.childPositionId)) continue; // cycle via transposition
      seenPositions.add(m.childPositionId);
      queue.push(m.childPositionId);
    }
  }
  await tx.update(moves).set({ lineTags: tags }).where(inArray(moves.id, ids));
}

interface AppendLineCoreParams {
  userId: string;
  repertoire: { id: string; color: Color };
  fromPosition: { id: string; fenKey: string; fullFen: string };
  sans: string[];
  onConflict: OnConflict;
  /**
   * Phase 9a: tags for every move this call inserts. When omitted, each new
   * move inherits from the edge above it, so appending inside a tagged branch
   * keeps the branch's tags without the caller having to know them.
   */
  lineTags?: string[];
  /**
   * Phase 9d: insert this line as a refutation shadow line — stored, but never
   * prep. No SRS card is created for any move in it (not even where it is the
   * user's turn), and the one-prep-per-user-position invariant does not apply,
   * because a refutation is not a prep move competing for that slot.
   */
  isRefutation?: boolean;
}

/**
 * Core append-line walk, runs inside a caller-provided transaction so the
 * "create rep + seed opening prefix" path can stay atomic. Caller is
 * responsible for bumping `repertoires.updatedAt`.
 */
async function appendLineCore(
  tx: Tx,
  params: AppendLineCoreParams,
): Promise<{ added: number; reused: number; finalFenKey: string }> {
  type PositionRow = { id: string; fenKey: string; fullFen: string; repertoireId: string };

  let cursor: PositionRow = { ...params.fromPosition, repertoireId: params.repertoire.id };
  let cursorFenKey = cursor.fenKey;
  let added = 0;
  let reused = 0;
  // Tags carried down the line: seeded from the edge into `fromPosition` (or
  // replaced wholesale when the caller supplied its own), then threaded
  // through the walk so each new move inherits from the one just inserted.
  let inheritedTags = inheritLineTags(
    await parentEdgeTags(tx, params.repertoire.id, params.fromPosition.id),
    params.lineTags,
  );

  for (const san of params.sans) {
    const chess = new Chess(cursor.fullFen);
    let moveObj;
    try {
      moveObj = chess.move(san);
    } catch {
      throw new HttpError(400, `Illegal move "${san}" at ${cursor.fenKey}`);
    }
    if (!moveObj) throw new HttpError(400, `Illegal move "${san}" at ${cursor.fenKey}`);
    const childFullFen: string = chess.fen();
    const childFenKey = makeFenKey(childFullFen);

    // Find or create child position.
    const existingChild = await tx.query.positions.findFirst({
      where: and(
        eq(positions.repertoireId, params.repertoire.id),
        eq(positions.fenKey, childFenKey),
      ),
    });
    let child: PositionRow;
    if (existingChild) {
      child = existingChild;
    } else {
      const [created] = await tx
        .insert(positions)
        .values({ repertoireId: params.repertoire.id, fenKey: childFenKey, fullFen: childFullFen })
        .returning();
      if (!created) throw new HttpError(500, 'Failed to create position');
      child = created;
    }

    const asRefutation = params.isRefutation === true;
    const isUserSidePrep =
      !asRefutation && isUserMove(fenTurn(cursor.fullFen), params.repertoire.color);
    if (isUserSidePrep) {
      await enforceOnePrepPerUserPosition(
        tx,
        params.repertoire.id,
        cursor.id,
        moveObj.san,
        params.onConflict,
      );
    }

    // Insert the move or skip if exists (same SAN already prepped here).
    const inserted = await tx
      .insert(moves)
      .values({
        repertoireId: params.repertoire.id,
        parentPositionId: cursor.id,
        childPositionId: child.id,
        san: moveObj.san,
        uci: moveObj.from + moveObj.to + (moveObj.promotion ?? ''),
        isMainLine: false,
        priority: 0,
        lineTags: inheritedTags,
        isRefutation: asRefutation,
      })
      .onConflictDoNothing()
      .returning();

    let moveRow = inserted[0];
    if (!moveRow) {
      reused++;
      moveRow = await tx.query.moves.findFirst({
        where: and(
          eq(moves.repertoireId, params.repertoire.id),
          eq(moves.parentPositionId, cursor.id),
          eq(moves.san, moveObj.san),
        ),
      });
      if (!moveRow) throw new HttpError(500, 'Move insert+fetch race');
      // Promotion is one-way: a real prep write over an existing shadow edge
      // makes it prep (the user decided to actually play it, so it must get a
      // card below), but a refutation walk over existing prep never demotes it.
      moveRow = await promoteIfShadowed(tx, moveRow, asRefutation, {
        userId: params.userId,
        color: params.repertoire.color,
        parentFullFen: cursor.fullFen,
      });
    } else {
      added++;
      if (isUserSidePrep) {
        await tx
          .insert(srsCards)
          .values({ userId: params.userId, moveId: moveRow.id, due: new Date() })
          .onConflictDoNothing();
      }
    }

    // A reused edge keeps its own tags and becomes the parent for what follows,
    // so the line below a pre-existing branch inherits from that branch rather
    // than from where this call happened to start.
    inheritedTags = params.lineTags ?? inheritLineTags(moveRow.lineTags);

    cursor = child;
    cursorFenKey = childFenKey;
  }

  return { added, reused, finalFenKey: cursorFenKey };
}

async function getRepertoireWithTx(tx: Tx, userId: string, id: string): Promise<RepertoireFull> {
  const rep = await tx.query.repertoires.findFirst({
    where: and(eq(repertoires.id, id), eq(repertoires.userId, userId)),
  });
  if (!rep) throw new HttpError(404, 'Repertoire not found');
  const posRows = await tx.select().from(positions).where(eq(positions.repertoireId, id));
  const moveRows = await tx.select().from(moves).where(eq(moves.repertoireId, id));
  const fenByPosId = new Map(posRows.map((p) => [p.id, p.fenKey]));
  return {
    ...toSummary(rep),
    positions: posRows.map((p) => ({ id: p.id, fenKey: p.fenKey, fullFen: p.fullFen })),
    moves: moveRows.map((m) => ({
      id: m.id,
      parentPositionId: m.parentPositionId,
      childPositionId: m.childPositionId,
      parentFenKey: fenByPosId.get(m.parentPositionId) ?? '',
      childFenKey: fenByPosId.get(m.childPositionId) ?? '',
      san: m.san,
      uci: m.uci,
      comment: m.comment,
      annotation: m.annotation,
      isMainLine: m.isMainLine,
      priority: m.priority,
      isDropped: m.isDropped,
      lineTags: m.lineTags,
      isRefutation: m.isRefutation,
    })),
  };
}

function toSummary(r: {
  id: string;
  name: string;
  color: string;
  tags: string[];
  drillRules: unknown;
  autoExpand: boolean;
  rootFenKey: string;
  rootFullFen: string;
  createdAt: Date;
  updatedAt: Date;
}): RepertoireSummary {
  return {
    id: r.id,
    name: r.name,
    color: r.color as Color,
    tags: r.tags,
    drillRules: (r.drillRules && typeof r.drillRules === 'object' ? r.drillRules : {}) as DrillRules,
    autoExpand: r.autoExpand,
    rootFenKey: r.rootFenKey,
    rootFullFen: r.rootFullFen,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// Suppress "unused" lint for STARTING_FEN_KEY / inArray imports if not used directly here.
void STARTING_FEN_KEY;
void inArray;
