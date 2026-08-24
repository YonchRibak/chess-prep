/**
 * Rashid adapter (plan R2): the UCI↔domain boundary. What matters here:
 * multipv-rank ordering survives the mapping (the domain core's "best-first"
 * contract), the cache key carries every determinism component (§C2), a
 * cache hit never touches the engine, and a gated engine is refused loudly —
 * awaiting it would hang forever, and silence is how answers leak.
 */
import { describe, it, expect } from 'vitest';
import { fenKey, STARTING_FEN } from '@chess-prep/shared';
import { Engine, type EngineLine } from './engine.ts';
import {
  createRashidAnalyzeFn,
  linesToAnalyzedMoves,
  rashidRawKey,
  type RashidRawCache,
} from './rashidAdapter.ts';
import type { RashidRawEntry } from '../idb/schema.ts';

function mapCache(): RashidRawCache & { store: Map<string, RashidRawEntry> } {
  const store = new Map<string, RashidRawEntry>();
  return {
    store,
    get: async (k) => store.get(k),
    put: async (e) => {
      store.set(e.key, e);
    },
  };
}

describe('linesToAnalyzedMoves', () => {
  it('orders by multipv rank and takes the first pv move', () => {
    const lines: EngineLine[] = [
      { multipv: 2, depth: 20, cp: 10, pv: ['d2d4', 'd7d5'] },
      { multipv: 1, depth: 20, cp: 30, pv: ['e2e4'] },
      { multipv: 3, depth: 20, mate: 5, pv: ['g1f3'] },
    ];
    expect(linesToAnalyzedMoves(lines)).toEqual([
      { uci: 'e2e4', cp: 30, mate: undefined },
      { uci: 'd2d4', cp: 10, mate: undefined },
      { uci: 'g1f3', cp: undefined, mate: 5 },
    ]);
  });

  it('drops a line without a pv move rather than inventing a candidate', () => {
    const lines: EngineLine[] = [
      { multipv: 1, depth: 20, cp: 30, pv: ['e2e4'] },
      { multipv: 2, depth: 20, cp: 10, pv: [] },
    ];
    expect(linesToAnalyzedMoves(lines)).toHaveLength(1);
  });
});

describe('rashidRawKey', () => {
  it('differs when ANY determinism component differs', () => {
    const base = rashidRawKey('fk', 'SF16', 300000, 4);
    expect(rashidRawKey('fk2', 'SF16', 300000, 4)).not.toBe(base);
    expect(rashidRawKey('fk', 'SF17', 300000, 4)).not.toBe(base);
    expect(rashidRawKey('fk', 'SF16', 100000, 4)).not.toBe(base);
    expect(rashidRawKey('fk', 'SF16', 300000, 8)).not.toBe(base);
    expect(rashidRawKey('fk', 'SF16', 300000, 4)).toBe(base);
  });
});

describe('createRashidAnalyzeFn', () => {
  it('refuses a gated engine before ever touching the worker', async () => {
    const engine = new Engine();
    const messages: string[] = [];
    (engine as unknown as { worker: { postMessage(m: string): void } }).worker = {
      postMessage: (m: string) => messages.push(m),
    };
    engine.setGated(true);
    messages.length = 0; // setGated itself sends a stop; not what we assert

    const fn = createRashidAnalyzeFn({ nodes: 1000, engine, cache: null });
    await expect(fn(STARTING_FEN, 4)).rejects.toThrow(/gated/);
    expect(messages.some((m) => m.startsWith('go'))).toBe(false);
  });

  it('serves a cache hit without initializing the engine at all', async () => {
    // A fresh Engine with NO worker: any engine use would throw. The hit
    // must resolve purely from the cache when engineId is supplied — this is
    // also the property that keeps cached positions working when wasm fails
    // to boot offline.
    const engine = new Engine();
    const cache = mapCache();
    const fk = fenKey(STARTING_FEN) as string;
    const moves = [{ uci: 'e2e4', cp: 30 }];
    cache.store.set(rashidRawKey(fk, 'test-engine', 1000, 4), {
      key: rashidRawKey(fk, 'test-engine', 1000, 4),
      fenKey: fk,
      engineId: 'test-engine',
      nodes: 1000,
      multipv: 4,
      moves,
      savedAt: '2026-01-01T00:00:00.000Z',
    });

    const fn = createRashidAnalyzeFn({ nodes: 1000, engine, cache, engineId: 'test-engine' });
    await expect(fn(STARTING_FEN, 4)).resolves.toEqual(moves);
  });

  it('misses the cache when the budget differs, and the miss reaches the engine', async () => {
    const engine = new Engine();
    const cache = mapCache();
    const fk = fenKey(STARTING_FEN) as string;
    cache.store.set(rashidRawKey(fk, 'test-engine', 1000, 4), {
      key: rashidRawKey(fk, 'test-engine', 1000, 4),
      fenKey: fk,
      engineId: 'test-engine',
      nodes: 1000,
      multipv: 4,
      moves: [{ uci: 'e2e4', cp: 30 }],
      savedAt: '2026-01-01T00:00:00.000Z',
    });

    // Different node budget → different key → must NOT serve the 1000-node
    // entry. It falls through to engine.init(), which throws here (no
    // Worker in this environment) — proving the engine was consulted.
    const fn = createRashidAnalyzeFn({ nodes: 2000, engine, cache, engineId: 'test-engine' });
    await expect(fn(STARTING_FEN, 4)).rejects.toThrow();
  });
});
