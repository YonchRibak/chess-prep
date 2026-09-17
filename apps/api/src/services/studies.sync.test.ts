/**
 * Study S2 integration test: import + re-import of a lichess study.
 *
 * What these pin down, in order of how silently each would break:
 *
 * - a re-import of an unchanged study touches nothing and **keeps every card
 *   row** (ids unchanged) — the whole point of syncing instead of reloading;
 * - moves the study dropped are deleted, moves it changed are updated, and
 *   the summary's counts say so;
 * - the hero prep policy is honoured on disk: a demoted alternate is dropped
 *   and uncarded, and swapping which move is main-line in the study moves the
 *   prep slot (old card kept, new card created);
 * - a refutation shadow line the user recorded survives a re-import, and so
 *   do its positions;
 * - an opponent-side manual drop survives; a hero-side one is overwritten;
 * - the update path refuses hand-built repertoires and root changes;
 * - undropping a demoted alternate in the editor hits the one-prep invariant.
 *
 * Skips without DATABASE_URL, like the other integration suites.
 */
import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_USER_ID, fenKey, pgnToTree } from '@chess-prep/shared';

const ENABLED = Boolean(process.env.DATABASE_URL);

function chapter(name: string, moves: string, extra: string[] = []): string {
  return [
    `[Event "S2 study: ${name}"]`,
    `[Site "https://lichess.org/study/s2test00/${name.replace(/\W/g, '')}"]`,
    '[Result "*"]',
    '[Variant "Standard"]',
    '[StudyName "S2 study"]',
    `[ChapterName "${name}"]`,
    ...extra,
    '',
    `${moves} *`,
    '',
  ].join('\n');
}

const A_V1 = chapter('Sicilian', '1. e4 c5 2. Nf3 (2. Nc3 Nc6) d6 { Najdorf-ish }');
const B_V1 = chapter('Open', '1. e4 e5 2. Nf3 Nc6 3. Bb5');
const STUDY_V1 = `${A_V1}\n${B_V1}`;

const keyAfter = (sans: string) => pgnToTree(`${sans} *`).moves.at(-1)!.childFenKey;

