/**
 * Study import + re-import (plan phase S2).
 *
 * A lichess study is the *source of truth* for a study-sourced repertoire:
 * `importStudy` creates one, `updateStudy` re-syncs it from a newer export of
 * the same study. The sync is a diff, not a drop-and-reload, for one reason —
 * **SRS history lives on move rows**. Reloading would give every card a new id
 * and reset every due date, which is precisely the state the user spent weeks
 * building. So moves still present keep their rows (and cards), only their
 * annotations refresh; moves the study no longer has are deleted (cards
 * cascade, as the user was warned); new moves are inserted and carded.
 *
 * Two asymmetries are deliberate and worth knowing:
 *
 * - **User-side `is_dropped` comes from the PGN; opponent-side is kept.** The
 *   prep policy in shared decides which hero move holds the prep slot, so a
 *   re-import must be allowed to flip it. A drop on an *opponent* reply is the
 *   user's own "won't cover" instruction, which the study cannot express, so
 *   the sync leaves it alone.
 * - **Refutation shadow lines survive.** They are user data written from the
 *   drill, not study content; deleting them because the study "doesn't have
 *   them" would erase the mistake history they document.
 * - **Extensions survive (S5).** A move with `origin = 'user'` was recorded in
 *   the app (Expand variations), so the study cannot know about it. It is kept
 *   with its card while its parent is still connected to the root; the study
 *   *adopts* it if a later version contains the same edge, and *demotes* it
 *   (dropped, card kept) if the study now plays a different hero move at that
 *   parent — the study owns the prep slot.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  fenTurn,
  InvalidPgnError,
  isUserMove,
  liveReachablePositions,
  studyPgnToTree,
  type Color,
  type FenKey,
  type RepertoireSource,
  type StudyParseResult,
  type StudySyncSummary,
} from '@chess-prep/shared';
import { db } from '../db/client.js';
import { moves, positions, repertoires, srsCards } from '../db/schema.js';
import {
  HttpError,
  ensureColor,
  ensureIdFound,
  ensureNonEmptyName,
  getRepertoireWithTx,
  type RepertoireFull,
  type Tx,
} from './repertoires.js';

export interface StudyImportResult {
  repertoire: RepertoireFull;
  summary: StudySyncSummary;
}

function ensurePgn(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'pgn is required');
  return raw;
}

function parseStudyOr400(pgn: string, color: Color): StudyParseResult {
  try {
    return studyPgnToTree(pgn, color);
  } catch (e) {
    if (e instanceof InvalidPgnError) throw new HttpError(400, e.message);
    throw e;
  }
}

function sourceOf(parsed: StudyParseResult, pgn: string): RepertoireSource {
  return {
    kind: 'lichess-study',
    studyName: parsed.studyName,
    studyUrl: parsed.studyUrl,
    chapters: parsed.chapters,
    pgnSha256: createHash('sha256').update(pgn).digest('hex'),
    importedAt: new Date().toISOString(),
  };
}

export async function importStudy(
  userId: string,
  input: { pgn: unknown; color: unknown; name?: unknown; tags?: unknown },
): Promise<StudyImportResult> {
  const pgn = ensurePgn(input.pgn);
  const color = ensureColor(input.color);
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const parsed = parseStudyOr400(pgn, color);
  const name =
    typeof input.name === 'string' && input.name.trim()
      ? ensureNonEmptyName(input.name)
      : (parsed.studyName ?? 'Lichess study');

  return await db.transaction(async (tx) => {
    const [rep] = await tx
      .insert(repertoires)
      .values({
        userId,
        name,
        color,
        tags,
        rootFenKey: parsed.tree.rootFenKey,
        rootFullFen: parsed.tree.rootFullFen,
        source: sourceOf(parsed, pgn),
      })
      .returning();
    if (!rep) throw new HttpError(500, 'Failed to create repertoire');
    const summary = await syncRepertoireFromTree(tx, userId, { id: rep.id, color }, parsed);
    return { repertoire: await getRepertoireWithTx(tx, userId, rep.id), summary };
  });
}

export async function updateStudy(
  userId: string,
  repertoireId: string,
  input: { pgn: unknown },
): Promise<StudyImportResult> {
  ensureIdFound(repertoireId, 'Repertoire');
  const pgn = ensurePgn(input.pgn);

  return await db.transaction(async (tx) => {
    const rep = await tx.query.repertoires.findFirst({
      where: and(eq(repertoires.id, repertoireId), eq(repertoires.userId, userId)),
    });
    if (!rep) throw new HttpError(404, 'Repertoire not found');
    const source = rep.source as RepertoireSource | null;
    if (source?.kind !== 'lichess-study') {
      throw new HttpError(400, 'Only a repertoire imported from a study can be updated from a PGN');
    }
    const color = rep.color as Color;
    const parsed = parseStudyOr400(pgn, color);
    if (parsed.tree.rootFenKey !== rep.rootFenKey) {
      throw new HttpError(
        400,
        'The study now starts from a different position; import it as a new study',
      );
    }
    await tx
      .update(repertoires)
      .set({ source: sourceOf(parsed, pgn) })
      .where(eq(repertoires.id, repertoireId));
    const summary = await syncRepertoireFromTree(tx, userId, { id: rep.id, color }, parsed);
    return { repertoire: await getRepertoireWithTx(tx, userId, rep.id), summary };
  });
}

/* ---------------- the diff ---------------- */

