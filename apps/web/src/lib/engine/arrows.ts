/**
 * Engine lines → board arrows.
 *
 * Layer rule: `engine.ts` knows only UCI, `useBoard` knows only Chessground.
 * This module is the (pure) adapter between them — no React, no engine access.
 */
import type { Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';
import type { AnalysisProgress, EngineLine } from './engine.ts';

/**
 * Arrow brushes by rank. Chessground ships `green`/`blue`/`yellow`/`red` plus
 * `paleX` variants; the best move gets the strongest one and alternatives fade.
 */
const BRUSHES = ['green', 'blue', 'yellow'] as const;
const PALE_BRUSH = 'paleGrey';

/**
 * Chessground's default brush colors, mirrored here so the UI can render a
 * legend whose swatches actually match the arrows on the board. Keep in sync
 * with chessground's `brushes` defaults if the board theme ever overrides them.
 */
export const BRUSH_HEX: Record<string, string> = {
  green: '#15781b',
  blue: '#003088',
  yellow: '#e68f00',
  paleGrey: '#4a4a4a',
};

/** Board-arrow color for the line ranked `rank` (0 = engine's best move). */
export function brushForRank(rank: number): string {
  return BRUSHES[rank] ?? PALE_BRUSH;
}

/** Hex color for the line ranked `rank`, for legends and line rows. */
export function colorForRank(rank: number): string {
  return BRUSH_HEX[brushForRank(rank)]!;
}

export interface EngineArrowOptions {
  /** Max arrows to draw. Defaults to all lines in the progress. */
  max?: number;
}

/**
 * Build one arrow per MultiPV line, using each line's FIRST move. Lines are
 * ranked by `multipv` (1 = best). Returns [] when there is nothing to draw, so
 * a gated / idle engine simply clears the board.
 */
export function engineArrows(
  progress: AnalysisProgress | null,
  opts: EngineArrowOptions = {},
): DrawShape[] {
  if (!progress) return [];
  const max = opts.max ?? Infinity;
  const lines = [...progress.lines]
    .filter((l) => l.pv.length > 0 && l.multipv <= max)
    .sort((a, b) => a.multipv - b.multipv);

  const shapes: DrawShape[] = [];
  for (const line of lines) {
    // Rank comes from `multipv`, NOT the array index, so a line dropped for an
    // empty PV can't shift the colors out of sync with the legend.
    const shape = arrowForLine(line, line.multipv - 1);
    if (shape) shapes.push(shape);
  }
  return shapes;
}

function arrowForLine(line: EngineLine, rank: number): DrawShape | null {
  const uci = line.pv[0];
  if (!uci || uci.length < 4) return null;
  const orig = uci.slice(0, 2) as Key;
  const dest = uci.slice(2, 4) as Key;
  if (orig === dest) return null;
  return { orig, dest, brush: brushForRank(rank) };
}