describe('Study S2 — import and re-import sync (integration)', () => {
  if (!ENABLED) {
    it.skip('DATABASE_URL not set — skipping integration test', () => {});
    return;
  }

  // Accumulates across the whole file on purpose — see repertoires.invariant.test.ts.
  const repertoireIdsToCleanup: string[] = [];

  afterAll(async () => {
    const { db } = await import('../db/client.js');
    const { repertoires } = await import('../db/schema.js');
    const { inArray } = await import('drizzle-orm');
    if (repertoireIdsToCleanup.length > 0) {
      await db.delete(repertoires).where(inArray(repertoires.id, repertoireIdsToCleanup));
    }
  });

  async function cardsByMoveId(moveIds: string[]): Promise<Map<string, string>> {
    const { db } = await import('../db/client.js');
    const { srsCards } = await import('../db/schema.js');
    const { inArray } = await import('drizzle-orm');
    if (moveIds.length === 0) return new Map();
    const rows = await db.select().from(srsCards).where(inArray(srsCards.moveId, moveIds));
    return new Map(rows.map((r) => [r.moveId, r.id]));
  }

  async function importV1() {
    const { importStudy } = await import('./studies.js');
    const res = await importStudy(DEFAULT_USER_ID, {
      pgn: STUDY_V1,
      color: 'white',
      name: `s2-sync ${Date.now()}-${Math.random()}`,
    });
    repertoireIdsToCleanup.push(res.repertoire.id);
    return res;
  }

  const edge = (rep: { moves: { parentFenKey: string; san: string }[] }, parentSans: string, san: string) =>
    rep.moves.find((m) => m.parentFenKey === fenKey(keyAfter(parentSans)) && m.san === san);

  it('imports two chapters: tags, provenance, demoted alternate uncarded, cards for live hero moves', async () => {
    const { repertoire: rep, summary } = await importV1();

    expect(rep.source?.kind).toBe('lichess-study');
    expect(rep.source?.studyName).toBe('S2 study');
    expect(rep.source?.chapters.map((c) => c.tag)).toEqual(['Sicilian', 'Open']);
    expect(rep.source?.pgnSha256).toMatch(/^[0-9a-f]{64}$/);

    const e4 = rep.moves.find((m) => m.san === 'e4')!;
    expect(e4.lineTags).toEqual(['Sicilian', 'Open']);
    expect(rep.moves.find((m) => m.san === 'Bb5')!.lineTags).toEqual(['Open']);

    const nc3 = edge(rep, '1. e4 c5', 'Nc3')!;
    expect(nc3.isDropped).toBe(true);
    expect(summary.demoted).toHaveLength(1);
    expect(summary.demoted[0]).toMatchObject({ san: 'Nc3', keptSan: 'Nf3', reason: 'variation' });

    expect(rep.moves.find((m) => m.san === 'd6')!.comment).toBe('Najdorf-ish');

    const cards = await cardsByMoveId(rep.moves.map((m) => m.id));
    // Hero (white) moves reachable live: e4, Nf3 (after c5), Nf3 (after e5), Bb5.
    expect(summary.cardsCreated).toBe(4);
    expect(cards.has(e4.id)).toBe(true);
    expect(cards.has(nc3.id)).toBe(false);
    expect(cards.has(rep.moves.find((m) => m.san === 'c5')!.id)).toBe(false);
    expect(summary.movesAdded).toBe(rep.moves.length);
    expect(summary.chapters).toBe(2);
  });

  it('re-importing the identical study changes nothing and keeps every card row', async () => {
    const { updateStudy } = await import('./studies.js');
    const { repertoire: before } = await importV1();
    const cardsBefore = await cardsByMoveId(before.moves.map((m) => m.id));

    const { repertoire: after, summary } = await updateStudy(DEFAULT_USER_ID, before.id, { pgn: STUDY_V1 });
    expect(summary).toMatchObject({
      movesAdded: 0,
      movesUpdated: 0,
      movesRemoved: 0,
      positionsAdded: 0,
      positionsRemoved: 0,
      cardsCreated: 0,
      cardsKept: 4,
    });
    expect(after.moves.map((m) => m.id).sort()).toEqual(before.moves.map((m) => m.id).sort());
    const cardsAfter = await cardsByMoveId(after.moves.map((m) => m.id));
    expect([...cardsAfter.entries()].sort()).toEqual([...cardsBefore.entries()].sort());
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
  });

  it('updates a changed comment and deletes a removed line (with its card), keeping the rest', async () => {
    const { updateStudy } = await import('./studies.js');
    const { repertoire: before } = await importV1();
    const bb5 = before.moves.find((m) => m.san === 'Bb5')!;
    const keptIds = before.moves.filter((m) => m.san !== 'Bb5').map((m) => m.id);
    const cardsBefore = await cardsByMoveId(keptIds);

    const v2 =
      chapter('Sicilian', '1. e4 c5 2. Nf3 (2. Nc3 Nc6) d6 { Now with a better note }') +
      '\n' +
      chapter('Open', '1. e4 e5 2. Nf3 Nc6');
    const { repertoire: after, summary } = await updateStudy(DEFAULT_USER_ID, before.id, { pgn: v2 });

    expect(summary.movesUpdated).toBe(1);
    expect(summary.movesRemoved).toBe(1);
    expect(summary.positionsRemoved).toBe(1);
    expect(after.moves.find((m) => m.id === bb5.id)).toBeUndefined();
    expect(after.moves.find((m) => m.san === 'd6')!.comment).toBe('Now with a better note');
    expect((await cardsByMoveId([bb5.id])).size).toBe(0);
    expect([...(await cardsByMoveId(keptIds)).entries()].sort()).toEqual([...cardsBefore.entries()].sort());
  });

  it('moves the prep slot when the study swaps its main line: old card kept, new card created', async () => {
    const { updateStudy } = await import('./studies.js');
    const { repertoire: before } = await importV1();
    const nf3 = edge(before, '1. e4 c5', 'Nf3')!;
    const nc3 = edge(before, '1. e4 c5', 'Nc3')!;
    const nf3CardBefore = (await cardsByMoveId([nf3.id])).get(nf3.id);
    expect(nf3CardBefore).toBeDefined();

    const v2 = chapter('Sicilian', '1. e4 c5 2. Nc3 (2. Nf3 d6) Nc6') + '\n' + B_V1;
    const { repertoire: after, summary } = await updateStudy(DEFAULT_USER_ID, before.id, { pgn: v2 });

    const nf3After = after.moves.find((m) => m.id === nf3.id)!;
    const nc3After = after.moves.find((m) => m.id === nc3.id)!;
    expect(nf3After.isDropped).toBe(true);
    expect(nc3After.isDropped).toBe(false);
    expect(nc3After.isMainLine).toBe(true);
    expect(summary.cardsCreated).toBe(1);
    expect(summary.demoted[0]).toMatchObject({ san: 'Nf3', keptSan: 'Nc3' });
    const cards = await cardsByMoveId([nf3.id, nc3.id]);
    expect(cards.get(nf3.id)).toBe(nf3CardBefore); // kept for SRS history
    expect(cards.has(nc3.id)).toBe(true);
  });

  it('keeps a refutation shadow line and its positions across a re-import', async () => {
    const { updateStudy } = await import('./studies.js');
    const { appendRefutation } = await import('./repertoires.js');
    const { repertoire: before } = await importV1();

    // The user played 2...a6?! and the engine punished it — a shadow line.
    const ref = await appendRefutation(DEFAULT_USER_ID, before.id, {
      fromFenKey: fenKey(keyAfter('1. e4 c5 2. Nf3')),
      sans: ['a6', 'd4', 'cxd4'],
    });
    expect(ref.added).toBe(3);

    const { repertoire: after, summary } = await updateStudy(DEFAULT_USER_ID, before.id, { pgn: STUDY_V1 });
    expect(summary.refutationsKept).toBe(3);
    expect(summary.movesRemoved).toBe(0);
    expect(summary.positionsRemoved).toBe(0);
    const shadows = after.moves.filter((m) => m.isRefutation);
    expect(shadows.map((m) => m.san).sort()).toEqual(['a6', 'cxd4', 'd4']);
    for (const s of shadows) {
      expect(after.positions.some((p) => p.id === s.childPositionId)).toBe(true);
    }
  });

  it('preserves an opponent-side manual drop but resets a hero-side one from the PGN', async () => {
    const { updateStudy } = await import('./studies.js');
    const { patchMove } = await import('./repertoires.js');
    const { repertoire: before } = await importV1();
    const e5 = edge(before, '1. e4', 'e5')!; // opponent reply
    const bb5 = before.moves.find((m) => m.san === 'Bb5')!; // hero move
    await patchMove(DEFAULT_USER_ID, before.id, e5.id, { isDropped: true });
    await patchMove(DEFAULT_USER_ID, before.id, bb5.id, { isDropped: true });

    const { repertoire: after } = await updateStudy(DEFAULT_USER_ID, before.id, { pgn: STUDY_V1 });
    expect(after.moves.find((m) => m.id === e5.id)!.isDropped).toBe(true);
    expect(after.moves.find((m) => m.id === bb5.id)!.isDropped).toBe(false);
  });

  it('refuses to update a hand-built repertoire or one whose root moved', async () => {
    const { updateStudy } = await import('./studies.js');
    const { createRepertoire, HttpError } = await import('./repertoires.js');
    const plain = await createRepertoire(DEFAULT_USER_ID, {
      name: `s2-sync plain ${Date.now()}`,
      color: 'white',
    });
    repertoireIdsToCleanup.push(plain.id);
    await expect(updateStudy(DEFAULT_USER_ID, plain.id, { pgn: STUDY_V1 })).rejects.toMatchObject({
      status: 400,
    });

    const { repertoire } = await importV1();
    const moved = chapter('Endgame', '1... Kd8 2. Qe7+', [
      '[FEN "4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1"]',
      '[SetUp "1"]',
    ]);
    await expect(updateStudy(DEFAULT_USER_ID, repertoire.id, { pgn: moved })).rejects.toMatchObject({
      status: 400,
    });
    await expect(updateStudy(DEFAULT_USER_ID, repertoire.id, { pgn: 'garbage ###' })).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('undropping a demoted hero alternate in the editor hits the one-prep invariant', async () => {
    const { patchMove } = await import('./repertoires.js');
    const { repertoire } = await importV1();
    const nc3 = edge(repertoire, '1. e4 c5', 'Nc3')!;
    await expect(
      patchMove(DEFAULT_USER_ID, repertoire.id, nc3.id, { isDropped: false }),
    ).rejects.toMatchObject({ status: 409 });
    // An opponent-side undrop is unaffected.
    const e5 = edge(repertoire, '1. e4', 'e5')!;
    await patchMove(DEFAULT_USER_ID, repertoire.id, e5.id, { isDropped: true });
    await expect(
      patchMove(DEFAULT_USER_ID, repertoire.id, e5.id, { isDropped: false }),
    ).resolves.toBeUndefined();
  });
  describe('S5 extensions (moves.origin)', () => {
    // The user records a deviation + reply in the app: 2...Nc6 3. d4, which
    // the study does not have. Both rows are `origin: 'user'`; d4 is carded.
    async function importWithExtension() {
      const { appendLine } = await import('./repertoires.js');
      const { repertoire: v1 } = await importV1();
      const res = await appendLine(DEFAULT_USER_ID, v1.id, {
        fromFenKey: fenKey(keyAfter('1. e4 c5 2. Nf3')),
        sans: ['Nc6', 'd4'],
      });
      expect(res.added).toBe(2);
      const { getRepertoire } = await import('./repertoires.js');
      const rep = await getRepertoire(DEFAULT_USER_ID, v1.id);
      const nc6 = edge(rep, '1. e4 c5 2. Nf3', 'Nc6')!;
      const d4 = edge(rep, '1. e4 c5 2. Nf3 Nc6', 'd4')!;
      expect(nc6.origin).toBe('user');
      expect(d4.origin).toBe('user');
      expect(rep.moves.find((m) => m.san === 'e4')!.origin).toBe('study');
      const d4Card = (await cardsByMoveId([d4.id])).get(d4.id);
      expect(d4Card).toBeDefined();
      return { rep, nc6, d4, d4Card: d4Card! };
    }

    it('keeps an extension, its card and its positions across an identical re-import', async () => {
      const { updateStudy } = await import('./studies.js');
      const { rep, nc6, d4, d4Card } = await importWithExtension();

      const { repertoire: after, summary } = await updateStudy(DEFAULT_USER_ID, rep.id, { pgn: STUDY_V1 });
      expect(summary).toMatchObject({
        movesRemoved: 0,
        positionsRemoved: 0,
        extensionsKept: 2,
        extensionsAdopted: 0,
        extensionsRemoved: 0,
        extensionsDemoted: [],
      });
      expect(after.moves.find((m) => m.id === nc6.id)?.origin).toBe('user');
      expect(after.moves.find((m) => m.id === d4.id)?.origin).toBe('user');
      expect(after.positions.some((p) => p.id === d4.childPositionId)).toBe(true);
      expect((await cardsByMoveId([d4.id])).get(d4.id)).toBe(d4Card);
    });

    it('is adopted by the study when a later version contains the same line — ids and card unchanged', async () => {
      const { updateStudy } = await import('./studies.js');
      const { rep, nc6, d4, d4Card } = await importWithExtension();

      const v2 = chapter('Sicilian', '1. e4 c5 2. Nf3 (2. Nc3 Nc6) d6 (2... Nc6 3. d4)') + '\n' + B_V1;
      const { repertoire: after, summary } = await updateStudy(DEFAULT_USER_ID, rep.id, { pgn: v2 });
      expect(summary.extensionsAdopted).toBe(2);
      expect(summary.extensionsKept).toBe(0);
      expect(summary.movesAdded).toBe(0);
      expect(after.moves.find((m) => m.id === nc6.id)?.origin).toBe('study');
      expect(after.moves.find((m) => m.id === d4.id)?.origin).toBe('study');
      expect((await cardsByMoveId([d4.id])).get(d4.id)).toBe(d4Card);
    });

    it('is demoted (dropped, card kept) when the study now plays a different hero move there', async () => {
      const { updateStudy } = await import('./studies.js');
      const { rep, d4, d4Card } = await importWithExtension();

      const v2 = chapter('Sicilian', '1. e4 c5 2. Nf3 (2. Nc3 Nc6) d6 (2... Nc6 3. Bb5)') + '\n' + B_V1;
      const { repertoire: after, summary } = await updateStudy(DEFAULT_USER_ID, rep.id, { pgn: v2 });
      expect(summary.extensionsAdopted).toBe(1); // Nc6
      expect(summary.extensionsKept).toBe(1); // d4
      expect(summary.extensionsDemoted).toEqual([
        { parentFenKey: fenKey(keyAfter('1. e4 c5 2. Nf3 Nc6')), san: 'd4', keptSan: 'Bb5' },
      ]);
      const d4After = after.moves.find((m) => m.id === d4.id)!;
      expect(d4After.isDropped).toBe(true);
      expect(d4After.origin).toBe('user');
      const parent = d4After.parentPositionId;
      const liveHero = after.moves.filter(
        (m) => m.parentPositionId === parent && !m.isDropped && !m.isRefutation,
      );
      expect(liveHero.map((m) => m.san)).toEqual(['Bb5']);
      expect((await cardsByMoveId([d4.id])).get(d4.id)).toBe(d4Card);
    });

    it('removes an extension whose parent line the study dropped', async () => {
      const { updateStudy } = await import('./studies.js');
      const { rep, nc6, d4 } = await importWithExtension();

      const { repertoire: after, summary } = await updateStudy(DEFAULT_USER_ID, rep.id, { pgn: B_V1 });
      expect(summary.extensionsRemoved).toBe(2);
      expect(summary.extensionsKept).toBe(0);
      expect(after.moves.find((m) => m.id === nc6.id)).toBeUndefined();
      expect(after.moves.find((m) => m.id === d4.id)).toBeUndefined();
      expect(after.positions.some((p) => p.id === d4.childPositionId)).toBe(false);
      expect((await cardsByMoveId([d4.id])).size).toBe(0);
    });

    it('exports extensions as ordinary prep', async () => {
      const { exportPgn } = await import('./repertoires.js');
      const { rep } = await importWithExtension();
      const pgn = await exportPgn(DEFAULT_USER_ID, rep.id);
      expect(pgn).toMatch(/Nc6 3\. d4/);
    });
  });
});
