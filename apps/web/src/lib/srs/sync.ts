/**
 * Local-first sync for SRS cards.
 *
 * - On `pullSince()`: GET /srs/cards?since=lastSyncedAt, merge into IndexedDB (LWW).
 * - On grade: `gradeAndQueue()` writes locally and adds to the push queue.
 * - On `flushQueue()`: POST queued cards to /srs/cards/push, clear on success.
 *
 * Offline-safe: failures leave items in the queue for next online pass.
 */
import type { DrillAttemptDto, SrsCardDto } from '@chess-prep/shared';
import { applyGrade } from './scheduler.ts';
import type { Grade } from '@chess-prep/shared';
import {
  clearAttemptQueueEntries,
  clearPushQueueEntries,
  drainAttemptQueue,
  drainPushQueue,
  enqueuePush,
  getMeta,
  mergeAttemptsLocal,
  mergeCardsLocal,
  putCardLocal,
  recordAttemptLocal,
  setMeta,
} from '../idb/schema.ts';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
const LAST_SYNC_KEY = 'srs.lastSyncedAt';

interface PullResponse {
  cards: SrsCardDto[];
  serverTime: string;
}
interface PushResponse {
  accepted: number;
  ignored: number;
  cards: SrsCardDto[];
}

/** Fetch cards updated since lastSyncedAt and merge them locally. */
export async function pullSince(repertoireId?: string): Promise<number> {
  const since = await getMeta(LAST_SYNC_KEY);
  const url = new URL(`${BASE_URL}/srs/cards`);
  if (since) url.searchParams.set('since', since);
  if (repertoireId) url.searchParams.set('repertoireId', repertoireId);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  const data = (await res.json()) as PullResponse;
  await mergeCardsLocal(data.cards);
  await setMeta(LAST_SYNC_KEY, data.serverTime);
  return data.cards.length;
}

/**
 * Bootstrap pull: ignore lastSyncedAt and grab everything for a repertoire.
 * Used when entering drill for the first time on a given device.
 */
export async function pullAll(repertoireId?: string): Promise<number> {
  const url = new URL(`${BASE_URL}/srs/cards`);
  if (repertoireId) url.searchParams.set('repertoireId', repertoireId);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  const data = (await res.json()) as PullResponse;
  await mergeCardsLocal(data.cards);
  await setMeta(LAST_SYNC_KEY, data.serverTime);
  return data.cards.length;
}

/** Grade a card locally and queue the result for push. */
export async function gradeAndQueue(card: SrsCardDto, grade: Grade): Promise<SrsCardDto> {
  const next = applyGrade(card, grade);
  await putCardLocal(next);
  await enqueuePush(next);
  // Best-effort push immediately; don't fail the grade if we're offline.
  void flushQueue().catch(() => {
    /* swallow — queue stays for next attempt */
  });
  return next;
}

/** Flush queued cards to the server. Safe to call repeatedly. */
export async function flushQueue(): Promise<{ pushed: number; remaining: number }> {
  const queued = await drainPushQueue();
  if (queued.length === 0) return { pushed: 0, remaining: 0 };

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/srs/cards/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: queued }),
    });
  } catch {
    return { pushed: 0, remaining: queued.length };
  }
  if (!res.ok) return { pushed: 0, remaining: queued.length };

  const data = (await res.json()) as PushResponse;
  // Always remove the queued entries we just sent — the server already has them
  // or rejected them (we trust the response and don't keep retrying ignored ones).
  await clearPushQueueEntries(queued.map((c) => c.moveId));
  // Server's reply may include canonical/merged states — apply them locally.
  await mergeCardsLocal(data.cards);
  return { pushed: data.accepted + data.ignored, remaining: 0 };
}

/* ---------------- Phase 9d: the drill-attempt log ---------------- */

interface AttemptPullResponse {
  attempts: DrillAttemptDto[];
  serverTime: string;
}

/**
 * Log one answered card. Fire-and-forget by design: an attempt is telemetry for
 * the mistakes mode, and failing a drill because the log write failed would
 * trade a real feature for a bookkeeping one.
 */
export async function logAttempt(args: {
  moveId: string;
  repertoireId: string;
  playedSan: string;
  wasCorrect: boolean;
  at?: Date;
}): Promise<void> {
  const attempt: DrillAttemptDto = {
    id: crypto.randomUUID(),
    moveId: args.moveId,
    repertoireId: args.repertoireId,
    playedSan: args.playedSan,
    wasCorrect: args.wasCorrect,
    at: (args.at ?? new Date()).toISOString(),
  };
  await recordAttemptLocal(attempt);
  void flushAttempts().catch(() => {
    /* swallow — the queue keeps the attempt for the next pass */
  });
}

/** Append queued attempts on the server. Safe to call repeatedly. */
export async function flushAttempts(): Promise<{ pushed: number; remaining: number }> {
  const queued = await drainAttemptQueue();
  if (queued.length === 0) return { pushed: 0, remaining: 0 };
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/srs/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempts: queued }),
    });
  } catch {
    return { pushed: 0, remaining: queued.length };
  }
  if (!res.ok) return { pushed: 0, remaining: queued.length };
  await clearAttemptQueueEntries(queued.map((a) => a.id));
  return { pushed: queued.length, remaining: 0 };
}

/**
 * Pull the server's attempt log for a repertoire into IndexedDB.
 *
 * Only ever *adds* to the local log — the local copy is the one the mistakes
 * mode reads, and it must stay usable when this call fails.
 */
export async function pullAttempts(repertoireId?: string, since?: Date): Promise<number> {
  const url = new URL(`${BASE_URL}/srs/attempts`);
  if (repertoireId) url.searchParams.set('repertoireId', repertoireId);
  if (since) url.searchParams.set('since', since.toISOString());
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`attempt pull failed: ${res.status}`);
  const data = (await res.json()) as AttemptPullResponse;
  await mergeAttemptsLocal(data.attempts);
  return data.attempts.length;
}

/** Listen for online events and flush the queue. */
export function attachOnlineFlush(): () => void {
  const handler = () => {
    void flushQueue();
    void flushAttempts();
  };
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}
