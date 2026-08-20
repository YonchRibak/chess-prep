import { useEffect, useRef, useState } from 'react';
import {
  getEngine,
  type AnalysisProgress,
  type AnalyzeOptions,
} from './engine.ts';

export interface EngineHookState {
  ready: boolean;
  progress: AnalysisProgress | null;
  error: string | null;
}

/**
 * Bring up the engine on mount, subscribe to its progress.
 * Auto-analyzes whenever `fen` changes; `enabled=false` pauses analysis without
 * tearing the engine down.
 *
 * `gated` (Phase 8b) is a stronger guarantee than `enabled`: it flips the
 * engine module's gate flag on/off, ensuring `analyze()` becomes a no-op AND
 * any in-flight analysis is cancelled. Use `gated` from drill/daily-diet code
 * paths where the engine cannot leak the answer; use `enabled` for plain
 * lazy-load UX (e.g. "show eval" toggle in the editor).
 */
export function useEngine(
  fen: string | null,
  opts: AnalyzeOptions & { enabled?: boolean; gated?: boolean } = {},
): EngineHookState {
  const { enabled = true, gated = false, ...analyzeOpts } = opts;
  const [state, setState] = useState<EngineHookState>({
    ready: false,
    progress: null,
    error: null,
  });

  // Keep latest opts in a ref so the analyze-effect only re-runs on fen/enabled changes.
  const optsRef = useRef(analyzeOpts);
  optsRef.current = analyzeOpts;

  // Spin up the engine once per page lifetime (singleton).
  useEffect(() => {
    const engine = getEngine();
    let cancelled = false;
    engine
      .init()
      .then(() => {
        if (!cancelled) setState((s) => ({ ...s, ready: true }));
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
        }
      });
    return () => {
      cancelled = true;
      // Do NOT terminate the worker — other components may still use it.
    };
  }, []);

  // Subscribe to progress events.
  useEffect(() => {
    const engine = getEngine();
    return engine.onProgress((p) => setState((s) => ({ ...s, progress: p })));
  }, []);

  // Phase 8b: keep the engine module's gate in sync with this hook's `gated`
  // prop. The gate is process-wide (engine is a singleton) — every consumer
  // sees it. When this hook gates, it ALSO clears stale progress so the UI
  // can't continue rendering an old eval.
  useEffect(() => {
    const engine = getEngine();
    engine.setGated(gated);
    if (gated) setState((s) => ({ ...s, progress: null }));
  }, [gated]);

  // Kick off analysis whenever fen changes. (Skipped while gated or disabled —
  // the engine module also refuses gated analyses as a defense in depth.)
  useEffect(() => {
    if (!state.ready || !enabled || gated || !fen) return;
    const engine = getEngine();
    // Clear stale progress so the UI doesn't briefly show last fen's eval.
    setState((s) => ({ ...s, progress: null }));
    engine.analyze(fen, optsRef.current);
    return () => {
      engine.stop();
    };
  }, [state.ready, enabled, gated, fen]);

  return state;
}

/** Normalize a side-to-move-relative score into white's perspective. */
export function whiteCp(line: { cp?: number; mate?: number }, turn: 'w' | 'b'): {
  cp?: number;
  mate?: number;
} {
  if (line.mate != null) {
    return { mate: turn === 'w' ? line.mate : -line.mate };
  }
  if (line.cp != null) {
    return { cp: turn === 'w' ? line.cp : -line.cp };
  }
  return {};
}

/** Format an eval as a short string like "+0.32" or "M5". */
export function formatEval(line: { cp?: number; mate?: number }): string {
  if (line.mate != null) {
    return line.mate >= 0 ? `M${line.mate}` : `-M${-line.mate}`;
  }
  if (line.cp != null) {
    const pawns = line.cp / 100;
    const sign = pawns >= 0 ? '+' : '';
    return `${sign}${pawns.toFixed(2)}`;
  }
  return '?';
}
