/**
 * Rashid on-demand analysis (plan Phases R3/R5) — the shared compute core,
 * cache layer B, and the live probe.
 *
 * Two **tiers** share one code path: precompute (1M nodes, full walk) and
 * live (300k nodes, short walk). A live request prefers a precompute-quality
 * cache entry when one exists — that is how R5's background work makes the
 * editor instant — and only falls back to computing at the live tier.
 *
 * Live probes run on a **dedicated engine instance**, not the app-wide
 * singleton: the editor's eval panel keeps the singleton busy with continuous
 * analysis, and `Engine.analyze` cancels in-flight work — sharing one engine
 * would make the panel and the Rashid walk silently kill each other's
 * searches (worse: a superseded `analyzeOnce` never resolves). Precompute
 * (rashidPrecompute.ts) uses a third instance for the same reason.
 *
 * The gate rule still binds (see knowledge/03-domain/rashid.md): extra
 * instances are NOT covered by the singleton's gate, so every search here
 * first checks the **singleton's** gate and refuses while it is closed.
 * Rashid surfaces are engine surfaces; a drill in progress silences all of
 * them.
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

/** R0 decision (plan §R0 results): live probes at 300k, precompute at 1M —
 * time turned out to be cheap, so the background tier spends it on quality. */
export const NODES_LIVE = 300_000;
export const NODES_PRECOMPUTE = 1_000_000;

/** Live config: shallower walk than precompute — a probe the user is
 * actively waiting on must stay in the low seconds (plan §C6). */
export const LIVE_RASHID_CONFIG: RashidConfig = {
  ...DEFAULT_RASHID_CONFIG,
  maxPly: 4,
};

/** A (budget, config) pair — everything that shapes a derived result besides
 * the position itself and the engine build. */
export interface RashidTier {
  nodes: number;
  cfg: RashidConfig;
}

export const PRECOMPUTE_TIER: RashidTier = { nodes: NODES_PRECOMPUTE, cfg: DEFAULT_RASHID_CONFIG };
export const LIVE_TIER: RashidTier = { nodes: NODES_LIVE, cfg: LIVE_RASHID_CONFIG };

export function rashidResultKey(
  fk: string,
  heroColor: 'w' | 'b',
  engineId: string,
  nodes: number,
  configKey: string,
): string {
  return `${fk}|${heroColor}|${engineId}|n${nodes}|${configKey}`;
}

function tierKey(fk: string, heroColor: 'w' | 'b', engineId: string, tier: RashidTier): string {
  return rashidResultKey(fk, heroColor, engineId, tier.nodes, rashidConfigKey(tier.cfg));
}

/** S4: the exact layer-B key `computeAndStoreRashid` writes for a tier, so a
 * reader (the study scan's cache reload) can never drift from the writer. */
export function resultKeyForTier(
  fk: string,
  heroColor: 'w' | 'b',
  engineId: string,
  tier: RashidTier,
): string {
  return tierKey(fk, heroColor, engineId, tier);
}

/** Thrown when a probe is superseded (user navigated on) or a precompute run
 * is cancelled. Callers should swallow it — control flow, not a failure. */
export class RashidCancelled extends Error {
  constructor() {
    super('Rashid probe cancelled');
    this.name = 'RashidCancelled';
  }
}

export interface RashidResultCache {
  get(key: string): Promise<RashidResultEntry | undefined>;
  put(entry: RashidResultEntry): Promise<void>;
}

const idbResultCache: RashidResultCache = {
  get: getRashidResultLocal,
  put: putRashidResultLocal,
};

function assertUngated(): void {
  if (getEngine().isGated()) {
    throw new Error('Rashid: engine is gated (drill in progress) — analysis refused');
  }
}

export interface ComputeRashidOptions {
  engine: Engine;
  tier: RashidTier;
  resultCache?: RashidResultCache;
  isCancelled?: () => boolean;
  /** Known engine build id — lets a cache hit resolve without touching the
   * engine (cached positions survive a wasm boot failure offline). */
  engineId?: string;
}

/**
 * The shared core: layer-B read-through at exactly one tier. Checks the
 * singleton's gate and the cancellation token before starting and before
 * every search the walk issues.
 */
