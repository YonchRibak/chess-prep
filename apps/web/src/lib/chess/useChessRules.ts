import { useCallback, useMemo, useRef, useState } from 'react';
import { Chess, type Move, type Square } from 'chess.js';

export type Color = 'w' | 'b';
export type Promotion = 'q' | 'r' | 'b' | 'n';

export interface ChessRulesState {
  fen: string;
  turn: Color;
  isCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  isDraw: boolean;
  isGameOver: boolean;
  history: Move[];
  /** Last move played (UCI-style squares), null if none. */
  lastMove: { from: Square; to: Square } | null;
  /** True if undo() will do something. */
  canUndo: boolean;
  /** True if redo() will do something. */
  canRedo: boolean;
}

export interface ChessRules extends ChessRulesState {
  /** Legal destination squares from a given origin. */
  legalDestsFrom: (from: Square) => Square[];
  /** All legal moves grouped by origin square — useful for chessground `dests`. */
  legalDestsMap: Map<Square, Square[]>;
  /** Attempt a move. Returns the SAN if accepted, null if illegal. */
  tryMove: (from: Square, to: Square, promotion?: Promotion) => string | null;
  /** Attempt a move by SAN (e.g. "Nf3", "e8=Q"). Returns the SAN if accepted, null if illegal. */
  playSan: (san: string) => string | null;
  undo: () => void;
  redo: () => void;
  /** Load any FEN; clears history. */
  load: (fen: string) => boolean;
  /** Reset to the standard starting position. */
  reset: () => void;
}

/**
 * Pure rules layer. Wraps chess.js — knows nothing about rendering.
 * History is owned here so we can support an undo/redo stack
 * (chess.js has undo but not redo).
 */
export function useChessRules(initialFen?: string): ChessRules {
  // chess.js mutates in place; we keep one ref instance for performance
  // and snapshot derived state into React state for re-renders.
  const gameRef = useRef<Chess>(new Chess(initialFen));
  const redoStackRef = useRef<Move[]>([]);

  const [state, setState] = useState<ChessRulesState>(() => snapshot(gameRef.current, false));

  const refresh = useCallback(() => {
    setState(snapshot(gameRef.current, redoStackRef.current.length > 0));
  }, []);

  const legalDestsMap = useMemo(() => {
    const map = new Map<Square, Square[]>();
    for (const m of gameRef.current.moves({ verbose: true }) as Move[]) {
      const arr = map.get(m.from) ?? [];
      arr.push(m.to);
      map.set(m.from, arr);
    }
    return map;
    // recompute whenever fen changes
  }, [state.fen]);

  const legalDestsFrom = useCallback(
    (from: Square): Square[] => legalDestsMap.get(from) ?? [],
    [legalDestsMap],
  );

  const tryMove = useCallback(
    (from: Square, to: Square, promotion: Promotion = 'q'): string | null => {
      try {
        const move = gameRef.current.move({ from, to, promotion });
        if (!move) return null;
        // Any new move invalidates the redo stack.
        redoStackRef.current = [];
        refresh();
        return move.san;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const playSan = useCallback(
    (san: string): string | null => {
      try {
        const move = gameRef.current.move(san);
        if (!move) return null;
        redoStackRef.current = [];
        refresh();
        return move.san;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const undo = useCallback(() => {
    const undone = gameRef.current.undo();
    if (undone) {
      redoStackRef.current.push(undone);
      refresh();
    }
  }, [refresh]);

  const redo = useCallback(() => {
    const move = redoStackRef.current.pop();
    if (!move) return;
    gameRef.current.move({ from: move.from, to: move.to, promotion: move.promotion });
    refresh();
  }, [refresh]);

  const load = useCallback(
    (fen: string): boolean => {
      try {
        gameRef.current.load(fen);
        redoStackRef.current = [];
        refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh],
  );

  const reset = useCallback(() => {
    gameRef.current.reset();
    redoStackRef.current = [];
    refresh();
  }, [refresh]);

  return {
    ...state,
    legalDestsFrom,
    legalDestsMap,
    tryMove,
    playSan,
    undo,
    redo,
    load,
    reset,
  };
}

function snapshot(game: Chess, canRedo: boolean): ChessRulesState {
  const history = game.history({ verbose: true }) as Move[];
  const last = history[history.length - 1];
  return {
    fen: game.fen(),
    turn: game.turn() as Color,
    isCheck: game.isCheck(),
    isCheckmate: game.isCheckmate(),
    isStalemate: game.isStalemate(),
    isDraw: game.isDraw(),
    isGameOver: game.isGameOver(),
    history,
    lastMove: last ? { from: last.from, to: last.to } : null,
    canUndo: history.length > 0,
    canRedo,
  };
}
