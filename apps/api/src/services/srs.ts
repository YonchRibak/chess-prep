import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { FsrsState, SrsCardDto } from '@chess-prep/shared';
import { db } from '../db/client.js';
import { srsCards, moves } from '../db/schema.js';
import { HttpError, isUuid } from './repertoires.js';

function toDto(c: typeof srsCards.$inferSelect): SrsCardDto {
  return {
    id: c.id,
    moveId: c.moveId,
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsedDays,
    scheduledDays: c.scheduledDays,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as FsrsState,
    lastReview: c.lastReview ? c.lastReview.toISOString() : null,
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * Pull cards updated strictly after `sinceIso`. If repertoireId is provided,
 * only cards for moves in that repertoire are returned.
 */
export async function pullCards(
  userId: string,
  sinceIso: string | undefined,
  repertoireId: string | undefined,
): Promise<{ cards: SrsCardDto[]; serverTime: string }> {
  let where = eq(srsCards.userId, userId);
  if (sinceIso) {
    const since = new Date(sinceIso);
    if (Number.isNaN(since.getTime())) throw new HttpError(400, 'invalid since');
    where = and(where, gt(srsCards.updatedAt, since))!;
  }

  if (repertoireId) {
    // A filter, not a resource: a malformed one is a bad request, not a 404.
    // Without this Postgres rejects the uuid cast and the whole pull 500s.
    if (!isUuid(repertoireId)) throw new HttpError(400, 'invalid repertoireId');
    // Join cards → moves → filter on repertoire_id.
    const rows = await db
      .select({ card: srsCards })
      .from(srsCards)
      .innerJoin(moves, eq(moves.id, srsCards.moveId))
      .where(and(where, eq(moves.repertoireId, repertoireId)));
    return {
      cards: rows.map((r) => toDto(r.card)),
      serverTime: new Date().toISOString(),
    };
  }

  const rows = await db.select().from(srsCards).where(where);
  return {
    cards: rows.map(toDto),
    serverTime: new Date().toISOString(),
  };
}

/**
 * Last-write-wins upsert. For each incoming card, if the server's `updated_at`
 * is older, overwrite. Otherwise keep the server copy. Returns the merged state.
 */
export async function pushCards(
  userId: string,
  updates: unknown,
): Promise<{ accepted: number; ignored: number; cards: SrsCardDto[] }> {
  if (!Array.isArray(updates)) throw new HttpError(400, 'updates must be an array');
  const incoming: Array<{
    moveId: string;
    due: Date;
    stability: number;
    difficulty: number;
    elapsedDays: number;
    scheduledDays: number;
    reps: number;
    lapses: number;
    state: number;
    lastReview: Date | null;
    updatedAt: Date;
  }> = [];

  for (const raw of updates) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const moveId = String(r.moveId ?? '');
    const due = toDate(r.due);
    const updatedAt = toDate(r.updatedAt);
    // A non-uuid moveId is skipped like any other malformed row rather than
    // rejecting the batch: this is the offline push queue draining, and one bad
    // entry must not block every real grade behind it. (Note the response's
    // `ignored` counts only rows that survived to the ownership check, so a row
    // dropped here is invisible in the totals — harmless today because the
    // client clears the queue unconditionally.)
    if (!isUuid(moveId) || !due || !updatedAt) continue;
    incoming.push({
      moveId,
      due,
      stability: Number(r.stability ?? 0),
      difficulty: Number(r.difficulty ?? 0),
      elapsedDays: Number(r.elapsedDays ?? 0),
      scheduledDays: Number(r.scheduledDays ?? 0),
      reps: Number(r.reps ?? 0),
      lapses: Number(r.lapses ?? 0),
      state: Number(r.state ?? 0),
      lastReview: r.lastReview ? toDate(r.lastReview) : null,
      updatedAt,
    });
  }

  if (incoming.length === 0) return { accepted: 0, ignored: 0, cards: [] };

  // Verify the moves belong to the user.
  const moveIds = incoming.map((c) => c.moveId);
  const ownedMoves = await db
    .select({ id: moves.id })
    .from(moves)
    .innerJoin(srsCards, eq(srsCards.moveId, moves.id))
    .where(and(eq(srsCards.userId, userId), inArray(moves.id, moveIds)));
  const ownedSet = new Set(ownedMoves.map((m) => m.id));

  let accepted = 0;
  let ignored = 0;

  await db.transaction(async (tx) => {
    for (const c of incoming) {
      if (!ownedSet.has(c.moveId)) {
        ignored++;
        continue;
      }
      // Upsert with last-write-wins on updatedAt.
      const result = await tx
        .insert(srsCards)
        .values({
          userId,
          moveId: c.moveId,
          due: c.due,
          stability: c.stability,
          difficulty: c.difficulty,
          elapsedDays: c.elapsedDays,
          scheduledDays: c.scheduledDays,
          reps: c.reps,
          lapses: c.lapses,
          state: c.state,
          lastReview: c.lastReview,
          updatedAt: c.updatedAt,
        })
        .onConflictDoUpdate({
          target: [srsCards.userId, srsCards.moveId],
          set: {
            due: sql`excluded.due`,
            stability: sql`excluded.stability`,
            difficulty: sql`excluded.difficulty`,
            elapsedDays: sql`excluded.elapsed_days`,
            scheduledDays: sql`excluded.scheduled_days`,
            reps: sql`excluded.reps`,
            lapses: sql`excluded.lapses`,
            state: sql`excluded.state`,
            lastReview: sql`excluded.last_review`,
            updatedAt: sql`excluded.updated_at`,
          },
          where: sql`${srsCards.updatedAt} < excluded.updated_at`,
        })
        .returning();
      if (result.length > 0) accepted++;
      else ignored++;
    }
  });

  // Return the final state of all submitted cards (lets the client confirm what the server now holds).
  const finals = await db
    .select()
    .from(srsCards)
    .where(and(eq(srsCards.userId, userId), inArray(srsCards.moveId, moveIds)));

  return { accepted, ignored, cards: finals.map(toDto) };
}

function toDate(v: unknown): Date | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v as string | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}
