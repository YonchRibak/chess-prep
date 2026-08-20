import { useMemo } from 'react';
import type { Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';
import type { Square } from 'chess.js';
import { useBoard, type BoardColor } from '../lib/chess/useBoard.ts';
import type { ChessRules } from '../lib/chess/useChessRules.ts';

interface BoardProps {
  rules: ChessRules;
  orientation: BoardColor;
  /** Which color the local user controls; null = read-only. */
  movableColor?: BoardColor | null;
  /** Optional shape annotations (used later for opponent heatmap). */
  shapes?: DrawShape[];
  /** Notified after a legal move is accepted by the rules engine. */
  onMovePlayed?: (san: string) => void;
}

const COLOR_LONG: Record<'w' | 'b', BoardColor> = { w: 'white', b: 'black' };

export function Board({
  rules,
  orientation,
  movableColor,
  shapes,
  onMovePlayed,
}: BoardProps) {
  const turnColor = COLOR_LONG[rules.turn];
  const effectiveMovable = movableColor === undefined ? turnColor : movableColor;

  const dests = useMemo(() => {
    const m = new Map<Key, Key[]>();
    for (const [from, tos] of rules.legalDestsMap.entries()) {
      m.set(from as Key, tos as Key[]);
    }
    return m;
  }, [rules.legalDestsMap]);

  const lastMove: [Key, Key] | null = rules.lastMove
    ? [rules.lastMove.from as Key, rules.lastMove.to as Key]
    : null;

  const check: BoardColor | null = rules.isCheck ? turnColor : null;

  const board = useBoard({
    fen: rules.fen,
    orientation,
    turnColor,
    movableColor: rules.isGameOver ? null : effectiveMovable,
    movableDests: dests,
    lastMove,
    check,
    shapes,
    onMove: (from, to) => {
      const san = rules.tryMove(from as Square, to as Square);
      if (san) onMovePlayed?.(san);
    },
  });

  return (
    <div
      ref={board.ref}
      className="cg-wrap aspect-square w-full max-w-[640px]"
      // Chessground requires the container to have a size or it renders 0x0.
      // aspect-square + a max width does the job; the inner board fills it.
    />
  );
}
