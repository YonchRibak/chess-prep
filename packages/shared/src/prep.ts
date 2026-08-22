/**
 * Flow F2: guided-prepare session parameters ("prep target").
 *
 * A prep target answers "when is this preparation *done*?" in the explorer's
 * own terms: cover every opponent reply played in at least `minShare` of
 * games, down to `maxDepthPlies`. The presets parameterize
 * `selectOpponentReplies` (see explorer.ts) — they are policy knobs, not a new
 * selection mechanism.
 *
 * Persistence wart, accepted deliberately: the last-used target is stored per
 * repertoire inside the `drill_rules` jsonb although it is a *growth* setting,
 * not a drill rule — that keeps it migration-free and readable through
 * `mergeDrillRules`. Revisit only if a second growth setting appears.
 */
import { DEFAULT_OPPONENT_REPLY_POLICY } from './explorer.js';
import type { Color } from './types.js';

export interface PrepTarget {
  /** Prepare against every opponent reply with at least this share of games. */
  minShare: number;
  /** Stop offering build prompts at positions this many plies from the root. */
  maxDepthPlies: number;
}

export const DEFAULT_PREP_DEPTH_PLIES = 12;

/**
 * "1 in 20 games" (the existing reply policy's default), "1 in 50", "1 in 5".
 */
export const PREP_TARGET_PRESETS = {
  default: { minShare: DEFAULT_OPPONENT_REPLY_POLICY.minShare, maxDepthPlies: DEFAULT_PREP_DEPTH_PLIES },
  broader: { minShare: 0.02, maxDepthPlies: DEFAULT_PREP_DEPTH_PLIES },
  mainLines: { minShare: 0.2, maxDepthPlies: DEFAULT_PREP_DEPTH_PLIES },
} as const satisfies Record<string, PrepTarget>;

export const DEFAULT_PREP_TARGET: PrepTarget = PREP_TARGET_PRESETS.default;

/**
 * Validate an untrusted prep target (API body / stored jsonb). Returns
 * `undefined` for absent input; throws with a message the API turns into a 400.
 */
export function parsePrepTarget(raw: unknown): PrepTarget | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('prepTarget must be an object');
  const { minShare, maxDepthPlies } = raw as { minShare?: unknown; maxDepthPlies?: unknown };
  if (typeof minShare !== 'number' || !(minShare > 0) || minShare > 1) {
    throw new Error('prepTarget.minShare must be a number in (0, 1]');
  }
  if (
    typeof maxDepthPlies !== 'number' ||
    !Number.isInteger(maxDepthPlies) ||
    maxDepthPlies < 1 ||
    maxDepthPlies > 60
  ) {
    throw new Error('prepTarget.maxDepthPlies must be an integer in [1, 60]');
  }
  return { minShare, maxDepthPlies };
}

/**
 * Which color prepares *against* an opening: the side that played the LAST
 * move of the opening's defining line owns it, and the user gets the other
 * color. "Caro-Kann Defense" ends on 1...c6 (Black's move) → the user
 * prepares as White.
 *
 * `pgnMoves` is the book's bare movetext ("1. e4 c6"). Counted by SAN token,
 * not replayed — the book's own lines are well-formed, and a malformed line
 * degrading to "white" is a wrong *suggestion* the wizard lets the user flip,
 * not a wrong write.
 */
export function inferPrepColor(pgnMoves: string): Color {
  const plies = pgnMoves
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^\d+\.+$/.test(t) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t))
    .length;
  // Even ply count → Black moved last → the opening is Black's → user is White.
  return plies % 2 === 0 ? 'white' : 'black';
}
