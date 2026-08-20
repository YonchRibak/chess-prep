/**
 * Phase 7 integration test: the application-level invariant
 *   "at most one prep Move per user-turn position"
 * (PROJECT_SPEC §4 + §7 → "Important behaviors").
 *
 * This invariant cannot be expressed at the DB level in v1 because
 * `moves.uniq_parent_san` only blocks duplicate SAN from one parent, not
 * different SANs (which is intentional — opponent-turn parents can and must
 * hold multiple Moves). The build flow / `appendLine` is responsible for the
 * extra check on user-turn parents.
 *
 * The test hits the service layer directly so a future refactor cannot
 * silently allow two prep moves per user-turn position. Skips if no
 * DATABASE_URL is configured.
 */
import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_USER_ID, STARTING_FEN_KEY } from '@chess-prep/shared';

const ENABLED = Boolean(process.env.DATABASE_URL);

describe('Phase 7 — one prep move per user-turn position (integration)', () => {
  if (!ENABLED) {
    it.skip('DATABASE_URL not set — skipping integration test', () => {});
    return;
  }

  // Track every repertoire created in this file so we cascade-clean even when
  // an assertion throws mid-test.
  const repertoireIdsToCleanup: string[] = [];

  beforeEach(() => {
    repertoireIdsToCleanup.length = 0;
  });

  afterAll(async () => {
    if (!ENABLED) return;
    const { db } = await import('../db/client.js');
    const { repertoires } = await import('../db/schema.js');
    const { inArray } = await import('drizzle-orm');
    if (repertoireIdsToCleanup.length > 0) {
      await db.delete(repertoires).where(inArray(repertoires.id, repertoireIdsToCleanup));
    }
  });

  async function freshRep(name: string, color: 'white' | 'black'): Promise<string> {
    const { createRepertoire } = await import('./repertoires.js');
    const rep = await createRepertoire(DEFAULT_USER_ID, {
      name: `phase7-invariant ${name} ${Date.now()}-${Math.random()}`,
      color,
    });
    repertoireIdsToCleanup.push(rep.id);
    return rep.id;
  }

  it('appendLine refuses a second user-side Move at the same user-turn parent', async () => {
    const { appendLine, HttpError } = await import('./repertoires.js');
    const repId = await freshRep('appendLine-refuse', 'white');

    // First user-side prep: 1.e4 from STARTING_FEN_KEY.
    const r1 = await appendLine(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['e4'],
    });
    expect(r1.added).toBe(1);

    // Second attempt: a *different* SAN from the same user-turn parent must throw.
    await expect(
      appendLine(DEFAULT_USER_ID, repId, {
        fromFenKey: STARTING_FEN_KEY,
        sans: ['d4'],
      }),
    ).rejects.toMatchObject({
      // HttpError is thrown; status is 409. We match the constructor via
      // instanceof in a follow-up assertion below as a belt-and-braces check.
      status: 409,
    });

    // And confirm: the same SAN appended again is still idempotent (no throw,
    // no double-up, reused = 1).
    const r2 = await appendLine(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['e4'],
    });
    expect(r2.added).toBe(0);
    expect(r2.reused).toBe(1);

    // Verify the rep state: exactly one move from root, SAN 'e4'.
    const { getRepertoire } = await import('./repertoires.js');
    const full = await getRepertoire(DEFAULT_USER_ID, repId);
    const rootPos = full.positions.find((p) => p.fenKey === full.rootFenKey)!;
    const fromRoot = full.moves.filter((m) => m.parentPositionId === rootPos.id);
    expect(fromRoot.map((m) => m.san).sort()).toEqual(['e4']);

    // Sanity: belt-and-braces on the error type.
    try {
      await appendLine(DEFAULT_USER_ID, repId, {
        fromFenKey: STARTING_FEN_KEY,
        sans: ['Nf3'],
      });
      throw new Error('expected refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as InstanceType<typeof HttpError>).status).toBe(409);
    }
  });

  it("appendLine with onConflict='swap' replaces the existing prep AND its SRS card", async () => {
    const { appendLine, getRepertoire } = await import('./repertoires.js');
    const { db } = await import('../db/client.js');
    const { srsCards, moves } = await import('../db/schema.js');
    const { eq, inArray } = await import('drizzle-orm');

    const repId = await freshRep('appendLine-swap', 'white');

    // First prep: 1.e4 — auto-creates a card.
    await appendLine(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['e4'],
    });
    const fullBefore = await getRepertoire(DEFAULT_USER_ID, repId);
    const e4MoveId = fullBefore.moves.find((m) => m.san === 'e4')!.id;
    const cardsBefore = await db.select().from(srsCards).where(eq(srsCards.moveId, e4MoveId));
    expect(cardsBefore.length).toBe(1);

    // Swap to 1.d4 — old Move + cascade kills old card; new Move + new card.
    const swapResult = await appendLine(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['d4'],
      onConflict: 'swap',
    });
    expect(swapResult.added).toBe(1);

    const fullAfter = await getRepertoire(DEFAULT_USER_ID, repId);
    const rootPos = fullAfter.positions.find((p) => p.fenKey === fullAfter.rootFenKey)!;
    const fromRoot = fullAfter.moves.filter((m) => m.parentPositionId === rootPos.id);
    expect(fromRoot.map((m) => m.san).sort()).toEqual(['d4']);

    // Old Move row is gone.
    const orphanMove = await db.select().from(moves).where(eq(moves.id, e4MoveId));
    expect(orphanMove.length).toBe(0);
    // Old card is gone (cascade), new card exists for d4.
    const d4MoveId = fullAfter.moves.find((m) => m.san === 'd4')!.id;
    const orphanCard = await db.select().from(srsCards).where(eq(srsCards.moveId, e4MoveId));
    expect(orphanCard.length).toBe(0);
    const newCard = await db.select().from(srsCards).where(eq(srsCards.moveId, d4MoveId));
    expect(newCard.length).toBe(1);

    // Quiet the unused inArray import.
    void inArray;
  });

  it('addMove enforces the same invariant', async () => {
    const { addMove, appendLine, HttpError } = await import('./repertoires.js');
    const repId = await freshRep('addMove', 'white');

    // Seed the first prep via appendLine.
    await appendLine(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['e4'],
    });

    // addMove with a different SAN at the same user-turn parent → 409.
    await expect(
      addMove(DEFAULT_USER_ID, repId, { parentFenKey: STARTING_FEN_KEY, san: 'd4' }),
    ).rejects.toMatchObject({ status: 409 });

    // addMove with the same SAN → idempotent reuse, no throw.
    const reused = await addMove(DEFAULT_USER_ID, repId, {
      parentFenKey: STARTING_FEN_KEY,
      san: 'e4',
    });
    expect(reused.san).toBe('e4');

    // With onConflict='swap', addMove replaces.
    const swapped = await addMove(DEFAULT_USER_ID, repId, {
      parentFenKey: STARTING_FEN_KEY,
      san: 'd4',
      onConflict: 'swap',
    });
    expect(swapped.san).toBe('d4');

    void HttpError;
  });

  it('opponent-turn positions can hold multiple Moves (invariant does NOT apply)', async () => {
    const { appendLine, addMove, getRepertoire } = await import('./repertoires.js');
    const repId = await freshRep('opponent-branches', 'white');

    // After 1.e4, Black is to move. White rep → this position's parent moves
    // are opponent-side. The user picks multiple Black responses to prep
    // against, each becoming its own Move from the post-e4 position.
    const r1 = await appendLine(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['e4'],
    });
    expect(r1.added).toBe(1);

    const fullAfterE4 = await getRepertoire(DEFAULT_USER_ID, repId);
    const postE4 = fullAfterE4.positions.find((p) => p.fenKey === r1.finalFenKey)!;

    // Add multiple opponent responses from the same parent — must all succeed.
    await addMove(DEFAULT_USER_ID, repId, { parentFenKey: postE4.fenKey, san: 'c5' });
    await addMove(DEFAULT_USER_ID, repId, { parentFenKey: postE4.fenKey, san: 'e5' });
    await addMove(DEFAULT_USER_ID, repId, { parentFenKey: postE4.fenKey, san: 'c6' });

    const full = await getRepertoire(DEFAULT_USER_ID, repId);
    const opponentBranches = full.moves
      .filter((m) => m.parentPositionId === postE4.id)
      .map((m) => m.san)
      .sort();
    expect(opponentBranches).toEqual(['c5', 'c6', 'e5']);
  });

  it("createRepertoire's seedSans auto-inserts the opening prefix and only cards user-side moves", async () => {
    const { createRepertoire, getRepertoire } = await import('./repertoires.js');
    const { db } = await import('../db/client.js');
    const { srsCards } = await import('../db/schema.js');
    const { inArray } = await import('drizzle-orm');

    // "French as White": seedSans = ['e4', 'e6']. e4 is user-side (white at
    // start); e6 is opponent-side (black after 1.e4). One SRS card only.
    const created = await createRepertoire(DEFAULT_USER_ID, {
      name: `phase7-seed ${Date.now()}-${Math.random()}`,
      color: 'white',
      seedSans: ['e4', 'e6'],
    });
    repertoireIdsToCleanup.push(created.id);

    const full = await getRepertoire(DEFAULT_USER_ID, created.id);
    expect(full.moves.map((m) => m.san).sort()).toEqual(['e4', 'e6']);

    const moveIds = full.moves.map((m) => m.id);
    const cards = await db.select().from(srsCards).where(inArray(srsCards.moveId, moveIds));
    expect(cards.length).toBe(1);
    const cardedMove = full.moves.find((m) => m.id === cards[0]!.moveId);
    expect(cardedMove?.san).toBe('e4');
  });
});
