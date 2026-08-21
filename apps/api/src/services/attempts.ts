import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { DrillAttemptDto } from '@chess-prep/shared';
import { db } from '../db/client.js';
import { drillAttempts, moves } from '../db/schema.js';
import { HttpError } from './repertoires.js';

/** Hard cap on one pull, so a long-lived log can never blow up a sync response. */
const MAX_PULL = 5000;

function toDto(a: typeof drillAttempts.$inferSelect): DrillAttemptDto {
  return {
    id: a.id,
    moveId: a.moveId,
    repertoireId: a.repertoireId,
    playedSan: a.playedSan,
    wasCorrect: a.wasCorrect,
    at: a.at.toISOString(),
  };
}

/**
 * Append attempts. Unlike `pushCards` this is not an upsert and has no
 * conflict resolution: the log is append-only, so the only correctness concern
 * is not writing an attempt for a move the user doesn't own.
 *
 * Replays are possible (the client flushes a queue it may retry), and they are
 * accepted: a duplicated attempt slightly over-weights one mistake, whereas
 * deduplicating on a client-chosen id would let a client silently suppress
 * real attempts. Neither matters much; the cheaper failure mode wins.
 */
export async function recordAttempts(
  userId: string,
  raw: unknown,
): Promise<{ accepted: number; ignored: number }> {
  if (!Array.isArray(raw)) throw new HttpError(400, 'attempts must be an array');

  const incoming: Array<{ moveId: string; playedSan: string; wasCorrect: boolean; at: Date }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const moveId = String(r.moveId ?? '');
    const playedSan = String(r.playedSan ?? '').trim();
    const at = toDate(r.at) ?? new Date();
    if (!moveId || !playedSan) continue;
    incoming.push({ moveId, playedSan, wasCorrect: Boolean(r.wasCorrect), at });
  }
  if (incoming.length === 0) return { accepted: 0, ignored: 0 };

  // The repertoire is taken from the move, not from the request body: a client
  // that mislabels it would scope the attempt to the wrong log forever, and the
  // move already knows the answer.
  const owned = await db
    .select({ id: moves.id, repertoireId: moves.repertoireId })
    .from(moves)
    .where(inArray(moves.id, incoming.map((a) => a.moveId)));
  const repByMove = new Map(owned.map((m) => [m.id, m.repertoireId]));

  const rows = incoming
    .filter((a) => repByMove.has(a.moveId))
    .map((a) => ({
      userId,
      moveId: a.moveId,
      repertoireId: repByMove.get(a.moveId)!,
      playedSan: a.playedSan,
      wasCorrect: a.wasCorrect,
      at: a.at,
    }));

  if (rows.length > 0) await db.insert(drillAttempts).values(rows);
  return { accepted: rows.length, ignored: incoming.length - rows.length };
}

/** Attempts at or after `sinceIso`, newest first, optionally one repertoire. */
export async function listAttempts(
  userId: string,
  sinceIso: string | undefined,
  repertoireId: string | undefined,
  limit = MAX_PULL,
): Promise<{ attempts: DrillAttemptDto[]; serverTime: string }> {
  let where = eq(drillAttempts.userId, userId);
  if (sinceIso) {
    const since = new Date(sinceIso);
    if (Number.isNaN(since.getTime())) throw new HttpError(400, 'invalid since');
    where = and(where, gte(drillAttempts.at, since))!;
  }
  if (repertoireId) where = and(where, eq(drillAttempts.repertoireId, repertoireId))!;

  const rows = await db
    .select()
    .from(drillAttempts)
    .where(where)
    .orderBy(desc(drillAttempts.at))
    .limit(Math.min(Math.max(1, limit), MAX_PULL));

  return { attempts: rows.map(toDto), serverTime: new Date().toISOString() };
}

function toDate(v: unknown): Date | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v as string | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}
