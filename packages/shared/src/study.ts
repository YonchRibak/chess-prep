/**
 * Lichess study PGN → one repertoire tree.
 *
 * The study flow moves *preparation* to lichess and keeps this app for
 * *rehearsal*: a study export (one chapter, or the whole study as a
 * multi-game PGN) becomes a single repertoire, re-imported whenever the
 * study changes. Three rules turn a study into something drillable:
 *
 *  - **Chapters are line tags.** Every edge carries the tag of each chapter
 *    that contains it (a shared prefix such as `1.e4` belongs to all of them),
 *    so the existing `LineScope { kind: 'tag' }` machinery rehearses one
 *    chapter at a time with no new plumbing.
 *  - **Main line only at the user's turn.** A study routinely shows several
 *    of the hero's options at one position; the app's one-prep-per-position
 *    invariant allows exactly one. The move that is main-line in the earliest
 *    chapter claims the slot, everything else is imported as a *demoted*
 *    alternate (`isDropped: true`) — visible in the tree, never carded, and
 *    reported back so the user sees what the policy decided. Opponent-turn
 *    branches are untouched: several replies is the normal shape of prep.
 *  - **Connectivity.** Every chapter must be reachable from the first
 *    chapter's start position (through any edge, alternates included). A
 *    `[FEN]` chapter that starts somewhere else has no path from the walker's
 *    root and would be silently un-rehearsable — so it is rejected loudly.
 *
 * Everything here is pure so the API imports it for the sync and the web
 * client imports it to preview a file (chapter count, name) before upload.
 */
import * as pgnParser from '@mliebelt/pgn-parser';
import { STARTING_FEN, type FenKey } from './fen.js';
import { fenTurn, isUserMove } from './drill.js';
import { normalizeLineTag } from './scope.js';
import {
  InvalidPgnError,
  parsedMovesToTree,
  type ParsedMove,
  type RepertoireTree,
  type TreeMoveInput,
} from './pgn.js';
import type { Color } from './types.js';

/* ---------------- types ---------------- */

export interface StudyChapter {
  /** 0-based position in the PGN — the order that decides prep conflicts. */
  index: number;
  name: string;
  /** Line tag written on every edge of this chapter. Unique within the study. */
  tag: string;
  startFen: string;
  url: string | null;
  tree: RepertoireTree;
}

/** Chapter metadata without the tree — what provenance stores. */
export interface StudyChapterInfo {
  tag: string;
  name: string;
  url: string | null;
}

export type StudyDemotionReason =
  /** Main-line in its own chapter, but an earlier chapter's main line differs. */
  | 'cross-chapter'
  /** A variation at the hero's turn (never main-line anywhere). */
  | 'variation';

export interface StudyDemotion {
  parentFenKey: FenKey;
  san: string;
  /** Chapter that introduced the demoted move. */
  chapter: string;
  keptSan: string;
  keptChapter: string;
  reason: StudyDemotionReason;
}

export interface StudyParseResult {
  studyName: string | null;
  studyUrl: string | null;
  chapters: StudyChapterInfo[];
  tree: RepertoireTree;
  demoted: StudyDemotion[];
}

/**
 * Provenance stored on a study-sourced repertoire (`repertoires.source`).
 * `null` on hand-built repertoires; the update endpoint refuses those.
 */
export interface RepertoireSource {
  kind: 'lichess-study';
  studyName: string | null;
  studyUrl: string | null;
  chapters: StudyChapterInfo[];
  /** Hex SHA-256 of the exact PGN text last imported. */
  pgnSha256: string;
  importedAt: string;
}

/** What an import/update reports back — the wire shape of both study endpoints. */
export interface StudySyncSummary {
  chapters: number;
  positionsAdded: number;
  positionsRemoved: number;
  movesAdded: number;
  movesUpdated: number;
  movesRemoved: number;
  cardsCreated: number;
  /** Eligible cards that already existed — SRS history preserved. */
  cardsKept: number;
  demoted: StudyDemotion[];
  /** User-authored refutation shadow lines left untouched by the sync. */
  refutationsKept: number;
  /** S5 extensions (`origin: 'user'`) the study still lacks and the sync kept. */
  extensionsKept: number;
  /** Extensions the study now contains itself — row and card kept, now `'study'`. */
  extensionsAdopted: number;
  /** Extensions deleted because nothing live reaches their parent any more. */
  extensionsRemoved: number;
  /** Extensions parked (`isDropped`) because the study now plays another hero move there. */
  extensionsDemoted: StudyExtensionDemotion[];
}

