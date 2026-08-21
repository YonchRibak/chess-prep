/**
 * Malformed uuids must not reach Postgres.
 *
 * Every `/:id` service used to hand the raw path parameter straight to a uuid
 * column, so `GET /repertoires/not-a-uuid` died on the cast (`22P02`) and came
 * back as `500 Internal error` — a server-fault status for an ordinary client
 * typo, and an error body that says nothing.
 *
 * The rule these tests pin down is that the *kind* of id decides the answer:
 *
 * - a path parameter naming a resource → **404**, identical to a well-formed id
 *   that does not exist, so no client has to branch on whether an id is shaped
 *   right;
 * - a query filter → **400**, because the request is malformed rather than the
 *   thing being absent;
 * - an id inside a sync batch → **skipped**, because these are the offline
 *   queues draining and one bad row must not block every real grade behind it.
 *   (It is skipped silently: the `ignored` count only covers rows that reached
 *   the ownership check. Worth knowing, not worth changing — the client clears
 *   its queue regardless of the totals.)
 *
 * Only the last one needs a database, so the rest run anywhere.
 */
import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_ID } from '@chess-prep/shared';

const ENABLED = Boolean(process.env.DATABASE_URL);
const GARBAGE = 'not-a-uuid';
const WELL_FORMED_BUT_ABSENT = '00000000-0000-0000-0000-0000000000ff';

async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  const { HttpError } = await import('./repertoires.js');
  try {
    await fn();
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

describe('isUuid', () => {
  it('accepts a canonical uuid in either case and rejects near-misses', async () => {
    const { isUuid } = await import('./repertoires.js');
    expect(isUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toBe(true);

    expect(isUuid(GARBAGE)).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid('3f2504e0-4f89-11d3-9a0c-0305e82c330')).toBe(false); // one short
    expect(isUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301x')).toBe(false); // trailing
    expect(isUuid('3f2504e0_4f89_11d3_9a0c_0305e82c3301')).toBe(false); // wrong sep
    expect(isUuid('gggggggg-4f89-11d3-9a0c-0305e82c3301')).toBe(false); // non-hex
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(12345)).toBe(false);
  });
});

describe('malformed ids on resource paths → 404, not 500', () => {
  if (!ENABLED) {
    it.skip('DATABASE_URL not set — skipping integration test', () => {});
    return;
  }

  it('answers 404 for every by-id service, exactly as an absent id does', async () => {
    const svc = await import('./repertoires.js');

    const byId: Array<[string, (id: string) => Promise<unknown>]> = [
      ['getRepertoire', (id) => svc.getRepertoire(DEFAULT_USER_ID, id)],
      ['patchRepertoire', (id) => svc.patchRepertoire(DEFAULT_USER_ID, id, { name: 'x' })],
      ['deleteRepertoire', (id) => svc.deleteRepertoire(DEFAULT_USER_ID, id)],
      ['exportPgn', (id) => svc.exportPgn(DEFAULT_USER_ID, id)],
      ['patchDrillRules', (id) => svc.patchDrillRules(DEFAULT_USER_ID, id, {})],
      [
        'addMove',
        (id) => svc.addMove(DEFAULT_USER_ID, id, { parentFenKey: 'x', san: 'e4' }),
      ],
      ['appendLine', (id) => svc.appendLine(DEFAULT_USER_ID, id, { fromFenKey: 'x', sans: [] })],
      [
        'appendRefutation',
        (id) => svc.appendRefutation(DEFAULT_USER_ID, id, { fromFenKey: 'x', sans: ['e4'] }),
      ],
      ['patchMove', (id) => svc.patchMove(DEFAULT_USER_ID, id, id, { priority: 1 })],
      ['deleteMove', (id) => svc.deleteMove(DEFAULT_USER_ID, id, id)],
    ];

    for (const [name, call] of byId) {
      expect(await statusOf(() => call(GARBAGE)), `${name} (malformed)`).toBe(404);
      // The pairing is the point: garbage and absent-but-valid are the same
      // answer, so nothing downstream can tell them apart.
      expect(await statusOf(() => call(WELL_FORMED_BUT_ABSENT)), `${name} (absent)`).toBe(404);
    }
  });

  it('rejects a malformed moveId even when the repertoire id is fine', async () => {
    const { createRepertoire, deleteRepertoire, patchMove } = await import('./repertoires.js');
    const rep = await createRepertoire(DEFAULT_USER_ID, {
      name: `malformed-id ${Date.now()}-${Math.random()}`,
      color: 'white',
    });
    try {
      expect(await statusOf(() => patchMove(DEFAULT_USER_ID, rep.id, GARBAGE, { priority: 1 }))).toBe(
        404,
      );
    } finally {
      await deleteRepertoire(DEFAULT_USER_ID, rep.id);
    }
  });
});

describe('malformed ids elsewhere', () => {
  if (!ENABLED) {
    it.skip('DATABASE_URL not set — skipping integration test', () => {});
    return;
  }

  it('400s a malformed repertoireId filter rather than 404 or 500', async () => {
    const { pullCards } = await import('./srs.js');
    const { listAttempts } = await import('./attempts.js');

    expect(await statusOf(() => pullCards(DEFAULT_USER_ID, undefined, GARBAGE))).toBe(400);
    expect(await statusOf(() => listAttempts(DEFAULT_USER_ID, undefined, GARBAGE))).toBe(400);

    // A well-formed filter matching nothing is a valid, empty result — not an error.
    const cards = await pullCards(DEFAULT_USER_ID, undefined, WELL_FORMED_BUT_ABSENT);
    expect(cards.cards).toEqual([]);
  });

  it('skips a malformed id inside a sync batch instead of failing the batch', async () => {
    const { pushCards } = await import('./srs.js');
    const { recordAttempts } = await import('./attempts.js');
    const now = new Date().toISOString();

    const pushed = await pushCards(DEFAULT_USER_ID, [
      { moveId: GARBAGE, due: now, updatedAt: now, state: 0 },
    ]);
    expect(pushed.accepted).toBe(0);

    const appended = await recordAttempts(DEFAULT_USER_ID, [
      { moveId: GARBAGE, playedSan: 'e4', wasCorrect: false, at: now },
    ]);
    expect(appended.accepted).toBe(0);

    // The point is that neither call threw: before the guard, both died on the
    // uuid cast and took the whole queue drain down with them.
    const good = await recordAttempts(DEFAULT_USER_ID, []);
    expect(good.accepted).toBe(0);
  });
});
