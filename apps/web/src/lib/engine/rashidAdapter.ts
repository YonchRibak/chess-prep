/**
 * Rashid engine adapter (plan Phase R2) — the one place UCI meets the Rashid
 * domain core. Produces a `RashidAnalyzeFn` (the shared core's injected
 * engine interface) backed by the real `Engine`, with:
 *
 * - a **sequential queue**: `Engine.analyze` cancels whatever is in flight,
 *   so concurrent calls through the same engine would eat each other;
 * - **cache layer A** (rashid-dev-plan.md §C7): raw MultiPV output keyed by
 *   (fenKey, engine build, node budget, multipv). Hero-independent and
 *   config-independent — retuning Rashid's constants never invalidates it;
 * - **gate fail-fast** (plan §C10): `analyzeOnce` on a gated engine hangs
 *   forever (`analyze` no-ops, `done` never fires), so we refuse loudly
 *   instead of awaiting. Rashid surfaces are engine surfaces — while a card
 *   is unanswered, nothing here may run.
 */
import { fenKey, type AnalyzedMove, type RashidAnalyzeFn } from '@chess-prep/shared';
import { getEngine, type Engine, type EngineLine } from './engine.ts';
import {
  getRashidRawLocal,
  putRashidRawLocal,
  type RashidRawEntry,
} from '../idb/schema.ts';

/** Cache layer A key. Every component matters: results from a different
 * engine build, node budget, or MultiPV width are different data (§C2). */
export function rashidRawKey(
  fk: string,
  engineId: string,
  nodes: number,
  multipv: number,
): string {
  return `${fk}|${engineId}|n${nodes}|pv${multipv}`;
}

/**
 * EngineLine[] (one per multipv slot) → the domain core's AnalyzedMove[].
 * Order by multipv rank — that *is* "best-first for the side to move".
 * Lines without a pv move carry no candidate and are dropped.
 */
export function linesToAnalyzedMoves(lines: EngineLine[]): AnalyzedMove[] {
  return [...lines]
    .sort((a, b) => a.multipv - b.multipv)
    .filter((l) => l.pv.length > 0)
    .map((l) => ({ uci: l.pv[0] as string, cp: l.cp, mate: l.mate }));
}

/** Injectable cache so tests run against a Map; production uses IndexedDB. */
export interface RashidRawCache {
  get(key: string): Promise<RashidRawEntry | undefined>;
  put(entry: RashidRawEntry): Promise<void>;
}

const idbCache: RashidRawCache = {
  get: getRashidRawLocal,
  put: putRashidRawLocal,
};

export interface RashidAdapterOptions {
  /** Fixed node budget for every search this fn issues (comparable, cacheable). */
  nodes: number;
  /** Defaults to the app-wide singleton. Precompute (R5) passes its own. */
  engine?: Engine;
  /** Defaults to the IndexedDB layer-A cache. `null` disables caching —
   * used by the lab's throughput measurement, where a hit would fake the
   * timing. */
  cache?: RashidRawCache | null;
  /** Cache-key engine id. Normally read from the engine after init; passing
   * it lets a cache hit resolve without touching the engine at all (so a
   * cold-start wasm failure can't break already-cached positions). */
  engineId?: string;
}

export function createRashidAnalyzeFn(opts: RashidAdapterOptions): RashidAnalyzeFn {
  const engine = opts.engine ?? getEngine();
  const cache = opts.cache === null ? null : (opts.cache ?? idbCache);
  let engineId = opts.engineId ?? null;
  // Serialize calls: the walk awaits each analyze anyway, but two Rashid
  // consumers sharing one engine must not interleave `go` commands.
  let tail: Promise<unknown> = Promise.resolve();

  const run = async (fen: string, multipv: number): Promise<AnalyzedMove[]> => {
    // Fail fast BEFORE init: a gated engine must stay silent, and awaiting
    // analyzeOnce on it would never resolve.
    if (engine.isGated()) {
      throw new Error('Rashid: engine is gated (drill in progress) — analysis refused');
    }

    const fk = fenKey(fen) as string;
    if (engineId != null && cache) {
      const hit = await cache.get(rashidRawKey(fk, engineId, opts.nodes, multipv));
      if (hit) return hit.moves;
    }

    await engine.init();
    if (engineId == null) {
      engineId = engine.getEngineId();
      if (cache) {
        const hit = await cache.get(rashidRawKey(fk, engineId, opts.nodes, multipv));
        if (hit) return hit.moves;
      }
    }

    // Re-check after the awaits: the gate may have closed while we waited.
    if (engine.isGated()) {
      throw new Error('Rashid: engine is gated (drill in progress) — analysis refused');
    }

    const progress = await engine.analyzeOnce(fen, { nodes: opts.nodes, multipv });
    const moves = linesToAnalyzedMoves(progress.lines);
    if (moves.length === 0) {
      throw new Error(`Rashid: engine returned no lines for ${fk}`);
    }
    if (cache) {
      await cache.put({
        key: rashidRawKey(fk, engineId, opts.nodes, multipv),
        fenKey: fk,
        engineId,
        nodes: opts.nodes,
        multipv,
        moves,
        savedAt: new Date().toISOString(),
      });
    }
    return moves;
  };

  return (fen, multipv) => {
    const next = tail.then(() => run(fen, multipv));
    tail = next.catch(() => {}); // a failed call must not wedge the queue
    return next;
  };
}
