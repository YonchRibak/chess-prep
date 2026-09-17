/**
 * Animate the board from the line it shows to another line (Study S5).
 *
 * Executes a `planLineTransition` plan against a `ChessRules` instance one
 * ply per awaited step, so every ply is its own React commit and chessground
 * glides it. The final ply gets a slower glide and stays as the last-move
 * highlight — it is the opponent's move the next card asks about.
 *
 * Abortable: an interrupted transition simply stops where it is; the next
 * call re-plans from the board's real history, so it is self-healing.
 */
import { useCallback, useRef, useState } from 'react';
import type { ChessRules } from './useChessRules.ts';
import { planLineTransition, type TransitionKind } from './lineTransition.ts';
import { nextFrame, sleep } from '../rehearse/async.ts';
import { LAST_PLY_MS, NEW_LINE_FADE_MS, PLY_MS, UNDO_PLY_MS } from '../rehearse/timings.ts';

export type TransitionCue = 'new-line' | null;

export interface LineTransition {
  /** Glide duration to pass to `<Board animationMs>`. */
  animationMs: number;
  /** Visual cue the page should render (a fade while a new line loads). */
  cue: TransitionCue;
  /**
   * Move the board to `targetSans` (from the root). `targetFullFen` is the
   * fallback if a SAN fails to replay (a data mismatch, never expected).
   */
  animateTo(
    targetSans: readonly string[],
    targetFullFen: string,
    signal: AbortSignal,
  ): Promise<TransitionKind>;
}

export function useLineTransition(rules: ChessRules, rootFullFen: string): LineTransition {
  // The closure over `rules` would be stale mid-sequence — each ply re-renders
  // and produces a new snapshot. Read the live one through a ref.
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const [animationMs, setAnimationMs] = useState(PLY_MS);
  const [cue, setCue] = useState<TransitionCue>(null);

  const animateTo = useCallback(
    async (targetSans: readonly string[], targetFullFen: string, signal: AbortSignal) => {
      const current = rulesRef.current.history.map((m) => m.san);
      const plan = planLineTransition(current, targetSans);
      const playOrFallback = (san: string): boolean => {
        if (rulesRef.current.playSan(san)) return true;
        rulesRef.current.load(targetFullFen);
        return false;
      };

      if (plan.kind === 'none') return plan.kind;

      if (plan.kind === 'new-line') {
        setCue('new-line');
        await sleep(NEW_LINE_FADE_MS, signal);
        setAnimationMs(0);
        await nextFrame(signal);
        rulesRef.current.load(rootFullFen);
        for (const san of targetSans.slice(0, -1)) {
          if (!playOrFallback(san)) break;
        }
        await nextFrame(signal);
        setCue(null);
        const last = targetSans.at(-1);
        if (last) {
          setAnimationMs(LAST_PLY_MS);
          await nextFrame(signal);
          playOrFallback(last);
          await sleep(LAST_PLY_MS, signal);
        }
        return plan.kind;
      }

      setAnimationMs(UNDO_PLY_MS);
      await nextFrame(signal);
      for (let i = 0; i < plan.undo; i++) {
        rulesRef.current.undo();
        await sleep(UNDO_PLY_MS, signal);
      }
      for (let i = 0; i < plan.play.length; i++) {
        const isLast = i === plan.play.length - 1;
        setAnimationMs(isLast ? LAST_PLY_MS : PLY_MS);
        await nextFrame(signal);
        if (!playOrFallback(plan.play[i]!)) break;
        await sleep(isLast ? LAST_PLY_MS : PLY_MS, signal);
      }
      return plan.kind;
    },
    [rootFullFen],
  );

  return { animationMs, cue, animateTo };
}
