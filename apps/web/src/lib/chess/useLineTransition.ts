/**
 * Move the board from the line it shows to another line (Study S5).
 *
 * Default (`'last-ply'`): the board is set to the position *before* the
 * target's final ply without animation, and only that final ply — the
 * opponent's move the card asks about — glides in and stays as the last-move
 * highlight. Quiet and quick, like stepping to a position on lichess. When
 * the change is a single ply anyway (the next card continues the line the
 * user just played), it simply animates.
 *
 * `'full'` executes a `planLineTransition` plan one ply per awaited step —
 * take back to the common ancestor, play forward — for users who want to see
 * how a position is reached. `replay` does the same on demand for one line.
 *
 * Abortable: an interrupted transition stops where it is; the next call
 * re-plans from the board's real history, so it is self-healing.
 */
import { useCallback, useRef, useState } from 'react';
import type { ChessRules } from './useChessRules.ts';
import { planLineTransition, type TransitionKind } from './lineTransition.ts';
import { nextFrame, sleep } from '../rehearse/async.ts';
import { LAST_PLY_MS, PLY_MS, UNDO_PLY_MS } from '../rehearse/timings.ts';

export type TransitionMode = 'last-ply' | 'full';

export interface LineTransition {
  /** Glide duration to pass to `<Board animationMs>`. */
  animationMs: number;
  /**
   * Move the board to `targetSans` (from the root). `targetFullFen` is the
   * fallback if a SAN fails to replay (a data mismatch, never expected).
   */
  animateTo(
    targetSans: readonly string[],
    targetFullFen: string,
    signal: AbortSignal,
    mode?: TransitionMode,
  ): Promise<TransitionKind>;
  /** Replay `sans` from the root ply by ply, ending on the same position. */
  replay(sans: readonly string[], fullFen: string, signal: AbortSignal): Promise<void>;
}

export function useLineTransition(rules: ChessRules, rootFullFen: string): LineTransition {
  // The closure over `rules` would be stale mid-sequence — each ply re-renders
  // and produces a new snapshot. Read the live one through a ref.
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const [animationMs, setAnimationMs] = useState(LAST_PLY_MS);

  const playOrFallback = useCallback((san: string, fullFen: string): boolean => {
    if (rulesRef.current.playSan(san)) return true;
    rulesRef.current.load(fullFen);
    return false;
  }, []);

  /** Set the board to `sans` from the root with no animation. */
  const snapTo = useCallback(
    async (sans: readonly string[], fullFen: string, signal: AbortSignal) => {
      setAnimationMs(0);
      await nextFrame(signal);
      rulesRef.current.load(rootFullFen);
      for (const san of sans) if (!playOrFallback(san, fullFen)) break;
      await nextFrame(signal);
    },
    [rootFullFen, playOrFallback],
  );

  const playPlies = useCallback(
    async (sans: readonly string[], fullFen: string, signal: AbortSignal) => {
      for (let i = 0; i < sans.length; i++) {
        const isLast = i === sans.length - 1;
        setAnimationMs(isLast ? LAST_PLY_MS : PLY_MS);
        await nextFrame(signal);
        if (!playOrFallback(sans[i]!, fullFen)) break;
        await sleep(isLast ? LAST_PLY_MS : PLY_MS, signal);
      }
    },
    [playOrFallback],
  );

  const animateTo = useCallback(
    async (
      targetSans: readonly string[],
      targetFullFen: string,
      signal: AbortSignal,
      mode: TransitionMode = 'last-ply',
    ) => {
      const current = rulesRef.current.history.map((m) => m.san);
      const plan = planLineTransition(current, targetSans);
      if (plan.kind === 'none') return plan.kind;

      const singlePly = plan.undo === 0 && plan.play.length === 1;
      if (mode === 'last-ply' && !singlePly) {
        // Everything but the final ply appears at once; the final ply glides.
        await snapTo(targetSans.slice(0, -1), targetFullFen, signal);
        const last = targetSans.at(-1);
        if (last) await playPlies([last], targetFullFen, signal);
        return plan.kind;
      }

      if (plan.kind === 'new-line') {
        await snapTo(targetSans.slice(0, -1), targetFullFen, signal);
        const last = targetSans.at(-1);
        if (last) await playPlies([last], targetFullFen, signal);
        return plan.kind;
      }

      setAnimationMs(UNDO_PLY_MS);
      await nextFrame(signal);
      for (let i = 0; i < plan.undo; i++) {
        rulesRef.current.undo();
        await sleep(UNDO_PLY_MS, signal);
      }
      await playPlies(plan.play, targetFullFen, signal);
      return plan.kind;
    },
    [snapTo, playPlies],
  );

  const replay = useCallback(
    async (sans: readonly string[], fullFen: string, signal: AbortSignal) => {
      await snapTo([], fullFen, signal);
      await sleep(PLY_MS, signal);
      await playPlies(sans, fullFen, signal);
    },
    [snapTo, playPlies],
  );

  return { animationMs, animateTo, replay };
}
