/**
 * `deleteAllRepertoires` — the one irreversible action in the app.
 *
 * Two properties matter and only one of them is about deleting: it must remove
 * everything the user owns *and nothing else*. The scoping half is what this
 * file mostly guards, because a missing `where user_id = …` passes every
 * "did it delete?" assertion perfectly.
 *
 * For that reason the test runs against **its own throwaway user**, never
 * `DEFAULT_USER_ID`: a bug in the statement under test would otherwise wipe the
 * developer's real repertoires on `pnpm test`, which is precisely the failure
 * the feature is capable of. Skips if no DATABASE_URL is configured.
 */
import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_USER_ID, STARTING_FEN_KEY } from '@chess-prep/shared';

const ENABLED = Boolean(process.env.DATABASE_URL);

describe('deleteAllRepertoires (integration)', () => {
  if (!ENABLED) {
    it.skip('DATABASE_URL not set — skipping integration test', () => {});
    return;
  }

  let victimUserId: string | null = null;

  afterAll(async () => {
    if (!victimUserId) return;
    const { db } = await import('../db/client.js');
    const { users } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.delete(users).where(eq(users.id, victimUserId));
  });

  it('deletes every repertoire of its own user, cascading their SRS cards', async () => {
    const { createRepertoire, deleteAllRepertoires, getRepertoire, listRepertoires } =
      await import('./repertoires.js');
    const { db } = await import('../db/client.js');
    const { users, srsCards } = await import('../db/schema.js');
    const { inArray } = await import('drizzle-orm');

    const [victim] = await db
      .insert(users)
      .values({ email: `delete-all-${Date.now()}-${Math.random()}@test.invalid` })
      .returning();
    victimUserId = victim!.id;

    // Two repertoires, each seeded so at least one carded user-side move exists.
    const ids: string[] = [];
    for (const color of ['white', 'black'] as const) {
      const rep = await createRepertoire(victimUserId, {
        name: `wipe-${color}`,
        color,
        seedSans: color === 'white' ? ['e4'] : ['e4', 'c5', 'Nf3'],
      });
      ids.push(rep.id);
    }
    const moveIds = (await getRepertoire(victimUserId, ids[0]!)).moves.map((m) => m.id);
    expect(
      await db.select().from(srsCards).where(inArray(srsCards.moveId, moveIds)),
    ).not.toHaveLength(0);

    const { deleted } = await deleteAllRepertoires(victimUserId);

    expect(deleted).toBe(2);
    expect(await listRepertoires(victimUserId)).toEqual([]);
    // Cards go via the FK cascade, not a second pass — if this regresses, the
    // orphans are invisible until a drill queue trips over them.
    expect(await db.select().from(srsCards).where(inArray(srsCards.moveId, moveIds))).toEqual(
      [],
    );
    // STARTING_FEN_KEY is referenced so the seeded roots are the standard ones.
    expect(STARTING_FEN_KEY).toBeTruthy();
  });

  it('does not touch another user’s repertoires', async () => {
    const { createRepertoire, deleteAllRepertoires, listRepertoires, deleteRepertoire } =
      await import('./repertoires.js');
    const { db } = await import('../db/client.js');
    const { users } = await import('../db/schema.js');

    // A repertoire owned by the default user, which must survive the wipe of
    // the throwaway user. This is the assertion that a missing `where user_id`
    // would fail — and the only one that would.
    const survivor = await createRepertoire(DEFAULT_USER_ID, {
      name: `delete-all-bystander ${Date.now()}-${Math.random()}`,
      color: 'white',
      seedSans: ['d4'],
    });

    try {
      const [victim] = await db
        .insert(users)
        .values({ email: `delete-all-scope-${Date.now()}-${Math.random()}@test.invalid` })
        .returning();
      const scopedId = victim!.id;
      await createRepertoire(scopedId, { name: 'doomed', color: 'black' });

      const { deleted } = await deleteAllRepertoires(scopedId);
      expect(deleted).toBe(1);

      const remaining = await listRepertoires(DEFAULT_USER_ID);
      expect(remaining.map((r) => r.id)).toContain(survivor.id);

      const { eq } = await import('drizzle-orm');
      await db.delete(users).where(eq(users.id, scopedId));
    } finally {
      await deleteRepertoire(DEFAULT_USER_ID, survivor.id);
    }
  });
});
