/**
 * Rashid domain core (plan Phase R1). Everything runs against a scripted fake
 * engine keyed by fenKey — no wasm, fully deterministic. The fake records a
 * call log, because *how little* Rashid calls the engine is a tested
 * guarantee (plan §C1): the walk is only affordable if it stays lazy.
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { fenKey } from './fen.js';
import {
  DEFAULT_RASHID_CONFIG,
  MATE_BASE,
  detectOnlyMove,
  formatRashidScore,
  heroScoreOf,
  isMateScore,
  rashidAnalyze,
  rashidConfigKey,
  wp,
  type AnalyzedMove,
  type RashidAnalyzeFn,
  type RashidConfig,
} from './rashid.js';

/* ---------------- fixtures ---------------- */

/** Scripted engine: fenKey → canned MultiPV output (side-to-move POV). */
function fakeEngine(script: Record<string, AnalyzedMove[]>) {
  const calls: { fen: string; multipv: number }[] = [];
  const analyze: RashidAnalyzeFn = async (fen, multipv) => {
    const key = fenKey(fen) as string;
    calls.push({ fen: key, multipv });
    const entry = script[key];
    if (!entry) throw new Error(`fake engine: unscripted position ${key}`);
    return entry.slice(0, multipv);
  };
  return { analyze, calls };
}

/** FEN (key) after playing `sans` from `startFen` — fixtures built with
 * chess.js itself so the tests never hand-write a FEN they could get wrong. */
function keyAfter(startFen: string, sans: string[]): string {
  const c = new Chess(startFen);
  for (const san of sans) c.move(san);
  return fenKey(c.fen()) as string;
}

const START = new Chess().fen();

function cfg(overrides: Partial<RashidConfig>): RashidConfig {
  return { ...DEFAULT_RASHID_CONFIG, ...overrides };
}

/* ---------------- scores & win-probability ---------------- */

describe('wp / sentinels / formatting', () => {
  it('wp is 0.5 at equality, monotonic, and 400-scaled', () => {
    expect(wp(0)).toBeCloseTo(0.5, 10);
    expect(wp(400)).toBeCloseTo(1 / (1 + 0.1), 10);
    expect(wp(100)).toBeGreaterThan(wp(50));
    expect(wp(-100)).toBeLessThan(wp(-50));
  });

  it('mate sentinels clamp to 0/1 so gaps vanish in won positions', () => {
    expect(wp(MATE_BASE - 3)).toBe(1);
    expect(wp(-(MATE_BASE - 3))).toBe(0);
    expect(isMateScore(MATE_BASE - 3)).toBe(true);
    expect(isMateScore(500)).toBe(false);
  });

  it('heroScoreOf negates side-to-move evals at opponent nodes', () => {
    expect(heroScoreOf({ uci: 'e2e4', cp: 50 }, true)).toBe(50);
    expect(heroScoreOf({ uci: 'e2e4', cp: 50 }, false)).toBe(-50);
    // Opponent-to-move mated in 3 = hero mates in 3.
    expect(heroScoreOf({ uci: 'a7a8', mate: -3 }, false)).toBe(MATE_BASE - 3);
    expect(heroScoreOf({ uci: 'a7a8', mate: 3 }, true)).toBe(MATE_BASE - 3);
    expect(() => heroScoreOf({ uci: 'a7a8' }, true)).toThrow();
  });

  it('formats cp as signed pawns and sentinels as M-notation', () => {
    expect(formatRashidScore(30)).toBe('+0.3');
    expect(formatRashidScore(-40)).toBe('-0.4');
    expect(formatRashidScore(0)).toBe('0.0');
    expect(formatRashidScore(MATE_BASE - 3)).toBe('M3');
    expect(formatRashidScore(-(MATE_BASE - 5))).toBe('-M5');
  });

  it('config key is stable under key order and sensitive to values', () => {
    const reordered = Object.fromEntries(
      Object.entries(DEFAULT_RASHID_CONFIG).reverse(),
    ) as unknown as RashidConfig;
    expect(rashidConfigKey(reordered)).toBe(rashidConfigKey(DEFAULT_RASHID_CONFIG));
    expect(rashidConfigKey(cfg({ narrowThreshold: 0.2 }))).not.toBe(
      rashidConfigKey(DEFAULT_RASHID_CONFIG),
    );
  });
});

/* ---------------- only-move detection (spec §3) ---------------- */