export interface StudyExtensionDemotion {
  parentFenKey: FenKey;
  /** The user's extension move, now dropped. */
  san: string;
  /** The study's move that owns the prep slot. */
  keptSan: string;
}

/* ---------------- chapters ---------------- */

type ParsedGame = { tags?: Record<string, unknown>; moves?: ParsedMove[] };

function tagString(tags: Record<string, unknown> | undefined, key: string): string | null {
  const v = tags?.[key];
  if (typeof v === 'string') return v.trim() || null;
  // The parser turns some well-known tags into objects (Date, Result…); the
  // ones we read are free text, but be defensive about `value` wrappers.
  if (v && typeof v === 'object' && 'value' in v) {
    const inner = (v as { value: unknown }).value;
    if (typeof inner === 'string') return inner.trim() || null;
  }
  return null;
}

/**
 * Lichess writes `Event "Study name: Chapter name"`. A bare Event (any other
 * PGN source) names both — the file is then a one-chapter study.
 */
function splitEvent(event: string | null): { study: string | null; chapter: string | null } {
  if (!event) return { study: null, chapter: null };
  const sep = event.indexOf(': ');
  if (sep < 0) return { study: event, chapter: event };
  return {
    study: event.slice(0, sep).trim() || null,
    chapter: event.slice(sep + 2).trim() || null,
  };
}

/** Lichess chapter URLs are `…/study/<studyId>/<chapterId>`; the study is the parent. */
function studyUrlOf(chapterUrl: string | null): string | null {
  if (!chapterUrl) return null;
  const m = /^(https?:\/\/[^/]+\/study\/[^/]+)\/[^/]+\/?$/.exec(chapterUrl);
  return m ? m[1]! : chapterUrl;
}

const ALLOWED_VARIANTS = new Set(['standard', 'from position']);

function parseGames(pgn: string): ParsedGame[] {
  let games: ParsedGame[];
  try {
    games = pgnParser.parseGames(pgn) as ParsedGame[];
  } catch (e) {
    throw new InvalidPgnError(`PGN parse failed: ${(e as Error).message}`);
  }
  // A stray result token (`* *`) parses as an extra empty game; it is noise,
  // not a chapter, and would otherwise steal a "Chapter N" slot.
  return games.filter(
    (g) =>
      (g.moves?.length ?? 0) > 0 ||
      // The parser synthesizes `Result` on every game; only a real header counts.
      Object.keys(g.tags ?? {}).some((k) => k !== 'Result'),
  );
}

/**
 * Split a study export into chapters, each parsed into its own tree. Comments
 * are trimmed on this path — lichess pads them with spaces.
 */
export function parseStudyChapters(pgn: string): StudyChapter[] {
  if (!pgn.trim()) throw new InvalidPgnError('PGN is empty');
  const games = parseGames(pgn);
  if (games.length === 0) throw new InvalidPgnError('PGN contains no games');

  const usedTags = new Set<string>();
  return games.map((g, index) => {
    const tags = g.tags;
    const variant = tagString(tags, 'Variant');
    if (variant && !ALLOWED_VARIANTS.has(variant.toLowerCase())) {
      throw new InvalidPgnError(
        `Chapter ${index + 1} is a "${variant}" game; only standard chess is supported`,
      );
    }
    const event = splitEvent(tagString(tags, 'Event'));
    const name = tagString(tags, 'ChapterName') ?? event.chapter ?? `Chapter ${index + 1}`;

    // Tags compare case-insensitively (scope.ts), so "Main" and "main" would
    // merge two chapters into one scope — suffix the later one.
    let tag = name;
    let n = 2;
    while (usedTags.has(normalizeLineTag(tag))) tag = `${name} (${n++})`;
    usedTags.add(normalizeLineTag(tag));

    const startFen = tagString(tags, 'FEN') ?? STARTING_FEN;
    let tree: RepertoireTree;
    try {
      tree = parsedMovesToTree(g.moves ?? [], startFen, { trimComments: true });
    } catch (e) {
      if (e instanceof InvalidPgnError) {
        throw new InvalidPgnError(`Chapter "${name}": ${e.message}`);
      }
      throw e;
    }
    return {
      index,
      name,
      tag,
      startFen,
      url: tagString(tags, 'ChapterURL') ?? tagString(tags, 'Site'),
      tree,
    };
  });
}

