/**
 * RashidResult → board arrows (plan Phase R4, spec §9).
 *
 * Same layer rule as arrows.ts: pure adapter, no React, no engine access.
 *
 * The spec's visual encoding, adapted to what chessground 9.2 supports:
 * - **Hue = Risk.** Four quantized bands as registered brushes (chessground
 *   brushes are a named set — a smooth gradient would need a brush per value).
 * - **Thickness = Reward floor** via the per-shape `modifiers.lineWidth`.
 * - **Label digit = Length** via the shape's `label` slot.
 * - The spec's dashed-stroke accessibility cue is NOT available (DrawBrush
 *   has no dash property), so hue is deliberately never the only channel:
 *   the RashidPanel always shows the exact Risk/Reward/Length numbers.
 * - Secondary arrows use pale variants of the same brushes, capped at 2.
 */
import type { Key } from 'chessground/types';
import type { DrawShape, DrawBrush } from 'chessground/draw';
import { isMateScore, type RashidLine, type RashidResult } from '@chess-prep/shared';

/** Spec §9 risk bands, hero-perspective cp at the end of the tightrope. */
export type RiskBand = 'free' | 'safe' | 'gambit' | 'speculative';

export function riskBand(riskScore: number): RiskBand {
  if (riskScore >= 30) return 'free'; // winning even if declined correctly
  if (riskScore >= -20) return 'safe'; // nothing real lost
  if (riskScore >= -50) return 'gambit'; // a real concession
  return 'speculative'; // only shown because it passed the sacrifice cap
}

const BAND_BRUSH: Record<RiskBand, string> = {
  free: 'rashidFree',
  safe: 'rashidSafe',
  gambit: 'rashidGambit',
  speculative: 'rashidSpec',
};

/** Hex per band, exported so panel legends can match the board. */
export const RASHID_BAND_HEX: Record<RiskBand, string> = {
  free: '#15803d', // green
  safe: '#0d9488', // teal
  gambit: '#d97706', // amber
  speculative: '#dc2626', // red
};

/**
 * Brushes to register on the board (primary + pale secondary variants).
 * `lineWidth` here is only the fallback — every Rashid shape carries an
 * explicit per-shape width from the reward floor.
 */
export const RASHID_BRUSHES: Record<string, DrawBrush> = Object.fromEntries(
  (Object.keys(BAND_BRUSH) as RiskBand[]).flatMap((band) => {
    const key = BAND_BRUSH[band];
    const color = RASHID_BAND_HEX[band];
    return [
      [key, { key, color, opacity: 0.85, lineWidth: 10 }],
      [`${key}Pale`, { key: `${key}Pale`, color, opacity: 0.35, lineWidth: 10 }],
    ];
  }),
);

/** Spec §9 thickness scale: +0.5 pawn floor → thin, +3.0 → thick, mate → max. */
export function rewardLineWidth(rewardFloor: number | null): number {
  if (rewardFloor == null) return 8;
  if (isMateScore(rewardFloor)) return 18;
  const t = Math.min(1, Math.max(0, (rewardFloor - 50) / 250));
  return Math.round(8 + 8 * t);
}

export interface RashidArrowOptions {
  /** Secondary (non-best) arrows to draw at reduced opacity. Default 2. */
  maxSecondary?: number;
}

/**
 * One arrow per qualifying line: the best at full opacity with the Length
 * badge, up to `maxSecondary` runners-up pale and unlabeled. Returns [] when
 * nothing lights up, so a toggled-off / trap-less position clears the board.
 */
export function rashidShapes(
  result: RashidResult | null,
  opts: RashidArrowOptions = {},
): DrawShape[] {
  if (!result?.lightsUp || !result.best) return [];
  const maxSecondary = opts.maxSecondary ?? 2;

  const shapes: DrawShape[] = [shapeFor(result.best, false)];
  for (const line of result.lines) {
    if (line === result.best) continue;
    if (shapes.length > maxSecondary) break;
    shapes.push(shapeFor(line, true));
  }
  return shapes;
}

function shapeFor(line: RashidLine, pale: boolean): DrawShape {
  const orig = line.rootUci.slice(0, 2) as Key;
  const dest = line.rootUci.slice(2, 4) as Key;
  const brush = BAND_BRUSH[riskBand(line.riskScore)] + (pale ? 'Pale' : '');
  const shape: DrawShape = {
    orig,
    dest,
    brush,
    modifiers: { lineWidth: rewardLineWidth(line.rewardFloor) },
  };
  // Length badge on the primary arrow only — a digit on every pale runner-up
  // reads as clutter, and the panel lists them all anyway.
  if (!pale) shape.label = { text: String(line.length) };
  return shape;
}