describe('detectOnlyMove', () => {
  it('flags a wide gap as an only-move and reports the miss punishment', () => {
    // Black to move (opponent). Best keeps hero at -30; second concedes +300.
    const r = detectOnlyMove([
      { uci: 'e7e5', cp: 30 },
      { uci: 'b8c6', cp: -300 },
    ]);
    expect(r.isOnlyMove).toBe(true);
    expect(r.bestUci).toBe('e7e5');
    expect(r.bestScore).toBe(-30);
    expect(r.missScore).toBe(300);
  });

  it('does not flag when the second-best is nearly as good', () => {
    const r = detectOnlyMove([
      { uci: 'b8c6', cp: -20 },
      { uci: 'g8f6', cp: -25 },
    ]);
    expect(r.isOnlyMove).toBe(false);
    expect(r.missScore).toBeNull();
    expect(r.gap).toBeLessThan(DEFAULT_RASHID_CONFIG.narrowThreshold);
  });

  it('sorts by opponent preference even if the input ordering is scrambled', () => {
    // Same moves, deliberately worst-for-opponent first.
    const r = detectOnlyMove([
      { uci: 'b8c6', cp: -300 },
      { uci: 'e7e5', cp: 30 },
    ]);
    expect(r.bestUci).toBe('e7e5');
    expect(r.isOnlyMove).toBe(true);
  });

  it('a mate-threat alternative clamps the gap through the sentinel scheme', () => {
    // Second-best walks into mate: gap = 1 − wp(best) regardless of distance.
    const r = detectOnlyMove([
      { uci: 'a7a8', cp: 0 },
      { uci: 'a7b7', mate: -3 },
    ]);
    expect(r.isOnlyMove).toBe(true);
    expect(r.missScore).toBe(MATE_BASE - 3);
  });

  it('fails toward silence on a single analyzed move, and throws on none', () => {
    const r = detectOnlyMove([{ uci: 'e7e5', cp: 0 }]);
    expect(r.isOnlyMove).toBe(false);
    expect(r.gap).toBe(0);
    expect(() => detectOnlyMove([])).toThrow();
  });
});

/* ---------------- the walk (spec §4) ---------------- */

