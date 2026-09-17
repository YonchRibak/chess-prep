import { describe, it, expect } from 'vitest';
import {
  applyStudyPrepPolicy,
  liveReachablePositions,
  mergeChapterTrees,
  parseStudyChapters,
  studyHeader,
  studyPgnToTree,
} from './study.js';
import { InvalidPgnError, pgnToTree } from './pgn.js';
import { fenKey, STARTING_FEN, STARTING_FEN_KEY } from './fen.js';

function chapter(study: string, name: string, moves: string, extra: string[] = []): string {
  return [
    `[Event "${study}: ${name}"]`,
    `[Site "https://lichess.org/study/abc12345/${name.replace(/\W/g, '').slice(0, 8) || 'ch'}"]`,
    '[Result "*"]',
    '[Variant "Standard"]',
    `[StudyName "${study}"]`,
    `[ChapterName "${name}"]`,
    ...extra,
    '',
    `${moves} *`,
    '',
  ].join('\n');
}

const TWO_CHAPTERS =
  chapter('Caro prep', 'Advance', '1. e4 c6 2. d4 d5 3. e5 { The Advance } Bf5') +
  '\n' +
  chapter('Caro prep', 'Exchange', '1. e4 c6 2. d4 d5 3. exd5 cxd5 4. Bd3');

const after = (sans: string) => fenKey(pgnToTree(`${sans} *`).moves.at(-1)!.childFenKey);

describe('parseStudyChapters', () => {
  it('splits a multi-game export into named chapters with trimmed comments', () => {
    const chapters = parseStudyChapters(TWO_CHAPTERS);
    expect(chapters.map((c) => c.name)).toEqual(['Advance', 'Exchange']);
    expect(chapters.map((c) => c.tag)).toEqual(['Advance', 'Exchange']);
    expect(chapters[0]!.url).toBe('https://lichess.org/study/abc12345/Advance');
    const e5 = chapters[0]!.tree.moves.find((m) => m.san === 'e5');
    expect(e5?.comment).toBe('The Advance');
  });

  it('falls back to the Event header and then to "Chapter N" for names', () => {
    const pgn =
      '[Event "My study: From event"]\n\n1. e4 *\n\n' +
      '[Event "Untitled"]\n\n1. d4 *\n\n' +
      '1. c4 *\n';
    const names = parseStudyChapters(pgn).map((c) => c.name);
    expect(names).toEqual(['From event', 'Untitled', 'Chapter 3']);
  });

  it('ignores an empty trailing game produced by a stray result token', () => {
    expect(parseStudyChapters('1. e4 * *')).toHaveLength(1);
  });

  it('suffixes tags that would collide case-insensitively', () => {
    const pgn = chapter('S', 'Main', '1. e4') + '\n' + chapter('S', 'main', '1. d4');
    expect(parseStudyChapters(pgn).map((c) => c.tag)).toEqual(['Main', 'main (2)']);
  });

  it('honours a [FEN] start position per chapter', () => {
    const fen = '4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1';
    const pgn = chapter('S', 'Endgame', '1... Kd8 2. Qe7+', [`[FEN "${fen}"]`, '[SetUp "1"]']);
    const [ch] = parseStudyChapters(pgn);
    expect(ch!.startFen).toBe(fen);
    expect(ch!.tree.rootFenKey).toBe(fenKey(fen));
  });

  it('rejects non-standard variants, empty input, and illegal moves with the chapter name', () => {
    expect(() => parseStudyChapters(chapter('S', 'X', '1. e4', ['[Variant "Antichess"]']))).toThrow(
      InvalidPgnError,
    );
    expect(() => parseStudyChapters('   ')).toThrow(InvalidPgnError);
    expect(() => parseStudyChapters(chapter('S', 'Broken', '1. e4 e4'))).toThrow(/Broken/);
  });

  it('reads the study name and url from the first chapter', () => {
    expect(studyHeader(TWO_CHAPTERS)).toEqual({
      studyName: 'Caro prep',
      studyUrl: 'https://lichess.org/study/abc12345',
    });
    expect(studyHeader('1. e4 *')).toEqual({ studyName: null, studyUrl: null });
  });
});

