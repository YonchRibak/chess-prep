/**
 * PGN ↔ position-keyed move tree.
 *
 * Parse: PGN string → flat lists of positions and moves keyed by normalized FEN.
 *        Transpositions collapse (same fen_key → one position node, but each
 *        move is preserved). Variations and NAGs and comments are kept.
 *
 * Write: tree → PGN string with parenthesized variations, NAGs, and comments.
 *        Main-line moves emit first, then sibling variations in parentheses.
 *
 * `parsedMovesToTree` is the shared walk; `pgnToTree` (single game, legacy
 * import) and the study importer in study.ts both build on it so the two
 * paths cannot disagree about legality, SAN canonicalization, or edge dedupe.
 */
import { Chess } from 'chess.js';
import * as pgnParser from '@mliebelt/pgn-parser';
import { fenKey, STARTING_FEN, type FenKey } from './fen.js';

export interface TreePositionInput {
  fenKey: FenKey;
  fullFen: string;
}

export interface TreeMoveInput {
  parentFenKey: FenKey;
  childFenKey: FenKey;
  san: string;
  uci: string;
  comment: string | null;
  annotation: string | null;
  isMainLine: boolean;
  priority: number;
  /** Study import: chapter tags. Absent on the legacy single-game path. */
  lineTags?: string[];
  /** Study import: a user-side alternate demoted by the prep policy. */
  isDropped?: boolean;
}

export interface RepertoireTree {
  rootFenKey: FenKey;
  rootFullFen: string;
  positions: TreePositionInput[];
  moves: TreeMoveInput[];
}

export class InvalidPgnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPgnError';
  }
}

/* ---------------- parse ---------------- */

export type ParsedMove = {
  notation?: { notation?: string } | string;
  variations?: ParsedMove[][];
  commentAfter?: string;
  commentMove?: string;
  nag?: string[] | null;
};

export interface ParsedMovesOptions {
  /**
   * Trim comment whitespace. The parser keeps the spaces lichess pads
   * comments with (`{ text }` → " text "); the legacy import stores them
   * verbatim for round-trip fidelity, the study path trims for display.
   */
  trimComments?: boolean;
}

export function pgnToTree(
  pgn: string,
  options?: { startFen?: string },
): RepertoireTree {
  const startFen = options?.startFen ?? STARTING_FEN;

  let parsed: { moves: ParsedMove[] };
  try {
    parsed = pgnParser.parse(pgn, { startRule: 'game' }) as {
      moves: ParsedMove[];
    };
  } catch (e) {
    throw new InvalidPgnError(`PGN parse failed: ${(e as Error).message}`);
  }

  return parsedMovesToTree(parsed.moves ?? [], startFen);
}

/**
 * Walk an already-parsed move list into a tree. Moves are emitted in
 * encounter order: a main-line move, then each of its variations (depth
 * first), then the next main-line move. Edges dedupe on `parentKey::san`;
 * the first occurrence's comment/annotation wins and a later main-line
 * occurrence promotes `isMainLine`.
 */
export function parsedMovesToTree(
  pgnMoves: ParsedMove[],
  startFen: string,
  options: ParsedMovesOptions = {},
): RepertoireTree {
  const rootKey = fenKey(startFen);
  const positionsByKey = new Map<FenKey, string>();
  positionsByKey.set(rootKey, startFen);

  const moveByEdge = new Map<string, TreeMoveInput>(); // dedupe key: parentKey::san

  function walk(parentFen: string, moves: ParsedMove[], isMainLine: boolean) {
    let currentFen = parentFen;
    for (const pm of moves) {
      const san = extractSan(pm);
      if (!san) {
        throw new InvalidPgnError(`PGN move missing SAN: ${JSON.stringify(pm)}`);
      }

      const chess = new Chess(currentFen);
      let moveObj;
      try {
        moveObj = chess.move(san);
      } catch {
        throw new InvalidPgnError(`Illegal PGN move "${san}" at FEN: ${currentFen}`);
      }
      if (!moveObj) {
        throw new InvalidPgnError(`Illegal PGN move "${san}" at FEN: ${currentFen}`);
      }

      const parentKey = fenKey(currentFen);
      const childFen = chess.fen();
      const childKey = fenKey(childFen);
      positionsByKey.set(parentKey, currentFen);
      positionsByKey.set(childKey, childFen);

      const edgeKey = `${parentKey}::${moveObj.san}`;
      if (!moveByEdge.has(edgeKey)) {
        const rawComment = pm.commentAfter ?? pm.commentMove ?? null;
        const comment =
          rawComment !== null && options.trimComments ? rawComment.trim() || null : rawComment;
        moveByEdge.set(edgeKey, {
          parentFenKey: parentKey,
          childFenKey: childKey,
          san: moveObj.san,
          uci: toUci(moveObj),
          comment,
          annotation: pm.nag?.[0] ?? null,
          isMainLine,
          priority: 0,
        });
      } else if (isMainLine) {
        // If a transposition reaches this edge via the main line later, promote it.
        const existing = moveByEdge.get(edgeKey)!;
        existing.isMainLine = true;
      }

      if (pm.variations && pm.variations.length > 0) {
        for (const variation of pm.variations) {
          walk(currentFen, variation, false);
        }
      }

      currentFen = childFen;
    }
  }

  walk(startFen, pgnMoves, true);

  return {
    rootFenKey: rootKey,
    rootFullFen: startFen,
    positions: Array.from(positionsByKey, ([fenKeyStr, fullFen]) => ({
      fenKey: fenKeyStr,
      fullFen,
    })),
    moves: Array.from(moveByEdge.values()),
  };
}

