/**
 * Flow F3 (integration — needs Postgres): the explorer service's tier order.
 * The behavior that matters: a cold cache with no network falls through to the
 * bundled snapshot instead of `null`, and a cache row still wins over the
 * snapshot when both exist. Exercised via `cachedOnly`, which skips the live
 * fetch the same way a dead network does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { eq } from 'drizzle-orm';
import { fenKey as makeFenKey } from '@chess-prep/shared';
import { db } from '../db/client.js';
import { explorerEntries, explorerSnapshotEntries } from '../db/schema.js';
import { EXPLORER_SOURCE, getExplorerEntryWithTier } from './explorer.js';

// A legal but obscure position (1.Nh3 Nh6 2.Rg1 Rg8) so no real cache row for
// it exists in the shared dev database.
const chess = new Chess();
for (const san of ['Nh3', 'Nh6', 'Rg1', 'Rg8']) chess.move(san);
const KEY = makeFenKey(chess.fen());

async function wipe() {
  await db.delete(explorerSnapshotEntries).where(eq(explorerSnapshotEntries.fenKey, KEY));
  await db.delete(explorerEntries).where(eq(explorerEntries.fenKey, KEY));
}

describe('explorer tier order (Flow F3)', () => {
  beforeAll(wipe);
  afterAll(wipe);

  it('nothing anywhere → tier none, entry null', async () => {
    const { entry, tier } = await getExplorerEntryWithTier(KEY, { cachedOnly: true });
    expect(tier).toBe('none');
    expect(entry).toBeNull();
  });

  it('cold cache + no network → snapshot answers, labeled as such', async () => {
    await db.insert(explorerSnapshotEntries).values({
      fenKey: KEY,
      source: 'lichess:blitz,rapid,classical:1600:snapshot@2026-08-01',
      total: 4321,
      moves: [{ san: 'd4', uci: 'd2d4', white: 2000, draws: 1000, black: 1321 }],
      generatedAt: new Date('2026-08-01T00:00:00Z'),
    });
    const { entry, tier } = await getExplorerEntryWithTier(KEY, { cachedOnly: true });
    expect(tier).toBe('snapshot');
    expect(entry!.total).toBe(4321);
    expect(entry!.source).toContain('snapshot');
  });

  it('a cache row beats the snapshot — it is newer data for the same position', async () => {
    await db.insert(explorerEntries).values({
      fenKey: KEY,
      source: EXPLORER_SOURCE,
      total: 9999,
      moves: [],
      fetchedAt: new Date(),
    });
    const { entry, tier } = await getExplorerEntryWithTier(KEY, { cachedOnly: true });
    expect(tier).toBe('fresh-cache');
    expect(entry!.total).toBe(9999);
  });
});