describe('mergeChapterTrees', () => {
  it('unions chapters; a shared prefix edge carries every chapter tag', () => {
    const { tree } = mergeChapterTrees(parseStudyChapters(TWO_CHAPTERS));
    expect(tree.rootFenKey).toBe(STARTING_FEN_KEY);
    const e4 = tree.moves.find((m) => m.san === 'e4')!;
    expect(e4.lineTags).toEqual(['Advance', 'Exchange']);
    const e5 = tree.moves.find((m) => m.san === 'e5')!;
    expect(e5.lineTags).toEqual(['Advance']);
    const bd3 = tree.moves.find((m) => m.san === 'Bd3')!;
    expect(bd3.lineTags).toEqual(['Exchange']);
    // Both third moves are main-line in their own chapter.
    expect(e5.isMainLine).toBe(true);
    expect(tree.moves.find((m) => m.san === 'exd5')!.isMainLine).toBe(true);
  });

  it('keeps the first chapter\'s comment when a later chapter comments the same edge', () => {
    const pgn =
      chapter('S', 'A', '1. e4 { first } c6') + '\n' + chapter('S', 'B', '1. e4 { second } e5');
    const { tree } = mergeChapterTrees(parseStudyChapters(pgn));
    expect(tree.moves.find((m) => m.san === 'e4')!.comment).toBe('first');
  });

  it('attaches a [FEN] chapter that starts inside an earlier chapter', () => {
    const mid = pgnToTree('1. e4 c6 2. d4 d5 *');
    const midFen = mid.positions.find((p) => p.fenKey === mid.moves.at(-1)!.childFenKey)!.fullFen;
    const pgn =
      chapter('S', 'A', '1. e4 c6 2. d4 d5 3. e5') +
      '\n' +
      chapter('S', 'B', '3. Nc3 dxe4', [`[FEN "${midFen}"]`, '[SetUp "1"]']);
    const { tree } = mergeChapterTrees(parseStudyChapters(pgn));
    expect(tree.moves.find((m) => m.san === 'Nc3')!.lineTags).toEqual(['B']);
  });

  it('rejects a chapter whose start position the study never reaches', () => {
    const pgn =
      chapter('S', 'A', '1. e4 c6') +
      '\n' +
      chapter('S', 'Detached', '1... Kd8', ['[FEN "4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1"]', '[SetUp "1"]']);
    expect(() => mergeChapterTrees(parseStudyChapters(pgn))).toThrow(/Detached/);
  });
});

describe('applyStudyPrepPolicy', () => {
  it('demotes a hero-turn variation and reports it', () => {
    const pgn = chapter('S', 'A', '1. e4 c5 2. Nf3 (2. Nc3 Nc6 3. g3) d6');
    const { tree, demoted } = applyStudyPrepPolicy(mergeChapterTrees(parseStudyChapters(pgn)), 'white');
    const nc3 = tree.moves.find((m) => m.san === 'Nc3')!;
    expect(nc3.isDropped).toBe(true);
    expect(nc3.isMainLine).toBe(false);
    expect(tree.moves.find((m) => m.san === 'Nf3')!.isDropped).toBe(false);
    expect(demoted).toEqual([
      {
        parentFenKey: after('1. e4 c5'),
        san: 'Nc3',
        chapter: 'A',
        keptSan: 'Nf3',
        keptChapter: 'A',
        reason: 'variation',
      },
    ]);
    // Moves inside the demoted subtree are not themselves marked dropped.
    expect(tree.moves.find((m) => m.san === 'g3')!.isDropped).toBe(false);
  });

  it('leaves opponent-turn alternates alone', () => {
    const pgn = chapter('S', 'A', '1. e4 c5 (1... e5 2. Nf3) 2. Nf3');
    const { tree, demoted } = applyStudyPrepPolicy(mergeChapterTrees(parseStudyChapters(pgn)), 'white');
    expect(demoted).toEqual([]);
    expect(tree.moves.filter((m) => m.isDropped)).toHaveLength(0);
  });

  it('first chapter wins a cross-chapter main-line conflict', () => {
    const pgn =
      chapter('S', 'Nf3 lines', '1. e4 c5 2. Nf3 d6') + '\n' + chapter('S', 'Closed', '1. e4 c5 2. Nc3 Nc6');
    const { tree, demoted } = applyStudyPrepPolicy(mergeChapterTrees(parseStudyChapters(pgn)), 'white');
    expect(tree.moves.find((m) => m.san === 'Nc3')!.isDropped).toBe(true);
    expect(demoted).toHaveLength(1);
    expect(demoted[0]).toMatchObject({
      san: 'Nc3',
      chapter: 'Closed',
      keptSan: 'Nf3',
      keptChapter: 'Nf3 lines',
      reason: 'cross-chapter',
    });
  });

  it('prefers a later chapter\'s main line over an earlier chapter\'s variation', () => {
    const pgn =
      chapter('S', 'A', '1. e4 c5 2. Nf3 (2. Nc3 Nc6) d6') + '\n' + chapter('S', 'B', '1. e4 c5 2. Nc3 Nc6');
    // Chapter A's main line is Nf3, so Nf3 still wins (earliest main-line chapter).
    const { tree } = applyStudyPrepPolicy(mergeChapterTrees(parseStudyChapters(pgn)), 'white');
    expect(tree.moves.find((m) => m.san === 'Nf3')!.isDropped).toBe(false);
    expect(tree.moves.find((m) => m.san === 'Nc3')!.isDropped).toBe(true);
  });

  it('respects turn parity for a black repertoire', () => {
    const pgn = chapter('S', 'A', '1. e4 c5 (1... e5) 2. Nf3 (2. Nc3) d6');
    const { tree, demoted } = applyStudyPrepPolicy(mergeChapterTrees(parseStudyChapters(pgn)), 'black');
    expect(tree.moves.find((m) => m.san === 'e5')!.isDropped).toBe(true);
    expect(tree.moves.find((m) => m.san === 'Nc3')!.isDropped).toBe(false);
    expect(demoted.map((d) => d.san)).toEqual(['e5']);
  });

  it('promotes a sole hero move that the study wrote as a variation', () => {
    // Black's only reply is inside a bracket; for a black repertoire it is the prep.
    const pgn = chapter('S', 'A', '1. e4 (1. d4 d5) e5');
    const { tree } = applyStudyPrepPolicy(mergeChapterTrees(parseStudyChapters(pgn)), 'black');
    expect(tree.moves.find((m) => m.san === 'd5')!.isMainLine).toBe(true);
  });
});

