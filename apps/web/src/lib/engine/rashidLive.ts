/**
 * Rashid live probe (plan Phase R3) — on-demand analysis of the currently
 * viewed position, backed by cache layer B (derived results).
 *
 * Runs on a **dedicated engine instance**, not the app-wide singleton: the
 * editor's eval panel keeps the singleton busy with continuous analysis, and
 * `Engine.analyze` cancels in-flight work — sharing one engine would make
 * the panel and the Rashid walk silently kill each other's searches (worse:
 * a superseded `analyzeOnce` never resolves).
 *
 * The gate rule still binds (see knowledge/03-domain/rashid.md): a second
 * instance is NOT covered by the singleton's gate, so every search here
 * first checks the **singleton's** gate and refuses while it is closed.
 * Rashid surfaces are engine surfaces; a drill in progress silences both
 * workers.
 */
import {
  DEFAULT_RASHID_CONFIG,
  fenKey,
  rashidAnalyze,
  rashidConfigKey,
  type RashidConfig,
  type RashidResult,
} from '@chess-prep/shared';
import { Engine, getEngine } from './engine.ts';
import { createRashidAnalyzeFn } from './rashidAdapter.ts';
import {
  getRashidResultLocal,
  putRashidResultLocal,
  type RashidResultEntry,
} from '../idb/schema.ts';

/** R0 decision (plan §R0 results): live probes run at 300k nodes. */
export const NODES_LIVE = 300_000;

/** Live config: shallower walk than precompute — a probe the user is
 * actively waiting on must stay in the low seconds (plan §C6). */
export const LIVE_RASHID_CONFIG: RashidConfig = {
  ...DEFAULT_RASHID_CONFIG,
  maxPly: 4,
};

export function rashidResultKey(
  fk: string,
  heroColor: 'w' | 'b',
  engineId: string,
  nodes: number,
  configKey: string,
): string {
  return `${fk}|${heroColor}|${engineId}|n${nodes}|${configKey}`;
}

let liveEngine: Engine | null = null;

/** Dedicated Rashid engine — see module doc for why not the singleton. */
function getRashidEngine(): Engine {
  if (!liveEngine) liveEngine = new Engine();
  return liveEngine;
}

/** Thrown when a probe is superseded (user navigated on). Callers should
 * swallow it — it is control flow, not a failure. */
export class RashidCancelled extends Error {
  constructor() {
    super('Rashid probe cancelled');
    this.name = 'RashidCancelled';
  }
}

export interface RashidLiveHandle {
  promise: Promise<{ result: RashidResult; fromCache: boolean }>;
  /** Abort at the next engine call; the current ~0.3s search still finishes. */
  cancel: () => void;
}

interface LiveDeps {
  engine?: Engine;
  resultCache?: {
    get(key: string): Promise<RashidResultEntry | undefined>;
    put(entry: RashidResultEntry): Promise<void>;
  };
  cfg?: RashidConfig;
  nodes?: number;
  /** Known engine build id — lets a cache hit resolve without touching the
   * engine (same offline property as the adapter's `engineId`). */
  engineId?: string;
}

// One probe at a time: probes share the dedicated engine, and interleaved
// walks would cancel each other's searches just like on the singleton.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Layer-B read-through Rashid analysis of one hero-to-move position.
 * Cache hit → instant, engine untouched. Miss → live walk at `NODES_LIVE`
 * with `LIVE_RASHID_CONFIG`, result stored under the full derivation key.
 */
export function requestRashid(
  fen: string,
  heroColor: 'w' | 'b',
  deps: LiveDeps = {},
): RashidLiveHandle {
  let cancelled = false;
  const engine = deps.engine ?? getRashidEngine();
  const resultCache = deps.resultCache ?? { get: getRashidResultLocal, put: putRashidResultLocal };
  const cfg = deps.cfg ?? LIVE_RASHID_CONFIG;
  const nodes = deps.nodes ?? NODES_LIVE;

  const work = async (): Promise<{ result: RashidResult; fromCache: boolean }> => {
    if (cancelled) throw new RashidCancelled();
    // The no-leak guarantee lives on the singleton's gate; honor it here
    // even though this module runs its own worker.
    if (getEngine().isGated()) {
      throw new Error('Rashid: engine is gated (drill in progress) — analysis refused');
    }

    const fk = fenKey(fen) as string;
    const cfgKey = rashidConfigKey(cfg);
    let engineId = deps.engineId ?? null;
    if (engineId != null) {
      const hit = await resultCache.get(rashidResultKey(fk, heroColor, engineId, nodes, cfgKey));
      if (hit) return { result: hit.result, fromCache: true };
    }

    await engine.init();
    engineId = engine.getEngineId();
    const key = rashidResultKey(fk, heroColor, engineId, nodes, cfgKey);
    const hit = await resultCache.get(key);
    if (hit) return { result: hit.result, fromCache: true };
    if (cancelled) throw new RashidCancelled();

    // Wrap the adapter so cancellation and the singleton's gate are checked
    // before EVERY search the walk issues, not just at the start.
    const base = createRashidAnalyzeFn({ nodes, engine, engineId });
    const analyze: typeof base = (f, multipv) => {
      if (cancelled) throw new RashidCancelled();
      if (getEngine().isGated()) {
        throw new Error('Rashid: engine gated mid-probe — analysis refused');
      }
      return base(f, multipv);
    };

    const result = await rashidAnalyze(fen, heroColor, analyze, cfg);
    await resultCache.put({
      key,
      fenKey: fk,
      heroColor,
      engineId,
      nodes,
      configKey: cfgKey,
      result,
      savedAt: new Date().toISOString(),
    });
    return { result, fromCache: false };
  };

  const promise = queue.then(work);
  queue = promise.catch(() => {}); // a failed/cancelled probe must not wedge the queue
  return {
    promise,
    cancel: () => {
      cancelled = true;
    },
  };
}