/** Study-level name/url, from the tags of the first chapter. */
export function studyHeader(pgn: string): { studyName: string | null; studyUrl: string | null } {
  let games: ParsedGame[];
  try {
    games = parseGames(pgn);
  } catch {
    return { studyName: null, studyUrl: null };
  }
  const tags = games[0]?.tags;
  const event = splitEvent(tagString(tags, 'Event'));
  return {
    studyName: tagString(tags, 'StudyName') ?? event.study,
    studyUrl: studyUrlOf(tagString(tags, 'ChapterURL') ?? tagString(tags, 'Site')),
  };
}

/* ---------------- merge ---------------- */

/** Per-edge provenance the prep policy needs; keyed by `parentFenKey::san`. */
export interface StudyEdgeMeta {
  /** Chapter index that introduced the edge. */
  firstChapter: number;
  /** Earliest chapter where the edge is on the main line, or null if never. */
  mainLineChapter: number | null;
}

export interface MergedStudyTree {
  tree: RepertoireTree;
  edgeMeta: Map<string, StudyEdgeMeta>;
  chapterNames: string[];
}

export function edgeKeyOf(m: Pick<TreeMoveInput, 'parentFenKey' | 'san'>): string {
  return `${m.parentFenKey}::${m.san}`;
}

/**
 * Union the chapter trees. Positions dedupe by fenKey, edges by
 * `parentFenKey::san`; each edge's `lineTags` is the set of chapters that
 * contain it, `comment`/`annotation` come from the first chapter that has one,
 * and `isMainLine` is true if any chapter has it on the main line.
 *
 * Throws when a chapter's start position cannot be reached from the root —
 * see the module header for why that is not a warning.
 */
export function mergeChapterTrees(chapters: StudyChapter[]): MergedStudyTree {
  const first = chapters[0];
  if (!first) throw new InvalidPgnError('PGN contains no games');

  const fullFenByKey = new Map<FenKey, string>();
  const moveByEdge = new Map<string, TreeMoveInput>();
  const edgeMeta = new Map<string, StudyEdgeMeta>();

  for (const ch of chapters) {
    for (const p of ch.tree.positions) {
      if (!fullFenByKey.has(p.fenKey)) fullFenByKey.set(p.fenKey, p.fullFen);
    }
    for (const m of ch.tree.moves) {
      const key = edgeKeyOf(m);
      const existing = moveByEdge.get(key);
      if (!existing) {
        moveByEdge.set(key, { ...m, lineTags: [ch.tag], isDropped: false });
        edgeMeta.set(key, {
          firstChapter: ch.index,
          mainLineChapter: m.isMainLine ? ch.index : null,
        });
        continue;
      }
      existing.lineTags!.push(ch.tag);
      existing.comment ??= m.comment;
      existing.annotation ??= m.annotation;
      if (m.isMainLine) {
        existing.isMainLine = true;
        const meta = edgeMeta.get(key)!;
        if (meta.mainLineChapter === null) meta.mainLineChapter = ch.index;
      }
    }
  }

  const tree: RepertoireTree = {
    rootFenKey: first.tree.rootFenKey,
    rootFullFen: first.tree.rootFullFen,
    positions: Array.from(fullFenByKey, ([k, fullFen]) => ({ fenKey: k, fullFen })),
    moves: Array.from(moveByEdge.values()),
  };

  const reachable = reachablePositions(tree, () => true);
  for (const ch of chapters) {
    if (!reachable.has(ch.tree.rootFenKey)) {
      throw new InvalidPgnError(
        `Chapter "${ch.name}" starts from a position the study's first chapter never reaches; ` +
          'import it as its own study',
      );
    }
  }

  return { tree, edgeMeta, chapterNames: chapters.map((c) => c.name) };
}

/* ---------------- prep policy ---------------- */

/**
 * Enforce "one prep per hero position" structurally. At each parent where
 * the hero is to move, rank the hero's edges by (earliest main-line chapter,
 * earliest chapter, encounter order); the first keeps the slot and is forced
 * onto the main line, every other one becomes a demoted alternate.
 */