describe('rashidAnalyze', () => {
  it('finds a length-1 tightrope, skips prefiltered roots, and stays lazy', async () => {
    const F1 = keyAfter(START, ['e4']);
    const F2 = keyAfter(START, ['e4', 'e5']);
    const F3 = keyAfter(START, ['e4', 'e5', 'Nf3']);
    const F1d = keyAfter(START, ['d4']);
    const F1a = keyAfter(START, ['a3']);

    const { analyze, calls } = fakeEngine({
      [fenKey(START) as string]: [
        { uci: 'e2e4', cp: 30 },
        { uci: 'd2d4', cp: 20 },
        { uci: 'a2a3', cp: -400 }, // concedes far past the cap at the root
      ],
      [F1]: [
        { uci: 'e7e5', cp: 30 }, // hero −30 if found…
        { uci: 'b8c6', cp: -300 }, // …hero +300 if missed → only-move
      ],
      [F2]: [{ uci: 'g1f3', cp: 25 }],
      [F3]: [
        { uci: 'b8c6', cp: -20 },
        { uci: 'g8f6', cp: -25 }, // near-equal choices → tightrope ends
      ],
      [F1d]: [
        { uci: 'd7d5', cp: -10 },
        { uci: 'g8f6', cp: -15 }, // open immediately → length 0
      ],
      // F1a deliberately unscripted: analyzing it means the prefilter failed.
    });

    const r = await rashidAnalyze(START, 'w', analyze, cfg({ minLengthToDisplay: 1 }));

    expect(r.lightsUp).toBe(true);
    expect(r.bestRootScore).toBe(30);
    expect(r.best?.rootUci).toBe('e2e4');
    expect(r.best?.line).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(r.best?.length).toBe(1);
    expect(r.best?.pinchPoints).toEqual([{ ply: 2, moveUci: 'e7e5', missScore: 300 }]);
    expect(r.best?.rewardFloor).toBe(300);
    expect(r.best?.rewardMax).toBe(300);
    expect(r.best?.riskScore).toBe(20);
    expect(r.lines).toHaveLength(1); // the d4 line forces nothing

    // Laziness gate (plan R1 exit): exactly these five calls, nothing past a
    // failed check, and the prefiltered a3 subtree never touched.
    expect(calls.map((c) => c.fen)).toEqual([fenKey(START) as string, F1, F2, F3, F1d]);
    expect(calls.map((c) => c.multipv)).toEqual([
      DEFAULT_RASHID_CONFIG.multipvRoot,
      DEFAULT_RASHID_CONFIG.multipvOpp,
      1,
      DEFAULT_RASHID_CONFIG.multipvOpp,
      DEFAULT_RASHID_CONFIG.multipvOpp,
    ]);
    expect(calls.some((c) => c.fen === F1a)).toBe(false);
  });

  it('treats a forced reply as line glue, not a pinch point, with no engine call', async () => {
    // White: Re1, Kg1. Black: Kh8, Nh6, g7/h7 pawns. After Re8+ the ONLY
    // legal reply is Ng8 (king moves and blocks are all impossible).
    const R0 = '7k/6pp/7n/8/8/8/8/4R1K1 w - - 0 1';
    const F1forced = keyAfter(R0, ['Re8+']);
    const F2 = keyAfter(R0, ['Re8+', 'Ng8']);
    const F1quiet = keyAfter(R0, ['Re5']);

    const { analyze, calls } = fakeEngine({
      [fenKey(R0) as string]: [
        { uci: 'e1e8', cp: 200 },
        { uci: 'e1e5', cp: 150 },
      ],
      // F1forced deliberately unscripted: a call there means the walk paid an
      // engine search to discover a move chess.js already knew was forced.
      [F2]: [{ uci: 'e8e2', cp: 180 }],
      [F1quiet]: [
        { uci: 'h8g8', cp: -140 },
        { uci: 'h6f5', cp: -150 },
      ],
    });

    const r = await rashidAnalyze(R0, 'w', analyze, cfg({ maxPly: 2, minLengthToDisplay: 1 }));

    // The forced sequence produced no pinch points → nothing lights up.
    expect(r.lightsUp).toBe(false);
    expect(r.lines).toHaveLength(0);
    expect(calls.some((c) => c.fen === F1forced)).toBe(false);
    // maxPly hit at the hero node after Ng8 → one MultiPV-1 eval closes it.
    expect(calls.find((c) => c.fen === F2)?.multipv).toBe(1);
  });

  it('terminates a cycling tightrope via fenKey repetition and orders mate rewards', async () => {
    // Rook shuffle: Ra2/Ra7, Ra1/Ra8 walks straight back into the root.
    const R0 = 'r6k/8/8/8/8/8/8/R5K1 w - - 0 1';
    const F1 = keyAfter(R0, ['Ra2']);
    const F2 = keyAfter(R0, ['Ra2', 'Ra7']);
    const F3 = keyAfter(R0, ['Ra2', 'Ra7', 'Ra1']);
    const F1k = keyAfter(R0, ['Kf1']);

    const { analyze, calls } = fakeEngine({
      [fenKey(R0) as string]: [
        { uci: 'a1a2', cp: 0 },
        { uci: 'g1f1', cp: -10 },
      ],
      [F1]: [
        { uci: 'a8a7', cp: 0 },
        { uci: 'a8b8', cp: -250 },
      ],
      [F2]: [{ uci: 'a2a1', cp: 0 }],
      [F3]: [
        { uci: 'a7a8', cp: 0 },
        { uci: 'a7b7', mate: -3 }, // missing the second only-move loses to mate
      ],
      [F1k]: [
        { uci: 'a8a7', cp: 5 },
        { uci: 'a8b8', cp: 0 },
      ],
    });

    const r = await rashidAnalyze(R0, 'w', analyze); // default minLength 2

    expect(r.lightsUp).toBe(true);
    expect(r.best?.line).toEqual(['a1a2', 'a8a7', 'a2a1', 'a7a8']);
    expect(r.best?.length).toBe(2);
    expect(r.best?.pinchPoints.map((p) => p.ply)).toEqual([2, 4]);
    // Repetition → the line is heading to a draw, and Risk says so.
    expect(r.best?.riskScore).toBe(0);
    expect(r.best?.sacrifice).toBe(0);
    // Floor is the cheapest slip; the jackpot is the mate, ordered correctly
    // through the sentinel scheme and formatted as M-notation.
    expect(r.best?.rewardFloor).toBe(250);
    expect(r.best?.rewardMax).toBe(MATE_BASE - 3);
    expect(formatRashidScore(r.best!.rewardMax!)).toBe('M3');
    // No sixth call: the repetition check ended the walk without an eval.
    expect(calls).toHaveLength(5);
  });

  it('rejects a tightrope whose perfect-defense outcome busts the sacrifice cap', async () => {
    const F1 = keyAfter(START, ['e4']);
    const F1d = keyAfter(START, ['d4']);
    const F2d = keyAfter(START, ['d4', 'd5']);
    const F3d = keyAfter(START, ['d4', 'd5', 'c4']);

    const { analyze } = fakeEngine({
      [fenKey(START) as string]: [
        { uci: 'e2e4', cp: 100 },
        { uci: 'd2d4', cp: 60 }, // passes the *root* prefilter…
      ],
      [F1]: [
        { uci: 'e7e5', cp: -20 },
        { uci: 'c7c5', cp: -25 },
      ],
      [F1d]: [
        { uci: 'd7d5', cp: 300 }, // hero −300 if found → a real gambit
        { uci: 'g8f6', cp: -80 },
      ],
      [F2d]: [{ uci: 'c2c4', cp: -280 }],
      [F3d]: [
        { uci: 'e7e6', cp: 300 },
        { uci: 'd5c4', cp: 290 },
      ],
    });

    const r = await rashidAnalyze(START, 'w', analyze, cfg({ minLengthToDisplay: 1 }));

    // The d4 line has a pinch point but concedes ~0.49 wp against perfect
    // defense — far past the cap. It must not survive as a "trap".
    expect(r.lightsUp).toBe(false);
    expect(r.lines).toHaveLength(0);
  });

  it('throws on caller bugs instead of returning a silent no-result', async () => {
    const { analyze } = fakeEngine({});
    await expect(rashidAnalyze(START, 'b', analyze)).rejects.toThrow(/hero to move/);
    const mated = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    await expect(rashidAnalyze(mated, 'w', analyze)).rejects.toThrow(/terminal/);
  });
});