export async function computeAndStoreRashid(
  fen: string,
  heroColor: 'w' | 'b',
  opts: ComputeRashidOptions,
): Promise<{ result: RashidResult; fromCache: boolean }> {
  const { engine, tier } = opts;
  const resultCache = opts.resultCache ?? idbResultCache;
  const isCancelled = opts.isCancelled ?? (() => false);

  if (isCancelled()) throw new RashidCancelled();
  assertUngated();

  const fk = fenKey(fen) as string;
  let engineId = opts.engineId ?? null;
  if (engineId != null) {
    const hit = await resultCache.get(tierKey(fk, heroColor, engineId, tier));
    if (hit) return { result: hit.result, fromCache: true };
  } else {
    await engine.init();
    engineId = engine.getEngineId();
    const hit = await resultCache.get(tierKey(fk, heroColor, engineId, tier));
    if (hit) return { result: hit.result, fromCache: true };
  }
  if (isCancelled()) throw new RashidCancelled();
  assertUngated();

  const base = createRashidAnalyzeFn({ nodes: tier.nodes, engine, engineId });
  const analyze: typeof base = (f, multipv) => {
    if (isCancelled()) throw new RashidCancelled();
    assertUngated();
    return base(f, multipv);
  };

  const result = await rashidAnalyze(fen, heroColor, analyze, tier.cfg);
  await resultCache.put({
    key: tierKey(fk, heroColor, engineId, tier),
    fenKey: fk,
    heroColor,
    engineId,
    nodes: tier.nodes,
    configKey: rashidConfigKey(tier.cfg),
    result,
    savedAt: new Date().toISOString(),
  });
  return { result, fromCache: false };
}

let liveEngine: Engine | null = null;

/** Dedicated live-probe engine — see module doc for why not the singleton. */
function getRashidEngine(): Engine {
  if (!liveEngine) liveEngine = new Engine();
  return liveEngine;
}

/** The engine build id cache keys are scoped to. Boots the live worker if
 * needed; rejects when wasm cannot start (offline boot failure). */
export async function rashidEngineId(): Promise<string> {
  const e = getRashidEngine();
  await e.init();
  return e.getEngineId();
}

export interface RashidLiveHandle {
  promise: Promise<{ result: RashidResult; fromCache: boolean }>;
  /** Abort at the next engine call; the current ~0.3s search still finishes. */
  cancel: () => void;
}

interface LiveDeps {
  engine?: Engine;
  resultCache?: RashidResultCache;
  cfg?: RashidConfig;
  nodes?: number;
  /** See ComputeRashidOptions.engineId. */
  engineId?: string;
}

// One probe at a time: probes share the dedicated engine, and interleaved
// walks would cancel each other's searches just like on the singleton.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Live Rashid for one hero-to-move position. Looks for a **precompute-tier**
 * entry first (deeper budget and walk — strictly better), then the live
 * tier; a miss computes at the live tier. A custom cfg/nodes override
 * (lab/tests) checks only its own exact tier — a tuned request must never be
 * answered from a differently-tuned entry.
 */
export function requestRashid(
  fen: string,
  heroColor: 'w' | 'b',
  deps: LiveDeps = {},
): RashidLiveHandle {
  let cancelled = false;
  const engine = deps.engine ?? getRashidEngine();
  const resultCache = deps.resultCache ?? idbResultCache;
  const custom = deps.cfg != null || deps.nodes != null;
  const computeTier: RashidTier = custom
    ? { nodes: deps.nodes ?? NODES_LIVE, cfg: deps.cfg ?? LIVE_RASHID_CONFIG }
    : LIVE_TIER;
  const peekTiers = custom ? [computeTier] : [PRECOMPUTE_TIER, LIVE_TIER];

  const work = async (): Promise<{ result: RashidResult; fromCache: boolean }> => {
    if (cancelled) throw new RashidCancelled();
    assertUngated();

    // Peek the better tiers when the engine build is already known — without
    // engineId the compute core does its own post-init lookup.
    if (deps.engineId != null) {
      const fk = fenKey(fen) as string;
      for (const tier of peekTiers) {
        const hit = await resultCache.get(tierKey(fk, heroColor, deps.engineId, tier));
        if (hit) return { result: hit.result, fromCache: true };
      }
    } else {
      await engine.init();
      const fk = fenKey(fen) as string;
      const engineId = engine.getEngineId();
      for (const tier of peekTiers) {
        const hit = await resultCache.get(tierKey(fk, heroColor, engineId, tier));
        if (hit) return { result: hit.result, fromCache: true };
      }
    }

    return computeAndStoreRashid(fen, heroColor, {
      engine,
      tier: computeTier,
      resultCache,
      isCancelled: () => cancelled,
      engineId: deps.engineId,
    });
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
