import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SrsCardDto } from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';

/**
 * IndexedDB schema for offline drilling.
 *
 * - srsCards: keyed by moveId; every card kept locally so drill works offline.
 * - repertoires: keyed by id; full cached snapshot for offline reads.
 * - meta: small key-value store (e.g., lastSyncedAt).
 * - pushQueue: cards waiting to be pushed to the server.
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
}

let dbPromise: Promise<IDBPDatabase<ChessPrepDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<ChessPrepDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ChessPrepDB>('chess-prep', 1, {
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
