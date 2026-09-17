/**
 * Rashid study scan (S4) — the R5 precompute run lifted out of component
 * state into its own Zustand store, plus a *findings* list.
 *
 * Why a second store rather than a field on `app.ts`: the scan is engine
 * work that must outlive the view that started it. The editor's version died
 * on unmount, which made "scan the whole study in the background" a lie the
 * moment the user navigated to Today. This store is module-level; only
 * `cancel()` or a new `start()` stops a run.
 *
 * Why findings are collected here and not read back from the run: the R5
 * progress object only *counts* lit positions. Reporting needs *which* ones,
 * with a path the user can click into — so every processed position is
 * observed through `onResult` and lit ones are kept, with their breadcrumb.
 * `loadFromCache` rebuilds the same list from cache layer B without engine
 * time, so the report survives a reload.
 */
import { create } from 'zustand';
import { fenTurn, type RashidLine, type RashidResult } from '@chess-prep/shared';
import type { RepertoireFull, RepertoirePosition } from '../api/client.ts';
import {
  heroPositionsInPriorityOrder,
  runRashidPrecompute,
  type RashidPrecomputeOptions,
  type RashidPrecomputeProgress,
} from '../lib/engine/rashidPrecompute.ts';
import {
  LIVE_TIER,
  PRECOMPUTE_TIER,
  rashidEngineId,
  resultKeyForTier,
  type RashidResultCache,
} from '../lib/engine/rashidLive.ts';
import { getRashidResultLocal } from '../lib/idb/schema.ts';
import { buildTreeIndices, computePathToFenKey } from '../lib/tree/treeIndex.ts';

export interface RashidFinding {
  repertoireId: string;
  positionId: string;
  fenKey: string;
  fullFen: string;
  /** SANs from the root, main-line ancestors — the clickable breadcrumb. */
  pathSans: string[];
  /** Last edge's tags: which chapter(s) this position belongs to. */
  lineTags: string[];
  /** The incoming edge, so the browser can highlight the last move. */
  viaMoveId: string | null;
  best: RashidLine;
  fromCache: boolean;
}

export interface RashidScanStartOptions {
  /**
   * Also scan hero positions under dropped edges. Off elsewhere (a dropped
   * branch is one the user rejected), **on for studies**: a demoted alternate
   * is a line the user wrote down and may want to know is a trap.
   */
  includeAlternates?: boolean;
  /** Test seams, passed through to the runner. */
  compute?: RashidPrecomputeOptions['compute'];
  sleep?: RashidPrecomputeOptions['sleep'];
  isDrilling?: RashidPrecomputeOptions['isDrilling'];
}

export interface RashidScanLoadOptions {
  includeAlternates?: boolean;
  /** Test seams. */
  engineId?: string;
  cache?: Pick<RashidResultCache, 'get'>;
}

interface RashidScanStore {
  repertoireId: string | null;
  running: boolean;
  progress: RashidPrecomputeProgress | null;
  findings: RashidFinding[];
  /** True once `loadFromCache` has run for `repertoireId`. */
  cacheLoaded: boolean;
  error: string | null;
  start(rep: RepertoireFull, opts?: RashidScanStartOptions): Promise<void>;
  cancel(): void;
  loadFromCache(rep: RepertoireFull, opts?: RashidScanLoadOptions): Promise<void>;
}

// Module-level run token: a new start() (or cancel) invalidates the previous
// run's callbacks, so a stale run can never write into a newer repertoire's
// findings.
let runToken = 0;

function toFinding(
  rep: RepertoireFull,
  indices: ReturnType<typeof buildTreeIndices>,
  pos: RepertoirePosition,
  result: RashidResult,
  fromCache: boolean,
): RashidFinding | null {
  if (!result.lightsUp || !result.best) return null;
  const path = computePathToFenKey(rep, indices, pos.fenKey);
  const last = path[path.length - 1];
  return {
    repertoireId: rep.id,
    positionId: pos.id,
    fenKey: pos.fenKey,
    fullFen: pos.fullFen,
    pathSans: path.map((m) => m.san),
    lineTags: last?.lineTags ?? [],
    viaMoveId: last?.id ?? null,
    best: result.best,
    fromCache,
  };
}

function upsert(list: RashidFinding[], f: RashidFinding): RashidFinding[] {
  const i = list.findIndex((x) => x.positionId === f.positionId);
  if (i < 0) return [...list, f];
  const next = list.slice();
  next[i] = f;
  return next;
}

export const useRashidScan = create<RashidScanStore>((set, get) => ({
  repertoireId: null,
  running: false,
  progress: null,
  findings: [],
  cacheLoaded: false,
  error: null,

  async start(rep, opts = {}) {
    const token = ++runToken;
    const indices = buildTreeIndices(rep);
    const sameRep = get().repertoireId === rep.id;
    set({
      repertoireId: rep.id,
      running: true,
      progress: null,
      error: null,
      // Keep findings when re-scanning the same study — a rerun is the
      // "invalidation" (layer-B hits are instant), not a fresh report.
      findings: sameRep ? get().findings : [],
      cacheLoaded: sameRep ? get().cacheLoaded : false,
    });
    try {
      await runRashidPrecompute(rep, {
        includeDropped: opts.includeAlternates ?? Boolean(rep.source),
        compute: opts.compute,
        sleep: opts.sleep,
        isDrilling: opts.isDrilling,
        shouldCancel: () => token !== runToken,
        onProgress: (p) => {
          if (token === runToken) set({ progress: p });
        },
        onResult: (pos, result, fromCache) => {
          if (token !== runToken) return;
          const f = toFinding(rep, indices, pos, result, fromCache);
          if (f) set({ findings: upsert(get().findings, f) });
        },
      });
    } catch (e) {
      if (token === runToken) set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (token === runToken) set({ running: false });
    }
  },

  cancel() {
    runToken++;
    set({ running: false });
  },

  async loadFromCache(rep, opts = {}) {
    const includeDropped = opts.includeAlternates ?? Boolean(rep.source);
    const cache = opts.cache ?? { get: getRashidResultLocal };
    let engineId: string;
    try {
      engineId = opts.engineId ?? (await rashidEngineId());
    } catch (e) {
      // No engine (wasm boot failed offline): the cache is intact but its keys
      // are engine-specific, so there is nothing safe to show.
      set({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const indices = buildTreeIndices(rep);
    const hero: 'w' | 'b' = rep.color === 'white' ? 'w' : 'b';
    let findings = get().repertoireId === rep.id ? get().findings : [];
    for (const pos of heroPositionsInPriorityOrder(rep, { includeDropped })) {
      if (fenTurn(pos.fullFen) !== hero) continue;
      for (const tier of [PRECOMPUTE_TIER, LIVE_TIER]) {
        const hit = await cache.get(resultKeyForTier(pos.fenKey, hero, engineId, tier));
        if (!hit) continue;
        const f = toFinding(rep, indices, pos, hit.result, true);
        if (f) findings = upsert(findings, f);
        break; // precompute tier is strictly better; don't overwrite with live
      }
    }
    set({ repertoireId: rep.id, findings, cacheLoaded: true });
  },
}));
