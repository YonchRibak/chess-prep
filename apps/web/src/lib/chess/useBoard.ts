import { useEffect, useRef } from 'react';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';

export type BoardColor = 'white' | 'black';

export interface UseBoardOptions {
  fen: string;
  orientation: BoardColor;
  /** Whose turn it is — for movability gating. */
  turnColor: BoardColor;
  /** Which color the user can drag (null = read-only). */
  movableColor: BoardColor | null;
  /** Legal destinations per origin square; chessground enforces this. */
  movableDests: Map<Key, Key[]>;
  /** [from, to] highlight. */
  lastMove: [Key, Key] | null;
  /** Square of the king in check, if any. */
  check: BoardColor | null;
  /** Extra annotation shapes (arrows, circles) to draw on the board. */
  shapes?: DrawShape[];
  /** Fired when the user completes a drag/click move. */
  onMove?: (from: Key, to: Key) => void;
}

export interface BoardHandle {
  ref: React.RefObject<HTMLDivElement>;
  /** Direct chessground API for advanced ops (set shapes, toggle orientation, etc.). */
  api: () => Api | null;
}

/**
 * Pure board layer. Wraps Chessground — knows nothing about chess rules.
 * Callers feed it legal moves; chess.js validation lives in `useChessRules`.
 */
export function useBoard(opts: UseBoardOptions): BoardHandle {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  // Keep latest onMove without re-instantiating the board.
  const onMoveRef = useRef(opts.onMove);
  onMoveRef.current = opts.onMove;

  // Instantiate once on mount, destroy on unmount.
  useEffect(() => {
    if (!containerRef.current) return;
    const config: Config = buildConfig(opts, (from, to) => onMoveRef.current?.(from, to));
    apiRef.current = Chessground(containerRef.current, config);
    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // We deliberately only instantiate once; subsequent updates use api.set(...).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push prop updates into the chessground instance.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.set({
      fen: opts.fen,
      orientation: opts.orientation,
      turnColor: opts.turnColor,
      lastMove: opts.lastMove ?? undefined,
      check: opts.check ?? undefined,
      movable: {
        color: opts.movableColor ?? undefined,
        dests: opts.movableDests,
        free: false,
        showDests: true,
      },
    });
  }, [
    opts.fen,
    opts.orientation,
    opts.turnColor,
    opts.movableColor,
    opts.movableDests,
    opts.lastMove,
    opts.check,
  ]);

  // Shape annotations (heatmap arrows, etc.) — push separately because the
  // setShapes API is independent of board state.
  useEffect(() => {
    apiRef.current?.setShapes(opts.shapes ?? []);
  }, [opts.shapes]);

  return {
    ref: containerRef,
    api: () => apiRef.current,
  };
}

function buildConfig(
  opts: UseBoardOptions,
  onMove: (from: Key, to: Key) => void,
): Config {
  return {
    fen: opts.fen,
    orientation: opts.orientation,
    turnColor: opts.turnColor,
    lastMove: opts.lastMove ?? undefined,
    check: opts.check ?? undefined,
    coordinates: true,
    animation: { enabled: true, duration: 150 },
    movable: {
      color: opts.movableColor ?? undefined,
      dests: opts.movableDests,
      free: false,
      showDests: true,
      events: {
        after: (orig, dest) => onMove(orig, dest),
      },
    },
    draggable: {
      enabled: true,
      showGhost: true,
    },
    drawable: {
      enabled: true,
      visible: true,
      defaultSnapToValidMove: true,
    },
    highlight: {
      lastMove: true,
      check: true,
    },
    premovable: { enabled: false },
  };
}