export function applyStudyPrepPolicy(
  merged: MergedStudyTree,
  color: Color,
): { tree: RepertoireTree; demoted: StudyDemotion[] } {
  const { tree, edgeMeta, chapterNames } = merged;
  const fullFenByKey = new Map(tree.positions.map((p) => [p.fenKey, p.fullFen]));
  const chapterName = (i: number) => chapterNames[i] ?? `Chapter ${i + 1}`;

  const moves = tree.moves.map((m) => ({ ...m, lineTags: [...(m.lineTags ?? [])] }));
  const byKey = new Map(moves.map((m) => [edgeKeyOf(m), m]));

  const heroEdgesByParent = new Map<FenKey, TreeMoveInput[]>();
  for (const m of moves) {
    const parentFen = fullFenByKey.get(m.parentFenKey);
    if (!parentFen || !isUserMove(fenTurn(parentFen), color)) continue;
    const list = heroEdgesByParent.get(m.parentFenKey) ?? [];
    list.push(m);
    heroEdgesByParent.set(m.parentFenKey, list);
  }

  const rank = (m: TreeMoveInput): [number, number] => {
    const meta = edgeMeta.get(edgeKeyOf(m))!;
    return [meta.mainLineChapter ?? Number.POSITIVE_INFINITY, meta.firstChapter];
  };

  const demoted: StudyDemotion[] = [];
  for (const edges of heroEdgesByParent.values()) {
    if (edges.length === 1) {
      // Sole option: it is the prep even if the study had it inside a
      // variation bracket, so make it render as the line.
      edges[0]!.isMainLine = true;
      continue;
    }
    const ordered = edges
      .map((m, i) => ({ m, i, r: rank(m) }))
      .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
      .map((x) => x.m);
    const winner = ordered[0]!;
    const winnerMeta = edgeMeta.get(edgeKeyOf(winner))!;
    byKey.get(edgeKeyOf(winner))!.isMainLine = true;
    for (const loser of ordered.slice(1)) {
      const out = byKey.get(edgeKeyOf(loser))!;
      out.isDropped = true;
      out.isMainLine = false;
      const loserMeta = edgeMeta.get(edgeKeyOf(loser))!;
      demoted.push({
        parentFenKey: loser.parentFenKey,
        san: loser.san,
        chapter: chapterName(loserMeta.firstChapter),
        keptSan: winner.san,
        keptChapter: chapterName(winnerMeta.firstChapter),
        reason: loserMeta.mainLineChapter !== null ? 'cross-chapter' : 'variation',
      });
    }
  }

  return { tree: { ...tree, moves }, demoted };
}

/* ---------------- reachability ---------------- */

function reachablePositions(
  tree: RepertoireTree,
  follow: (m: TreeMoveInput) => boolean,
): Set<FenKey> {
  const childrenByParent = new Map<FenKey, TreeMoveInput[]>();
  for (const m of tree.moves) {
    const list = childrenByParent.get(m.parentFenKey) ?? [];
    list.push(m);
    childrenByParent.set(m.parentFenKey, list);
  }
  const seen = new Set<FenKey>([tree.rootFenKey]);
  const stack: FenKey[] = [tree.rootFenKey];
  while (stack.length) {
    const key = stack.pop()!;
    for (const m of childrenByParent.get(key) ?? []) {
      if (!follow(m) || seen.has(m.childFenKey)) continue;
      seen.add(m.childFenKey);
      stack.push(m.childFenKey);
    }
  }
  return seen;
}

/**
 * Positions reachable from the root through live (non-demoted) edges. A hero
 * move below a demoted alternate is never played in rehearsal, so it must
 * not get a card — unless a live path transposes into the same position.
 */
export function liveReachablePositions(tree: RepertoireTree): Set<FenKey> {
  return reachablePositions(tree, (m) => !m.isDropped);
}

/* ---------------- entry point ---------------- */

export function studyPgnToTree(pgn: string, color: Color): StudyParseResult {
  const chapters = parseStudyChapters(pgn);
  const merged = mergeChapterTrees(chapters);
  const { tree, demoted } = applyStudyPrepPolicy(merged, color);
  const header = studyHeader(pgn);
  return {
    ...header,
    chapters: chapters.map(({ tag, name, url }) => ({ tag, name, url })),
    tree,
    demoted,
  };
}