describe('liveReachablePositions', () => {
  it('excludes the subtree under a demoted alternate but includes a live transposition', () => {
    // 2.Nc3 is demoted; 2...Nc6 3.Nf3 transposes into the live 2.Nf3 Nc6 3.Nc3 position.
    const pgn = chapter('S', 'A', '1. e4 c5 2. Nf3 (2. Nc3 Nc6 3. g3 (3. Nf3 g6 4. d4)) Nc6 3. Nc3');
    const { tree } = applyStudyPrepPolicy(mergeChapterTrees(parseStudyChapters(pgn)), 'white');
    const live = liveReachablePositions(tree);
    expect(live.has(after('1. e4 c5 2. Nc3'))).toBe(false);
    expect(live.has(after('1. e4 c5 2. Nc3 Nc6'))).toBe(false);
    // Only reachable through the demoted branch.
    expect(live.has(after('1. e4 c5 2. Nc3 Nc6 3. g3'))).toBe(false);
    // Reached live via 2.Nf3 Nc6 3.Nc3 — and everything below it is live too.
    expect(live.has(after('1. e4 c5 2. Nc3 Nc6 3. Nf3'))).toBe(true);
    expect(live.has(after('1. e4 c5 2. Nc3 Nc6 3. Nf3 g6'))).toBe(true);
  });
});

describe('studyPgnToTree', () => {
  it('agrees with pgnToTree on a single chapter, modulo tags, trimming and hero promotion', () => {
    const body = '1. e4 c5 (1... e5 2. Nf3 { Open }) 2. Nf3 d6';
    const study = studyPgnToTree(chapter('S', 'Only', body), 'white');
    const legacy = pgnToTree(`${body} *`);
    const strip = (t: typeof legacy) =>
      t.moves.map((m) => `${m.parentFenKey}::${m.san}::${m.comment?.trim() ?? ''}`).sort();
    expect(strip(study.tree)).toEqual(strip(legacy));
    // The one difference: a sole hero move inside a bracket is promoted to the line.
    const nf3AfterE5 = study.tree.moves.find((m) => m.san === 'Nf3' && m.comment === 'Open')!;
    expect(nf3AfterE5.isMainLine).toBe(true);
    expect(legacy.moves.find((m) => m.san === 'Nf3' && m.comment?.trim() === 'Open')!.isMainLine).toBe(
      false,
    );
    expect(study.tree.moves.every((m) => m.lineTags?.length === 1 && m.lineTags[0] === 'Only')).toBe(
      true,
    );
    expect(study.studyName).toBe('S');
    expect(study.chapters).toEqual([
      { tag: 'Only', name: 'Only', url: 'https://lichess.org/study/abc12345/Only' },
    ]);
    expect(study.tree.rootFullFen).toBe(STARTING_FEN);
  });
});
