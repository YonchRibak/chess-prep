import { describe, it, expect, vi } from 'vitest';
import { Engine, parseInfo } from './engine.ts';

describe('parseInfo', () => {
  it('parses a typical multipv cp line', () => {
    const r = parseInfo(
      'info depth 18 seldepth 24 multipv 1 score cp 32 nodes 12345 nps 600000 time 100 pv e2e4 e7e5 g1f3',
    );
    expect(r).toEqual({
      multipv: 1,
      depth: 18,
      cp: 32,
      mate: undefined,
      pv: ['e2e4', 'e7e5', 'g1f3'],
    });
  });

  it('parses a mate line', () => {
    const r = parseInfo('info depth 12 multipv 2 score mate 5 nodes 999 pv f3f7');
    expect(r?.mate).toBe(5);
    expect(r?.cp).toBeUndefined();
  });

  it('defaults missing multipv to 1', () => {
    const r = parseInfo('info depth 1 score cp 0 pv e2e4');
    expect(r?.multipv).toBe(1);
  });

  it('returns null for info lines without pv (currmove, string)', () => {
    expect(parseInfo('info depth 1 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseInfo('info string foo bar baz')).toBeNull();
  });

  it('returns null for non-info lines', () => {
    expect(parseInfo('bestmove e2e4')).toBeNull();
    expect(parseInfo('uciok')).toBeNull();
  });
});

// Stand-in for the worker: a `postMessage` recorder.
function workerStub(): { postMessage: ReturnType<typeof vi.fn>; messages: string[] } {
  const messages: string[] = [];
  const postMessage = vi.fn((m: string) => {
    messages.push(m);
  });
  return { postMessage, messages };
}

/** Inject the stub worker directly — bypasses `init()` so no real worker is
 * needed; the class only touches the worker via `send()`/`postMessage`. */
function engineWithStub(): { engine: Engine; w: ReturnType<typeof workerStub> } {
  const engine = new Engine();
  const w = workerStub();
  (engine as unknown as { worker: { postMessage: typeof w.postMessage } }).worker = {
    postMessage: w.postMessage,
  };
  return { engine, w };
}

describe('Engine.analyze go-command selection', () => {
  it('uses `go nodes` when a node budget is given (Rashid: reproducible searches)', () => {
    const { engine, w } = engineWithStub();
    engine.analyze('startpos', { nodes: 500000, multipv: 4 });
    expect(w.messages).toContain('go nodes 500000');
    expect(w.messages.some((m) => m.startsWith('go depth'))).toBe(false);
    // movetime still wins when both are passed (documented precedence).
    w.messages.length = 0;
    engine.analyze('startpos', { movetime: 1000, nodes: 500000 });
    expect(w.messages).toContain('go movetime 1000');
  });
});

describe('Engine.getEngineId', () => {
  it('captures the UCI `id name` line (Rashid cache-key component)', () => {
    const { engine } = engineWithStub();
    expect(engine.getEngineId()).toBe('unknown-engine');
    (engine as unknown as { onLine(l: string): void }).onLine('id name Stockfish 16.1 WASM');
    expect(engine.getEngineId()).toBe('Stockfish 16.1 WASM');
  });
});

describe('Engine.setGated (Phase 8b)', () => {
  it('analyze() becomes a no-op when gated AND still sends `stop` to cancel anything in flight', () => {
    const engine = new Engine();
    const w = workerStub();
    // Inject the stub worker directly — bypasses `init()` so we don't need a
    // real worker. The class only uses the worker via `send()` which calls
    // `worker.postMessage`. We also need to set a non-null worker so analyze
    // doesn't throw the "Engine not initialized" check.
    (engine as unknown as { worker: { postMessage: typeof w.postMessage } }).worker = {
      postMessage: w.postMessage,
    };

    // Sanity: ungated analyze sends the expected UCI commands.
    engine.analyze('startpos', { depth: 12 });
    expect(w.messages).toContain('position fen startpos');
    expect(w.messages.some((m) => m.startsWith('go depth'))).toBe(true);

    // Gate the engine. The very call to setGated should fire a `stop`.
    w.messages.length = 0;
    engine.setGated(true);
    expect(w.messages).toEqual(['stop']);
    expect(engine.isGated()).toBe(true);

    // Now a fresh analyze must NOT issue `go` / `position` — only a defensive
    // `stop`. This is the hard guarantee: gated mode silences the engine.
    w.messages.length = 0;
    engine.analyze('startpos', { depth: 12 });
    expect(w.messages).toEqual(['stop']);
    expect(w.messages.some((m) => m.startsWith('go'))).toBe(false);

    // Ungating reopens analyze.
    engine.setGated(false);
    w.messages.length = 0;
    engine.analyze('startpos', { depth: 12 });
    expect(w.messages.some((m) => m.startsWith('go'))).toBe(true);
  });
});
