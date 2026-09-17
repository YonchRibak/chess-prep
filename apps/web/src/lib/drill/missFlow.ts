/**
 * The wrong-answer sequence shared by drill surfaces (extracted in Study S5;
 * the rehearsal session uses it, the three older implementations still carry
 * their own copy — see srs-drilling.md "Four drill implementations").
 *
 * A miss is: grade Again → SHOW the correct move on the board → take it back →
 * pause on the user's note if the move has one → require the user to play
 * the move themselves. The reveal-then-retry shape is what builds motor
 * memory; the note pause is where the study's own explanation is read.
 */
import type { ChessRules } from '../chess/useChessRules.ts';
import { sleep } from '../rehearse/async.ts';

export type MissStage = 'reveal' | 'note' | 'retry';

/** Which stage follows the reveal: the note if there is one, else the retry. */
export function nextMissStage(move: { comment: string | null }): 'note' | 'retry' {
  return move.comment?.trim() ? 'note' : 'retry';
}

/** Play the correct move, hold it, take it back. Abortable. */
export async function runMissReveal(args: {
  rules: Pick<ChessRules, 'playSan' | 'undo'>;
  correctSan: string;
  revealMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const played = args.rules.playSan(args.correctSan);
  await sleep(args.revealMs, args.signal);
  if (played) args.rules.undo();
}
