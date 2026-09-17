import { useEffect, useRef } from 'react';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Key } from 'chessground/types';
import type { DrawBrush, DrawBrushes, DrawShape } from 'chessground/draw';

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
  /** Additional named brushes to register beyond chessground's defaults, so
   * `shapes` can reference custom hues/opacities (e.g. the Rashid bands).
   * Init-time only — chessground merges them into its default brush set. */
  extraBrushes?: Record<string, DrawBrush>;
  /** Fired when the user completes a drag/click move. */
  onMove?: (from: Key, to: Key) => void;
  /**
   * Piece-glide duration for the next position change (default 150). `0`
   * disables animation, so a caller can snap-load a line and then animate
   * only its final ply — see `useLineTransition`.
   */
  animationMs?: number;
}

const DEFAULT_ANIMATION_MS = 150;

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
    const animationMs = opts.animationMs ?? DEFAULT_ANIMATION_MS;
    api.set({
      fen: opts.fen,
      orientation: opts.orientation,
      turnColor: opts.turnColor,
      lastMove: opts.lastMove ?? undefined,
      check: opts.check ?? undefined,
      // chessground reads `animation` per `set`, so this steers the glide of
      // THIS update; it must travel in the same call as the new fen.
      animation: { enabled: animationMs > 0, duration: animationMs },
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
    opts.animationMs,
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
    animation: {
      enabled: (opts.animationMs ?? DEFAULT_ANIMATION_MS) > 0,
      duration: opts.animationMs ?? DEFAULT_ANIMATION_MS,
    },
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
      // Partial by design: chessground deep-merges this over its default
      // green/blue/yellow/red set, so defaults stay available.
      ...(opts.extraBrushes ? { brushes: opts.extraBrushes as DrawBrushes } : {}),
    },
    highlight: {
      lastMove: true,
      check: true,
    },
    premovable: { enabled: false },
  };
}
