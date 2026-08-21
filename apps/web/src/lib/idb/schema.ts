import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DrillAttemptDto, OpeningId, SrsCardDto } from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';

/**
 * IndexedDB schema for offline drilling.
 *
 * - srsCards: keyed by moveId; every card kept locally so drill works offline.
 * - repertoires: keyed by id; full cached snapshot for offline reads.
 * - meta: small key-value store (e.g., lastSyncedAt).
 * - pushQueue: cards waiting to be pushed to the server.
 * - openingNames: fenKey → book name (Phase 9a), so opening-name line scopes
 *   can be evaluated during an offline session. A cache only — the book itself
 *   still lives on the server (see lib/openings/nameCache.ts).
 * - drillAttempts: the Phase 9d attempt log, held locally because the
 *   `mistakes` drill mode must build its queue offline like every other mode.
 * - attemptQueue: attempts waiting to be appended on the server.
 */
interface ChessPrepDB extends DBSchema {
  srsCards: {
    key: string;
    value: SrsCardDto;
    indexes: { due: string; state: number };
  };
  repertoires: {
    key: string;
    value: RepertoireFull;
  };
  meta: {
    key: string;
    value: string;
  };
  pushQueue: {
    // key is moveId; value is the card to push
    key: string;
    value: SrsCardDto;
  };
  openingNames: {
    // key is the normalized fenKey
    key: string;
    value: { fenKey: string; opening: OpeningId };
  };
  drillAttempts: {
    // key is the attempt's client-generated id
    key: string;
    value: DrillAttemptDto;
    indexes: { at: string; moveId: string };
  };
  attemptQueue: {
    key: string;
    value: DrillAttemptDto;
  };
}

let dbPromise: Promise<IDBPDatabase<ChessPrepDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<ChessPrepDB>> {
  if (!dbPromise) {
    // v2 added `openingNames` (Phase 9a), v3 the attempt log (Phase 9d). The
    // upgrade handler is additive and idempotent, so an existing database keeps
    // its cards and repertoires.
    dbPromise = openDB<ChessPrepDB>('chess-prep', 3, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('srsCards')) {
          const cards = db.createObjectStore('srsCards', { keyPath: 'moveId' });
          cards.createIndex('due', 'due');
          cards.createIndex('state', 'state');
        }
        if (!db.objectStoreNames.contains('repertoires')) {
          db.createObjectStore('repertoires', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
        if (!db.objectStoreNames.contains('pushQueue')) {
          db.createObjectStore('pushQueue', { keyPath: 'moveId' });
        }
        if (!db.objectStoreNames.contains('openingNames')) {
          db.createObjectStore('openingNames', { keyPath: 'fenKey' });
        }
        if (!db.objectStoreNames.contains('drillAttempts')) {
          const attempts = db.createObjectStore('drillAttempts', { keyPath: 'id' });
          attempts.createIndex('at', 'at');
          attempts.createIndex('moveId', 'moveId');
        }
        if (!db.objectStoreNames.contains('attemptQueue')) {
          db.createObjectStore('attemptQueue', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

/* ---------------- cards ---------------- */

export async function putCardLocal(card: SrsCardDto): Promise<void> {
  const db = await getDb();
  await db.put('srsCards', card);
}

export async function putCardsLocal(cards: SrsCardDto[]): Promise<void> {
  if (cards.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('srsCards', 'readwrite');
  await Promise.all(cards.map((c) => tx.store.put(c)));
  await tx.done;
}

export async function getCardLocal(moveId: string): Promise<SrsCardDto | undefined> {
  const db = await getDb();
  return db.get('srsCards', moveId);
}

export async function getAllCardsLocal(): Promise<SrsCardDto[]> {
  const db = await getDb();
  return db.getAll('srsCards');
}

/** Merge-by-updatedAt: keep the newer of (local, remote). */
export async function mergeCardsLocal(remote: SrsCardDto[]): Promise<void> {
  if (remote.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('srsCards', 'readwrite');
  for (const r of remote) {
    const existing = await tx.store.get(r.moveId);
    if (!existing || new Date(existing.updatedAt) < new Date(r.updatedAt)) {
      await tx.store.put(r);
    }
  }
  await tx.done;
}

/* ---------------- repertoires ---------------- */

export async function putRepertoireLocal(rep: RepertoireFull): Promise<void> {
  const db = await getDb();
  await db.put('repertoires', rep);
}

export async function getRepertoireLocal(id: string): Promise<RepertoireFull | undefined> {
  const db = await getDb();
  return db.get('repertoires', id);
}

export async function getAllRepertoiresLocal(): Promise<RepertoireFull[]> {
  const db = await getDb();
  return db.getAll('repertoires');
}

export async function deleteRepertoireLocal(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('repertoires', id);
}

/* ---------------- meta ---------------- */

export async function getMeta(key: string): Promise<string | undefined> {
  const db = await getDb();
  return db.get('meta', key);
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.put('meta', value, key);
}

/* ---------------- opening names (Phase 9a) ---------------- */

export async function putOpeningNamesLocal(
  entries: Array<{ fenKey: string; opening: OpeningId }>,
): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('openingNames', 'readwrite');
  await Promise.all(entries.map((e) => tx.store.put(e)));
  await tx.done;
}

export async function getAllOpeningNamesLocal(): Promise<Map<string, OpeningId>> {
  const db = await getDb();
  const rows = await db.getAll('openingNames');
  return new Map(rows.map((r) => [r.fenKey, r.opening]));
}

/* ---------------- drill attempts (Phase 9d) ---------------- */

/**
 * Write an attempt locally and queue it for push.
 *
 * Local-first for the same reason cards are: the `mistakes` mode has to build
 * its queue from the log, and a mode that only works online would be the one
 * offline hole in the drill surface.
 */
export async function recordAttemptLocal(attempt: DrillAttemptDto): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['drillAttempts', 'attemptQueue'], 'readwrite');
  await Promise.all([
    tx.objectStore('drillAttempts').put(attempt),
    tx.objectStore('attemptQueue').put(attempt),
  ]);
  await tx.done;
}

/** Attempts at or after `since` (all of them when omitted), newest first. */
export async function getAttemptsLocal(since?: Date): Promise<DrillAttemptDto[]> {
  const db = await getDb();
  const rows = since
    ? await db.getAllFromIndex('drillAttempts', 'at', IDBKeyRange.lowerBound(since.toISOString()))
    : await db.getAll('drillAttempts');
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** Merge server-side attempts in. Ids are stable, so this is a plain put. */
export async function mergeAttemptsLocal(remote: DrillAttemptDto[]): Promise<void> {
  if (remote.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('drillAttempts', 'readwrite');
  await Promise.all(remote.map((a) => tx.store.put(a)));
  await tx.done;
}

export async function drainAttemptQueue(): Promise<DrillAttemptDto[]> {
  const db = await getDb();
  return db.getAll('attemptQueue');
}

export async function clearAttemptQueueEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('attemptQueue', 'readwrite');
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}

/* ---------------- push queue ---------------- */

export async function enqueuePush(card: SrsCardDto): Promise<void> {
  const db = await getDb();
  await db.put('pushQueue', card);
}

export async function drainPushQueue(): Promise<SrsCardDto[]> {
  const db = await getDb();
  return db.getAll('pushQueue');
}

export async function clearPushQueueEntries(moveIds: string[]): Promise<void> {
  if (moveIds.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('pushQueue', 'readwrite');
  await Promise.all(moveIds.map((id) => tx.store.delete(id)));
  await tx.done;
}