// Postgres caps a statement at 65 535 bind parameters; a move row uses ~12.
const CHUNK = 500;
function* chunks<T>(arr: T[]): Generator<T[]> {
  for (let i = 0; i < arr.length; i += CHUNK) yield arr.slice(i, i + CHUNK);
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Position ids reachable from `rootId` over the given edges (dropped ones included). */
function reachableFrom(
  rootId: string | undefined,
  edges: Array<{ parent: string | undefined; child: string | undefined }>,
): Set<string> {
  const out = new Set<string>();
  if (!rootId) return out;
  const children = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.parent || !e.child) continue;
    const list = children.get(e.parent);
    if (list) list.push(e.child);
    else children.set(e.parent, [e.child]);
  }
  const queue = [rootId];
  out.add(rootId);
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

/**
 * Bring the repertoire's positions/moves/cards in line with `parsed.tree`
 * inside the caller's transaction. Returns what changed.
 */
export async function syncRepertoireFromTree(
  tx: Tx,
  userId: string,
  rep: { id: string; color: Color },
  parsed: StudyParseResult,
): Promise<StudySyncSummary> {
  const { tree } = parsed;
  const summary: StudySyncSummary = {
    chapters: parsed.chapters.length,
    positionsAdded: 0,
    positionsRemoved: 0,
    movesAdded: 0,
    movesUpdated: 0,
    movesRemoved: 0,
    cardsCreated: 0,
    cardsKept: 0,
    demoted: parsed.demoted,
    refutationsKept: 0,
    extensionsKept: 0,
    extensionsAdopted: 0,
    extensionsRemoved: 0,
    extensionsDemoted: [],
  };

  /* positions */
  const existingPositions = await tx
    .select()
    .from(positions)
    .where(eq(positions.repertoireId, rep.id));
  const posIdByKey = new Map<FenKey, string>(
    existingPositions.map((p) => [p.fenKey as FenKey, p.id]),
  );
  const fullFenByKey = new Map<FenKey, string>(tree.positions.map((p) => [p.fenKey, p.fullFen]));
  for (const p of existingPositions) fullFenByKey.set(p.fenKey as FenKey, p.fullFen);

  const missing = tree.positions.filter((p) => !posIdByKey.has(p.fenKey));
  for (const batch of chunks(missing)) {
    const inserted = await tx
      .insert(positions)
      .values(batch.map((p) => ({ repertoireId: rep.id, fenKey: p.fenKey, fullFen: p.fullFen })))
      .returning({ id: positions.id, fenKey: positions.fenKey });
    for (const p of inserted) posIdByKey.set(p.fenKey as FenKey, p.id);
  }
  summary.positionsAdded = missing.length;

  /* moves */
  const existingMoves = await tx.select().from(moves).where(eq(moves.repertoireId, rep.id));
  const existingByEdge = new Map(existingMoves.map((m) => [`${m.parentPositionId}::${m.san}`, m]));
  const desiredEdges = new Set<string>();
  const live = liveReachablePositions(tree);

  type CardCandidate = { moveId: string; parentFenKey: FenKey; isDropped: boolean };
  const candidates: CardCandidate[] = [];
  const inserts: (typeof moves.$inferInsert)[] = [];
  const insertCandidates: Array<{ parentFenKey: FenKey; isDropped: boolean }> = [];

  for (const m of tree.moves) {
    const parentId = posIdByKey.get(m.parentFenKey);
    const childId = posIdByKey.get(m.childFenKey);
    if (!parentId || !childId) continue;
    const key = `${parentId}::${m.san}`;
    desiredEdges.add(key);
    const parentFen = fullFenByKey.get(m.parentFenKey)!;
    const heroTurn = isUserMove(fenTurn(parentFen), rep.color);
    const lineTags = m.lineTags ?? [];
    const existing = existingByEdge.get(key);

    if (!existing) {
      inserts.push({
        repertoireId: rep.id,
        parentPositionId: parentId,
        childPositionId: childId,
        san: m.san,
        uci: m.uci,
        comment: m.comment,
        annotation: m.annotation,
        isMainLine: m.isMainLine,
        priority: m.priority,
        isDropped: Boolean(m.isDropped),
        lineTags,
        origin: 'study',
      });
      insertCandidates.push({ parentFenKey: m.parentFenKey, isDropped: Boolean(m.isDropped) });
      continue;
    }

    // Hero-side drop state is the policy's; opponent-side is the user's.
    const isDropped = heroTurn ? Boolean(m.isDropped) : existing.isDropped;
    const patch: Partial<typeof moves.$inferInsert> = {};
    if (existing.comment !== m.comment) patch.comment = m.comment;
    if (existing.annotation !== m.annotation) patch.annotation = m.annotation;
    if (existing.isMainLine !== m.isMainLine) patch.isMainLine = m.isMainLine;
    if (existing.uci !== m.uci) patch.uci = m.uci;
    if (existing.isDropped !== isDropped) patch.isDropped = isDropped;
    if (!sameTags(existing.lineTags, lineTags)) patch.lineTags = lineTags;
    // A shadow edge the study now contains is prep — same promotion rule as
    // appendLine's promoteIfShadowed.
    if (existing.isRefutation) patch.isRefutation = false;
    // S5: the study caught up with an extension the user recorded in the app.
    // The study adopts the row — id, card and attempt history all survive.
    if (existing.origin !== 'study') {
      patch.origin = 'study';
      summary.extensionsAdopted += 1;
    }
    if (Object.keys(patch).length > 0) {
      await tx.update(moves).set(patch).where(eq(moves.id, existing.id));
      summary.movesUpdated += 1;
    }
    candidates.push({ moveId: existing.id, parentFenKey: m.parentFenKey, isDropped });
  }

  for (const batch of chunks(inserts)) {
    const inserted = await tx.insert(moves).values(batch).returning({ id: moves.id });
    // `returning` preserves VALUES order in Postgres for a single INSERT.
    inserted.forEach((row, i) => {
      const meta = insertCandidates[summary.movesAdded + i]!;
      candidates.push({ moveId: row.id, ...meta });
    });
    summary.movesAdded += batch.length;
  }

  /* removals */
  const stale = existingMoves.filter((m) => !desiredEdges.has(`${m.parentPositionId}::${m.san}`));
  const keptRefutations = stale.filter((m) => m.isRefutation);
  summary.refutationsKept = keptRefutations.length;
  // S5: extensions (recorded in the app) survive too — but only while
  // something still connects them to the root. An extension whose parent line
  // the study removed can never be rehearsed, and left in place it would
  // enter the queue builders at depth 0 as a phantom card.
  const staleExtensions = stale.filter((m) => !m.isRefutation && m.origin === 'user');
  const studyEdges = existingMoves.filter((m) =>
    desiredEdges.has(`${m.parentPositionId}::${m.san}`),
  );
  const rootId = posIdByKey.get(tree.rootFenKey);
  const connected = reachableFrom(rootId, [
    ...tree.moves.map((m) => ({
      parent: posIdByKey.get(m.parentFenKey),
      child: posIdByKey.get(m.childFenKey),
    })),
    ...studyEdges.map((m) => ({ parent: m.parentPositionId, child: m.childPositionId })),
    ...staleExtensions.map((m) => ({ parent: m.parentPositionId, child: m.childPositionId })),
  ]);
  const keptExtensions = staleExtensions.filter((m) => connected.has(m.parentPositionId));
  const keptIds = new Set([...keptRefutations, ...keptExtensions].map((m) => m.id));
  const toDelete = stale.filter((m) => !keptIds.has(m.id)).map((m) => m.id);
  summary.extensionsRemoved = staleExtensions.length - keptExtensions.length;
  summary.extensionsKept = keptExtensions.length;
  for (const batch of chunks(toDelete)) {
    await tx.delete(moves).where(inArray(moves.id, batch));
  }
  summary.movesRemoved = toDelete.length;

  // S5 hero collision: the study owns the prep slot. Where the study now has
  // a live hero move, a kept extension playing something else at the same
  // parent is parked (dropped, card kept) — the same rule the prep policy
  // applies to the study's own alternates. Its subtree stays connected
  // (reachability above walks dropped edges too) so an undrop restores it.
  const studyHeroSanByParent = new Map<string, string>();
  for (const m of tree.moves) {
    if (m.isDropped) continue;
    const parentId = posIdByKey.get(m.parentFenKey);
    if (!parentId) continue;
    if (isUserMove(fenTurn(fullFenByKey.get(m.parentFenKey)!), rep.color)) {
      studyHeroSanByParent.set(parentId, m.san);
    }
  }
  const fenKeyByPosId = new Map(existingPositions.map((p) => [p.id, p.fenKey as FenKey]));
  for (const m of keptExtensions) {
    const keptSan = studyHeroSanByParent.get(m.parentPositionId);
    if (!keptSan || m.isDropped) continue;
    await tx.update(moves).set({ isDropped: true }).where(eq(moves.id, m.id));
    summary.extensionsDemoted.push({
      parentFenKey: fenKeyByPosId.get(m.parentPositionId)!,
      san: m.san,
      keptSan,
    });
  }

  // Positions the study no longer has, unless a surviving shadow line or
  // extension still stands on them.
  const pinned = new Set<string>();
  for (const m of [...keptRefutations, ...keptExtensions]) {
    pinned.add(m.parentPositionId);
    pinned.add(m.childPositionId);
  }
  const treeKeys = new Set(tree.positions.map((p) => p.fenKey));
  const orphanIds = existingPositions
    .filter((p) => !treeKeys.has(p.fenKey as FenKey) && !pinned.has(p.id))
    .map((p) => p.id);
  for (const batch of chunks(orphanIds)) {
    await tx.delete(positions).where(inArray(positions.id, batch));
  }
  summary.positionsRemoved = orphanIds.length;

  /* cards */
  const eligible = candidates.filter((c) => {
    if (c.isDropped || !live.has(c.parentFenKey)) return false;
    return isUserMove(fenTurn(fullFenByKey.get(c.parentFenKey)!), rep.color);
  });
  let created = 0;
  for (const batch of chunks(eligible)) {
    const rows = await tx
      .insert(srsCards)
      .values(batch.map((c) => ({ userId, moveId: c.moveId, due: new Date() })))
      .onConflictDoNothing()
      .returning({ id: srsCards.id });
    created += rows.length;
  }
  summary.cardsCreated = created;
  summary.cardsKept = eligible.length - created;

  await tx.update(repertoires).set({ updatedAt: new Date() }).where(eq(repertoires.id, rep.id));
  return summary;
}
