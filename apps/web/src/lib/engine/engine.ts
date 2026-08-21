/**
 * Stockfish engine — runs in a dedicated worker, communicates via UCI.
 *
 * Architecture rule: this module knows about Stockfish/UCI ONLY. It does not
 * know how to draw a board, validate moves, or pick which positions to test.
 * Higher layers (`useEngine`, the health-check service) compose those.
 */

export interface EngineLine {
  multipv: number;
  depth: number;
  /** Eval in centipawns from the side-to-move's perspective. */
  cp?: number;
  /** Mate distance (positive: side-to-move mates in N; negative: mated in N). */
  mate?: number;
  /** Principal variation in UCI move format (e.g. ['e2e4','e7e5']). */
  pv: string[];
}

export interface AnalysisProgress {
  fen: string;
  /** Best depth reached so far. */
  depth: number;
  lines: EngineLine[];
  bestmove: string | null;
  done: boolean;
}

export interface AnalyzeOptions {
  /** Cap analysis at this depth. */
  depth?: number;
  /** Or run for this many milliseconds (use one or the other). */
  movetime?: number;
  /** Number of lines to track simultaneously. Defaults to 1. */
  multipv?: number;
  /**
   * Phase 9d: run this ONE analysis even while the engine is gated, without
   * lifting the gate for anyone else.
   *
   * The gate exists so the engine cannot leak a card's answer. Capturing a
   * refutation shadow line needs an eval during a drill — but of the position
   * the user *reached by playing the wrong move*, which is not the card's
   * parent and therefore holds no answer to leak. Toggling `setGated(false)`
   * around such a call would open a real window (the gate is process-wide);
   * this flag keeps the gate closed and exempts a single, named call.
   *
   * Only pass this with a FEN you can show is not an unanswered card's
   * position.
   */
  bypassGate?: boolean;
}

type Listener = (progress: AnalysisProgress) => void;

const DEFAULT_DEPTH = 18;

export class Engine {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private uciOkResolve: (() => void) | null = null;
  private listeners = new Set<Listener>();

  private currentFen: string | null = null;
  private currentMultipv = 1;
  private linesByMultipv = new Map<number, EngineLine>();
  private currentDepth = 0;
  private analysisGen = 0;

  /**
   * Phase 8b engine-gating flag. When true:
   *   - `analyze()` becomes a no-op and any in-flight analysis is `stop`-ed.
   *   - The engine worker is NOT torn down (so re-enabling is cheap).
   *
   * Hard guarantee for drill/daily-diet modes: with `gated=true`, the engine
   * cannot leak the answer mid-card — there is no chatter on the worker, no
   * DOM panel to peek at, and any caller-issued `analyze()` returns early.
   * The flag lives at the module level (not in any panel component) so a
   * future "enable engine for the editor" feature cannot accidentally leak
   * eval into a drill running in another tab/route.
   */
  private gated = false;

  /** Bring up the worker and complete the UCI handshake. */
  init(timeoutMs = 15000): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      this.worker = new Worker('/stockfish/bootstrap.js');
      const diags: string[] = [];

      // Surface diagnostic + error messages from the bootstrap worker.
      this.worker.onerror = (e) => {
        const msg = `worker.onerror: ${e.message || 'unknown'} @ ${e.filename}:${e.lineno}`;
        console.error('[engine]', msg);
        diags.push(msg);
      };

      this.worker.onmessage = (e) => {
        const raw = String(e.data);
        if (raw.startsWith('__bootstrap__:')) {
          const msg = raw.slice('__bootstrap__:'.length);
          console.log('[engine bootstrap]', msg);
          diags.push(msg);
          return;
        }
        this.onLine(raw);
      };
      this.worker.postMessage('__init__');

      // Wait for bootstrap's "__ready__" with a timeout.
      await withTimeout(
        new Promise<void>((resolve) => {
          const handler = (e: MessageEvent) => {
            if (e.data === '__ready__') {
              this.worker!.removeEventListener('message', handler);
              resolve();
            }
          };
          this.worker!.addEventListener('message', handler);
        }),
        timeoutMs,
        () => `Engine bootstrap timed out. Diagnostics:\n${diags.join('\n') || '(none)'}`,
      );

      // UCI handshake.
      const uciOk = new Promise<void>((resolve) => {
        this.uciOkResolve = resolve;
      });
      this.send('uci');
      await withTimeout(uciOk, 5000, () => 'UCI handshake timed out (no uciok)');

