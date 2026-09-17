/**
 * Plan how the board should get from the line it shows to the line of the
 * next card (Study S5).
 *
 * Pure so it is testable: the hook (`useLineTransition`) executes the plan
 * against `useChessRules` with the timings from `lib/rehearse/timings.ts`.
 *
 * The point is that transitions look like chess, not like a reload: a sibling
 * variation is reached by taking back a move and playing another; a deeper
 * card in the same line just plays on. Only when the two lines share nothing
 * useful — or the rewind would be so long it reads as noise — does the board
 * fade and re-appear on the new line, with just its final ply animated.
 */
export type TransitionKind = 'none' | 'extend' | 'rewind' | 'new-line';

export interface TransitionPlan {
  kind: TransitionKind;
  /** Plies to take back from the current line before playing forward. */
  undo: number;
  /** SANs to play after undoing. */
  play: string[];
}

export interface TransitionOptions {
  /**
   * Below this many shared plies a rewind is shown as a new line instead
   * (default 1: a line that shares only the root is "new").
   */
  newLineIfSharedLessThan?: number;
  /** Total undo + play plies above which the fade replaces the rewind (default 10). */
  maxRewind?: number;
}

export function planLineTransition(
  current: readonly string[],
  target: readonly string[],
  opts: TransitionOptions = {},
): TransitionPlan {
  const minShared = opts.newLineIfSharedLessThan ?? 1;
  const maxRewind = opts.maxRewind ?? 10;

  let k = 0;
  while (k < current.length && k < target.length && current[k] === target[k]) k++;
  const undo = current.length - k;
  const play = target.slice(k);

  if (undo === 0 && play.length === 0) return { kind: 'none', undo: 0, play: [] };
  if (undo === 0) return { kind: 'extend', undo: 0, play };
  if (undo + play.length > maxRewind) return { kind: 'new-line', undo, play };
  // A pure take-back (the target is an ancestor) always reads as chess, even
  // when it goes all the way to the root; the "shares nothing" fade is for
  // switching to a different line.
  if (play.length > 0 && k < minShared) return { kind: 'new-line', undo, play };
  return { kind: 'rewind', undo, play };
}
