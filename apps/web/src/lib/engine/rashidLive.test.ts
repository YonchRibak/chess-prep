/**
 * Rashid live probe (plan R3). What matters: a layer-B hit resolves without
 * touching the engine, the derivation key includes the tuning config (a
 * retuned constant can never serve a stale result), cancellation is control
 * flow rather than an error, and the SINGLETON's gate silences this module
 * even though it runs its own worker — that cross-instance check is the
 * no-leak guarantee's reach into Rashid.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_RASHID_CONFIG,
  fenKey,
  rashidConfigKey,
  STARTING_FEN,
  type RashidResult,
} from '@chess-prep/shared';
import { Engine, getEngine } from './engine.ts';
import {
  LIVE_RASHID_CONFIG,
  NODES_LIVE,
  RashidCancelled,
  rashidResultKey,
  requestRashid,
} from './rashidLive.ts';
import type { RashidResultEntry } from '../idb/schema.ts';

const EMPTY_RESULT: RashidResult = {
  lightsUp: false,
  best: null,
  lines: [],
  bestRootScore: 0,
  candidates: [],
};

function entryFor(key: string): RashidResultEntry {
  return {
    key,
    fenKey: fenKey(STARTING_FEN) as string,
    heroColor: 'w',
    engineId: 'test-engine',
    nodes: NODES_LIVE,
    configKey: rashidConfigKey(LIVE_RASHID_CONFIG),
    result: EMPTY_RESULT,
    savedAt: '2026-01-01T00:00:00.000Z',
  };
}

function mapCache() {
  const store = new Map<string, RashidResultEntry>();
  return {
    store,
    get: async (k: string) => store.get(k),
    put: async (e: RashidResultEntry) => {
      store.set(e.key, e);
    },
  };
}

afterEach(() => {
  getEngine().setGated(false); // never leak gate state between tests
});

describe('rashidResultKey', () => {
  it('differs on every derivation component, including the tuning config', () => {
    const fk = fenKey(STARTING_FEN) as string;
    const cfgKey = rashidConfigKey(LIVE_RASHID_CONFIG);
    const base = rashidResultKey(fk, 'w', 'SF16', 300000, cfgKey);
    expect(rashidResultKey(fk, 'b', 'SF16', 300000, cfgKey)).not.toBe(base);
    expect(rashidResultKey(fk, 'w', 'SF17', 300000, cfgKey)).not.toBe(base);
    expect(rashidResultKey(fk, 'w', 'SF16', 100000, cfgKey)).not.toBe(base);
    // A retuned constant produces a different config key → different entry.
    const retuned = rashidConfigKey({ ...LIVE_RASHID_CONFIG, narrowThreshold: 0.2 });
    expect(rashidResultKey(fk, 'w', 'SF16', 300000, retuned)).not.toBe(base);
  });

  it('live config is the default config with a shorter walk', () => {
    expect(LIVE_RASHID_CONFIG).toEqual({ ...DEFAULT_RASHID_CONFIG, maxPly: 4 });
  });
});

describe('requestRashid', () => {
  it('serves a layer-B hit without initializing the engine', async () => {
    const engine = new Engine(); // no worker: any engine use would throw
    const cache = mapCache();
    const fk = fenKey(STARTING_FEN) as string;
    const key = rashidResultKey(
      fk,
      'w',
      'test-engine',
      NODES_LIVE,
      rashidConfigKey(LIVE_RASHID_CONFIG),
    );
    cache.store.set(key, entryFor(key));

    const handle = requestRashid(STARTING_FEN, 'w', {
      engine,
      resultCache: cache,
      engineId: 'test-engine',
    });
    await expect(handle.promise).resolves.toEqual({ result: EMPTY_RESULT, fromCache: true });
  });

  it('a config change misses the cache and reaches the engine', async () => {
    const engine = new Engine();
    const cache = mapCache();
    const fk = fenKey(STARTING_FEN) as string;
    const key = rashidResultKey(
      fk,
      'w',
      'test-engine',
      NODES_LIVE,
      rashidConfigKey(LIVE_RASHID_CONFIG),
    );
    cache.store.set(key, entryFor(key));

    // Same position, retuned threshold → the stored derivation must NOT be
    // served. Falls through to engine.init(), which throws here (no Worker) —
    // proving the engine was consulted.
    const handle = requestRashid(STARTING_FEN, 'w', {
      engine,
      resultCache: cache,
      engineId: 'test-engine',
      cfg: { ...LIVE_RASHID_CONFIG, narrowThreshold: 0.2 },
    });
    await expect(handle.promise).rejects.toThrow();
  });

  it('cancel() before the probe starts is RashidCancelled, not an error', async () => {
    const engine = new Engine();
    const handle = requestRashid(STARTING_FEN, 'w', { engine, resultCache: mapCache() });
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(RashidCancelled);
  });

  it("refuses while the SINGLETON's gate is closed, even with its own engine", async () => {
    const engine = new Engine();
    const cache = mapCache();
    getEngine().setGated(true);
    // Even a would-be cache hit is refused: while drilling, Rashid answers
    // nothing at all.
    const fk = fenKey(STARTING_FEN) as string;
    const key = rashidResultKey(
      fk,
      'w',
      'test-engine',
      NODES_LIVE,
      rashidConfigKey(LIVE_RASHID_CONFIG),
    );
    cache.store.set(key, entryFor(key));

    const handle = requestRashid(STARTING_FEN, 'w', {
      engine,
      resultCache: cache,
      engineId: 'test-engine',
    });
    await expect(handle.promise).rejects.toThrow(/gated/);
  });
});