      this.send('isready');
      this.send('ucinewgame');
    })();
    // Surface failures so callers can show them instead of staying stuck.
    this.readyPromise.catch(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  /** Subscribe to progress events for the currently running analysis. */
  onProgress(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Start a new analysis. Cancels any in-flight analysis on the same engine.
   * Progress events fire via `onProgress` listeners.
   *
   * Gated mode (see `setGated`): this method becomes a no-op and immediately
   * stops any in-flight analysis. The caller does not need to know the engine
   * is gated; the contract is "analysis silently won't run while gated."
   */
  analyze(fen: string, opts: AnalyzeOptions = {}): void {
    if (!this.worker) throw new Error('Engine not initialized');
    if (this.gated && opts.bypassGate !== true) {
      this.send('stop');
      return;
    }
    const multipv = Math.max(1, opts.multipv ?? 1);
    this.analysisGen += 1;
    this.currentFen = fen;
    this.currentMultipv = multipv;
    this.currentDepth = 0;
    this.linesByMultipv.clear();

    // Cancel anything currently running, then issue the new analysis.
    this.send('stop');
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    if (opts.movetime != null) {
      this.send(`go movetime ${opts.movetime}`);
    } else {
      this.send(`go depth ${opts.depth ?? DEFAULT_DEPTH}`);
    }
  }

  /** Stop the current analysis (engine will emit `bestmove` with current best). */
  stop(): void {
    this.send('stop');
  }

  /**
   * Phase 8b: hard-gate analysis. While gated, `analyze()` is a no-op and any
   * in-flight analysis is immediately cancelled. Drill / daily-diet modes flip
   * this on while a card is unanswered so the engine cannot leak the answer.
   *
   * Returns the new state so callers can assert in tests.
   */
  setGated(gated: boolean): boolean {
    this.gated = gated;
    if (gated) this.send('stop');
    return this.gated;
  }

  isGated(): boolean {
    return this.gated;
  }

  /** Run an analysis to completion and resolve with the final progress. */
  analyzeOnce(fen: string, opts: AnalyzeOptions = {}): Promise<AnalysisProgress> {
    return new Promise<AnalysisProgress>((resolve) => {
      const unsub = this.onProgress((p) => {
        if (p.done && p.fen === fen) {
          unsub();
          resolve(p);
        }
      });
      this.analyze(fen, opts);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
  }

  private send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  private emit(done: boolean, bestmove: string | null): void {
    if (!this.currentFen) return;
    const lines = [...this.linesByMultipv.values()].sort((a, b) => a.multipv - b.multipv);
    const progress: AnalysisProgress = {
      fen: this.currentFen,
      depth: this.currentDepth,
      lines,
      bestmove,
      done,
    };
    for (const l of this.listeners) l(progress);
  }

  private onLine(line: string): void {
    // UCI handshake replies.
    if (line === 'uciok') {
      this.uciOkResolve?.();
      this.uciOkResolve = null;
      return;
    }
    if (line === 'readyok') return;

    if (line.startsWith('info ')) {
      const parsed = parseInfo(line);
      if (parsed) {
        this.linesByMultipv.set(parsed.multipv, parsed);
        if (parsed.depth > this.currentDepth) this.currentDepth = parsed.depth;
        this.emit(false, null);
      }
      return;
    }

    if (line.startsWith('bestmove ')) {
      const tokens = line.split(/\s+/);
      const bestmove = tokens[1] ?? null;
      this.emit(true, bestmove);
      return;
    }
  }
}

/** Parse a Stockfish `info ...` line into an EngineLine (or null if unrelated). */
export function parseInfo(line: string): EngineLine | null {
  // Examples:
  //   info depth 18 seldepth 24 multipv 1 score cp 32 nodes 12345 nps ... pv e2e4 e7e5 ...
  //   info depth 12 multipv 2 score mate 5 pv ...
  //   info depth 1 score cp 32 pv e2e4   (no multipv → treat as 1)
  if (!line.startsWith('info ')) return null;
  if (!line.includes(' pv ')) return null; // currmove/string-only lines: ignore

  const tokens = line.split(/\s+/);
  let multipv = 1;
  let depth = 0;
  let cp: number | undefined;
  let mate: number | undefined;
  let pv: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth') depth = Number(tokens[++i]);
    else if (t === 'multipv') multipv = Number(tokens[++i]);
    else if (t === 'score') {
      const kind = tokens[++i];
      const val = Number(tokens[++i]);
      if (kind === 'cp') cp = val;
      else if (kind === 'mate') mate = val;
    } else if (t === 'pv') {
      pv = tokens.slice(i + 1);
      break;
    }
  }

  if (!Number.isFinite(depth) || (cp == null && mate == null)) return null;
  return { multipv, depth, cp, mate, pv };
}

/* ---------------- singleton ---------------- */

let singleton: Engine | null = null;

/** App-wide engine instance. Initialized lazily on first access. */
export function getEngine(): Engine {
  if (!singleton) singleton = new Engine();
  return singleton;
}

/* ---------------- helpers ---------------- */

function withTimeout<T>(p: Promise<T>, ms: number, makeMsg: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(makeMsg())), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