function extractSan(pm: ParsedMove): string | null {
  if (typeof pm.notation === 'string') return pm.notation;
  if (pm.notation && typeof pm.notation === 'object' && 'notation' in pm.notation) {
    return pm.notation.notation ?? null;
  }
  return null;
}

function toUci(move: { from: string; to: string; promotion?: string }): string {
  return move.from + move.to + (move.promotion ?? '');
}
/* ---------------- write ---------------- */

export interface WritePgnOptions {
  /** PGN headers. Reasonable defaults are applied; pass to override. */
  headers?: Record<string, string>;
}

export function treeToPgn(tree: RepertoireTree, options: WritePgnOptions = {}): string {
  const fullFenByKey = new Map<FenKey, string>();
  for (const p of tree.positions) fullFenByKey.set(p.fenKey, p.fullFen);

  const movesByParent = new Map<FenKey, TreeMoveInput[]>();
  for (const m of tree.moves) {
    const arr = movesByParent.get(m.parentFenKey) ?? [];
    arr.push(m);
    movesByParent.set(m.parentFenKey, arr);
  }
  // Sort siblings: main_line first, then by priority asc, then SAN for determinism.
  for (const arr of movesByParent.values()) {
    arr.sort((a, b) => {
      if (a.isMainLine !== b.isMainLine) return a.isMainLine ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.san.localeCompare(b.san);
    });
  }

  const visited = new Set<FenKey>();

  // Emit a line starting at parentFenKey (which has fullFen). Returns the line string.
  function emitLine(startKey: FenKey): string {
    let currentKey = startKey;
    let currentFullFen = fullFenByKey.get(currentKey);
    if (!currentFullFen) {
      throw new Error(`Missing full FEN for position ${currentKey}`);
    }

    const pieces: string[] = [];
    // After a variation block or comment, the next move (if black) needs the "N..."
    // prefix because the move-pair flow is broken.
    let pairFlow = false;

    while (true) {
      const children = movesByParent.get(currentKey);
      if (!children || children.length === 0) break;

      const [mainMove, ...siblings] = children as [TreeMoveInput, ...TreeMoveInput[]];

      const { fullMoveNumber, turn } = parseFenMeta(currentFullFen);

      let token: string;
      if (turn === 'w') {
        token = `${fullMoveNumber}. ${mainMove.san}`;
      } else if (pairFlow) {
        token = mainMove.san;
      } else {
        token = `${fullMoveNumber}... ${mainMove.san}`;
      }
      if (mainMove.annotation) token += ` ${mainMove.annotation}`;
      if (mainMove.comment) token += ` { ${escapeComment(mainMove.comment)} }`;
      pieces.push(token);

      // Emit variations after the main move, in parens.
      const hasVariations = siblings.length > 0;
      for (const sib of siblings) {
        const sibFen = currentFullFen;
        const sibVariation = emitSingleVariation(sib, sibFen);
        pieces.push(`(${sibVariation})`);
      }

      // Advance along the main line — but only if we haven't already emitted
      // this child's subtree (transposition guard).
      const nextKey = mainMove.childFenKey;
      if (visited.has(nextKey)) break;
      visited.add(nextKey);

      const nextFullFen = fullFenByKey.get(nextKey);
      if (!nextFullFen) break;
      currentKey = nextKey;
      currentFullFen = nextFullFen;
      pairFlow = !hasVariations && !mainMove.comment;
    }

    return pieces.join(' ');
  }

  function emitSingleVariation(firstMove: TreeMoveInput, parentFullFen: string): string {
    // Emit just this one branch starting with `firstMove` from `parentFullFen`,
    // then continue down its main child line.
    const { fullMoveNumber, turn } = parseFenMeta(parentFullFen);
    const pieces: string[] = [];

    let token: string;
    if (turn === 'w') {
      token = `${fullMoveNumber}. ${firstMove.san}`;
    } else {
      token = `${fullMoveNumber}... ${firstMove.san}`;
    }
    if (firstMove.annotation) token += ` ${firstMove.annotation}`;
    if (firstMove.comment) token += ` { ${escapeComment(firstMove.comment)} }`;
    pieces.push(token);

    if (!visited.has(firstMove.childFenKey)) {
      visited.add(firstMove.childFenKey);
      const continuation = emitLine(firstMove.childFenKey);
      if (continuation) pieces.push(continuation);
    }
    return pieces.join(' ');
  }

  visited.add(tree.rootFenKey);
  const body = emitLine(tree.rootFenKey);

  const headers = {
    Event: 'Chess Prep repertoire',
    Site: '?',
    Date: '????.??.??',
    Round: '-',
    White: '?',
    Black: '?',
    Result: '*',
    ...(options.headers ?? {}),
  };
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `[${k} "${escapeHeader(v)}"]`)
    .join('\n');

  return `${headerLines}\n\n${body}${body ? ' ' : ''}*\n`;
}

function parseFenMeta(fen: string): { fullMoveNumber: number; turn: 'w' | 'b' } {
  const parts = fen.trim().split(/\s+/);
  const turn = (parts[1] ?? 'w') as 'w' | 'b';
  const fullMoveNumber = Number(parts[5] ?? 1);
  return { fullMoveNumber, turn };
}

function escapeComment(c: string): string {
  return c.replace(/[{}]/g, '').trim();
}

function escapeHeader(v: string): string {
  return v.replace(/"/g, '\\"');
}
