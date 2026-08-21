/**
 * Phase 9d integration test: **a refutation shadow line is never prep.**
 *
 * The feature's whole definition is a set of things that must NOT happen, and
 * every one of them fails silently: a shadow line that gets a card shows up as
 * a drill of a move the user played by mistake; one that takes the single prep
 * slot 409s the user out of their own position; one that survives export puts
 * junk into their PGN and re-imports as a real branch.
 *
 * Hits the service layer directly so a refactor cannot quietly relax any of it.
 * Skips if no DATABASE_URL is configured.
 */
import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_USER_ID, STARTING_FEN_KEY } from '@chess-prep/shared';

const ENABLED = Boolean(process.env.DATABASE_URL);

describe('Phase 9d — refutation shadow lines are stored but never prep (integration)', () => {
  if (!ENABLED) {
    it.skip('DATABASE_URL not set — skipping integration test', () => {});
    return;
  }

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

  async function freshRep(name: string): Promise<string> {
    const { createRepertoire } = await import('./repertoires.js');
    const rep = await createRepertoire(DEFAULT_USER_ID, {
      name: `phase9d-refutation ${name} ${Date.now()}-${Math.random()}`,
      color: 'white',
    });
    repertoireIdsToCleanup.push(rep.id);
    return rep.id;
  }

  async function cardsFor(moveIds: string[]) {
    const { db } = await import('../db/client.js');
    const { srsCards } = await import('../db/schema.js');
    const { inArray } = await import('drizzle-orm');
    if (moveIds.length === 0) return [];
    return await db.select().from(srsCards).where(inArray(srsCards.moveId, moveIds));
  }

  it('creates no SRS card for any ply, including the user-side ones', async () => {
    const { appendRefutation, getRepertoire } = await import('./repertoires.js');
    const repId = await freshRep('no-cards');

    // 1.h4 is white's (the user's) move — the mistake — and the line then
    // alternates, so plies 1 and 3 are user-side. None may be carded.
    const result = await appendRefutation(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['h4', 'd5', 'g4', 'Qd6'],
    });
    expect(result.added).toBe(4);

    const full = await getRepertoire(DEFAULT_USER_ID, repId);
    expect(full.moves.every((m) => m.isRefutation)).toBe(true);
    expect(await cardsFor(full.moves.map((m) => m.id))).toHaveLength(0);
  });

  it('does not occupy the one prep slot at a user-turn position', async () => {
    const { appendLine, appendRefutation, getRepertoire } = await import('./repertoires.js');
    const repId = await freshRep('slot');

    await appendRefutation(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['h4'],
    });
    // The real prep at the same position must still go in — no 409.
    const prep = await appendLine(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['e4'],
    });
    expect(prep.added).toBe(1);

    const full = await getRepertoire(DEFAULT_USER_ID, repId);
    const e4 = full.moves.find((m) => m.san === 'e4')!;
    expect(e4.isRefutation).toBe(false);
    expect(await cardsFor([e4.id])).toHaveLength(1);
    // And the shadow move is still there, still a shadow.
    expect(full.moves.find((m) => m.san === 'h4')!.isRefutation).toBe(true);
  });

  it('is omitted from PGN export', async () => {
    const { appendLine, appendRefutation, exportPgn } = await import('./repertoires.js');
    const repId = await freshRep('export');

    await appendLine(DEFAULT_USER_ID, repId, { fromFenKey: STARTING_FEN_KEY, sans: ['e4'] });
    await appendRefutation(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['h4', 'd5'],
    });

    const pgn = await exportPgn(DEFAULT_USER_ID, repId);
    expect(pgn).toContain('e4');
    expect(pgn).not.toContain('h4');
  });

  it('promotes a shadow edge to prep — with its card — when the user preps that move', async () => {
    const { appendRefutation, addMove, getRepertoire } = await import('./repertoires.js');
    const repId = await freshRep('promote');

    await appendRefutation(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['h4', 'd5'],
    });
    const added = await addMove(DEFAULT_USER_ID, repId, {
      parentFenKey: STARTING_FEN_KEY,
      san: 'h4',
    });
    expect(added.isRefutation).toBe(false);
    expect(await cardsFor([added.id])).toHaveLength(1);

    // The rest of the line stays a shadow: only the edge the user actually
    // prepped is promoted.
    const full = await getRepertoire(DEFAULT_USER_ID, repId);
    expect(full.moves.find((m) => m.san === 'd5')!.isRefutation).toBe(true);
  });

  it('never demotes existing prep when a refutation walks over it', async () => {
    const { appendLine, appendRefutation, getRepertoire } = await import('./repertoires.js');
    const repId = await freshRep('no-demote');

    await appendLine(DEFAULT_USER_ID, repId, { fromFenKey: STARTING_FEN_KEY, sans: ['e4'] });
    const e4Before = (await getRepertoire(DEFAULT_USER_ID, repId)).moves.find(
      (m) => m.san === 'e4',
    )!;

    // A punishment line that happens to start with the user's real prep.
    await appendRefutation(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans: ['e4', 'd5'],
    });

    const full = await getRepertoire(DEFAULT_USER_ID, repId);
    const e4 = full.moves.find((m) => m.san === 'e4')!;
    expect(e4.id).toBe(e4Before.id);
    expect(e4.isRefutation).toBe(false);
    expect(await cardsFor([e4.id])).toHaveLength(1);
    expect(full.moves.find((m) => m.san === 'd5')!.isRefutation).toBe(true);
  });

  it('is idempotent: re-saving the same refutation adds nothing', async () => {
    const { appendRefutation } = await import('./repertoires.js');
    const repId = await freshRep('idempotent');

    const sans = ['h4', 'd5', 'g4'];
    const first = await appendRefutation(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans,
    });
    const second = await appendRefutation(DEFAULT_USER_ID, repId, {
      fromFenKey: STARTING_FEN_KEY,
      sans,
    });
    expect(first.added).toBe(3);
    expect(second.added).toBe(0);
    expect(second.reused).toBe(3);
  });

  it('rejects a line longer than the ply cap', async () => {
    const { appendRefutation, HttpError } = await import('./repertoires.js');
    const repId = await freshRep('cap');

    await expect(
      appendRefutation(DEFAULT_USER_ID, repId, {
        fromFenKey: STARTING_FEN_KEY,
        sans: ['h4', 'd5', 'g4', 'Qd6', 'a4', 'Qxh2', 'a5'],
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
