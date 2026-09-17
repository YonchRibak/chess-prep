/**
 * `useChessRules` pinned to a specific FEN so navigation jumps work: the
 * board shows whatever position the owner points at, with the incoming
 * repertoire edge as the highlighted last move.
 *
 * Browsing views (editor, study browser) use this; sessions do not — a jump
 * discards the move history, which is why the walker replays the path
 * instead.
 */
import { useEffect } from 'react';
import type { Square } from 'chess.js';
import type { RepertoireMove } from '../../api/client.ts';
import { useChessRules } from './useChessRules.ts';

export function useChessRulesPinnedTo(fullFen: string, lastMove: RepertoireMove | null) {
  const rules = useChessRules(fullFen);
  useEffect(() => {
    rules.load(fullFen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullFen]);

  const lastMoveOverride = lastMove
    ? {
        from: lastMove.uci.slice(0, 2) as Square,
        to: lastMove.uci.slice(2, 4) as Square,
      }
    : null;

  return {
    ...rules,
    lastMove: lastMoveOverride ?? rules.lastMove,
  };
}
