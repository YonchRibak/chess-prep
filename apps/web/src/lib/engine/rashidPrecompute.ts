/**
 * Rashid background precompute (plan Phase R5).
 *
 * Walks the repertoire's hero-to-move positions in priority order and runs
 * the full precompute-tier analysis on each, filling cache layers A + B so
 * live probes become instant lookups.
 *
 * Follows the healthCheck.ts batch pattern: sequential, progress callback,
 * caller-owned cancellation. Two Rashid-specific rules on top:
 *
 * - **Pauses while drilling.** The precompute engine is a separate worker
 *   the singleton's gate cannot silence, and the no-leak guarantee is about
 *   worker chatter — so the loop itself waits whenever the singleton is
 *   gated (plan §C10) and resumes when the drill ends.
 * - **No invalidation hooks, on purpose.** The plan provisioned them, but
 *   both cache layers are keyed by *position*, not by repertoire — an edit
 *   cannot make an entry stale, it only changes which positions are worth
 *   computing. Re-running after edits is the "invalidation": existing work
 *   is an instant layer-B hit, only new positions cost engine time.
 *
 * Priority order is **BFS depth** (shallow first, transpositions once,
 * dropped/refutation subtrees excluded). The plan wanted game-weighted
 * explorer ordering; that would make precompute depend on explorer data,
 * which must not happen — this has to work fully offline. Depth is the
 * offline-safe proxy: shallow positions are the ones reached in more games.
 */
import { fenTurn, type RashidResult } from '@chess-prep/shared';
import { Engine, getEngine } from './engine.ts';
import { computeAndStoreRashid, PRECOMPUTE_TIER, RashidCancelled } from './rashidLive.ts';
import type { RepertoireFull, RepertoirePosition } from '../../api/client.ts';

export interface RashidPrecomputeProgress {
  total: number;
  /** Positions processed this run (computed + cached + failed). */
  done: number;
  /** Fresh engine work. */
  computed: number;
  /** Already in layer B — instant. */
  cached: number;
  /** Positions where Rashid lights up. */
  lit: number;
  /** Positions that errored (e.g. terminal — mate in the repertoire). */
  failed: number;
  current: RepertoirePosition | null;
  /** True while waiting for a drill to finish. */
  paused: boolean;
}

/**
 * Hero-to-move positions, shallowest first. BFS over live prep edges only:
 * dropped subtrees were rejected by the user and shadow (refutation) lines
 * are not prep — precomputing either would spend minutes of engine time on
 * positions the user never plays toward.
 */
export function heroPositionsInPriorityOrder(
  rep: RepertoireFull,
  opts: { includeDropped?: boolean } = {},
): RepertoirePosition[] {
  const heroTurn = rep.color === 'white' ? 'w' : 'b';
  const positionById = new Map(rep.positions.map((p) => [p.id, p]));
  const childIdsByParent = new Map<string, string[]>();
  for (const m of rep.moves) {
    if (m.isRefutation) continue;
    // S4: a study's demoted alternates are dropped edges the user *wrote
    // down*; the study scan opts in to them. Shadow lines stay excluded.
    if (m.isDropped && !opts.includeDropped) continue;
    const list = childIdsByParent.get(m.parentPositionId) ?? [];
    list.push(m.childPositionId);
    childIdsByParent.set(m.parentPositionId, list);
  }

  const root = rep.positions.find((p) => p.fenKey === rep.rootFenKey);
  if (!root) return [];

  const ordered: RepertoirePosition[] = [];
  const seen = new Set<string>([root.id]);
  let frontier = [root];
  while (frontier.length > 0) {
    const next: RepertoirePosition[] = [];
    for (const pos of frontier) {
      if (fenTurn(pos.fullFen) === heroTurn) ordered.push(pos);
      for (const childId of childIdsByParent.get(pos.id) ?? []) {
        if (seen.has(childId)) continue; // transpositions analyzed once
        seen.add(childId);
        const child = positionById.get(childId);
        if (child) next.push(child);
      }
    }
    frontier = next;
  }
  return ordered;
}

export interface RashidPrecomputeOptions {
  onProgress?: (p: RashidPrecomputeProgress) => void;
  /** S4: every processed position with its result — the study scan keeps the
   * lit ones as findings, which `RashidPrecomputeProgress` only counts. */
  onResult?: (pos: RepertoirePosition, result: RashidResult, fromCache: boolean) => void;
  /** S4: also visit hero positions under dropped edges (study alternates). */
  includeDropped?: boolean;
  shouldCancel?: () => boolean;
  /** Test seams — production uses the real compute core / gate / clock. */
  compute?: (
    fen: string,
    heroColor: 'w' | 'b',
  ) => Promise<{ result: RashidResult; fromCache: boolean }>;
  isDrilling?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

let precomputeEngine: Engine | null = null;

/** Third engine instance: live probes must stay snappy while precompute
 * grinds — sharing the live worker would queue a probe behind ~10s of
 * precompute searches. */
function getPrecomputeEngine(): Engine {
  if (!precomputeEngine) precomputeEngine = new Engine();
  return precomputeEngine;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run precompute over one repertoire. Resumable by construction: cancel at
 * any point and a later run skips finished positions via layer B.
 */
export async function runRashidPrecompute(
  rep: RepertoireFull,
  opts: RashidPrecomputeOptions = {},
): Promise<RashidPrecomputeProgress> {
  const heroColor: 'w' | 'b' = rep.color === 'white' ? 'w' : 'b';
  const shouldCancel = opts.shouldCancel ?? (() => false);
  const isDrilling = opts.isDrilling ?? (() => getEngine().isGated());
  const sleep = opts.sleep ?? realSleep;
  const compute =
    opts.compute ??
    ((fen: string, hero: 'w' | 'b') =>
      computeAndStoreRashid(fen, hero, {
        engine: getPrecomputeEngine(),
        tier: PRECOMPUTE_TIER,
        isCancelled: shouldCancel,
      }));

  const positions = heroPositionsInPriorityOrder(rep, { includeDropped: opts.includeDropped });
  const progress: RashidPrecomputeProgress = {
    total: positions.length,
    done: 0,
    computed: 0,
    cached: 0,
    lit: 0,
    failed: 0,
    current: null,
    paused: false,
  };
  const emit = () => opts.onProgress?.({ ...progress });

  for (const pos of positions) {
    if (shouldCancel()) break;

    // Drill pause: wait, don't abort — the run resumes when the gate lifts.
    while (isDrilling()) {
      if (!progress.paused) {
        progress.paused = true;
        progress.current = null;
        emit();
      }
      await sleep(2000);
      if (shouldCancel()) break;
    }
    if (shouldCancel()) break;
    progress.paused = false;
    progress.current = pos;
    emit();

    try {
      const { result, fromCache } = await compute(pos.fullFen, heroColor);
      if (fromCache) progress.cached += 1;
      else progress.computed += 1;
      if (result.lightsUp) progress.lit += 1;
      opts.onResult?.(pos, result, fromCache);
    } catch (e) {
      if (e instanceof RashidCancelled) break;
      // Terminal position (mate inside the prep) or an engine hiccup — count
      // it and move on; one bad position must not sink the whole run.
      progress.failed += 1;
    }
    progress.done += 1;
    emit();

    // Yield between positions so the UI thread and the live probe's queue
    // get a look-in on this worker-adjacent main-thread orchestration.
    await sleep(25);
  }

  progress.current = null;
  emit();
  return progress;
}
