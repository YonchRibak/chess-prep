/**
 * Rashid — trap-finding analysis core (spec: rashid-engine-spec.md, plan:
 * rashid-dev-plan.md, both at the repo root).
 *
 * Rashid reframes engine output: instead of "best move assuming perfect play"
 * it looks for a hero move that forces the opponent onto a tightrope of
 * consecutive "only moves", and reports Risk / Reward / Length for the best
 * such line.
 *
 * This module is the pure domain half (plan Phase R1). It knows nothing about
 * Stockfish, UCI, workers, caching, or the UI — the engine is injected as a
 * single async function (`RashidAnalyzeFn`), which is what makes every branch
 * of the walk testable against a scripted fake. The web adapter (Phase R2)
 * owns the real engine, budgets, and cache layers.
 *
 * Two invariants this file enforces that the spec only implies:
 *
 * - **Laziness.** The walk never issues an engine call past a failed
 *   only-move check, and never calls the engine at all for a node with a
 *   single legal reply (a forced move needs no engine to detect). The engine
 *   calls are the entire cost of Rashid — see plan §C1 — so this is
 *   load-bearing, and rashid.test.ts asserts it via the fake's call log.
 * - **Forced moves are not pinch points.** A reply the opponent cannot avoid
 *   (one legal move) extends the line but adds no Length and no reward entry;
 *   counting it would inflate every check sequence into a fake tightrope
 *   (plan §C4).
 */

import { Chess, type Move } from 'chess.js';
import { fenKey } from './fen.js';

/* ---------------- engine abstraction ---------------- */

/**
 * One analyzed candidate move, evals from the **side-to-move's** perspective
 * (raw UCI convention — perspective normalization happens here, not in the
 * adapter). Exactly one of `cp` / `mate` must be present.
 */
export interface AnalyzedMove {
  /** UCI move, e.g. "e2e4", "e7e8q". */
  uci: string;
  /** Centipawns, side-to-move POV. */
  cp?: number;
  /** Mate in N moves: positive = side-to-move mates, negative = gets mated. */
  mate?: number;
}

/**
 * The single capability Rashid needs from an engine: MultiPV analysis of a
 * position at some fixed budget. The budget (depth/nodes) is the adapter's
 * closure — keeping it out of this signature keeps the domain logic
 * budget-agnostic, which is what lets precompute and live probes share it.
 *
 * Must return the top-`multipv` legal moves sorted best-first for the side to
 * move, evals side-to-move POV.
 */
export type RashidAnalyzeFn = (fen: string, multipv: number) => Promise<AnalyzedMove[]>;

/* ---------------- config ---------------- */

export interface RashidConfig {
  /** MultiPV width at the root. Wider than interior nodes because speculative
   * trap moves often rank below the engine's top few (plan §C3). */
  multipvRoot: number;
  /** MultiPV width at opponent nodes. The only-move test needs best + second
   * plus a noise margin; 4 is enough (plan §C1.3). */
  multipvOpp: number;
  /** Win-prob gap best→second below which the opponent "has a choice". */
  narrowThreshold: number;
  /** Max win-prob hero may concede vs perfect defense to offer the trap. */
  heroSacrificeCap: number;
  /** Max half-moves explored per line (root hero move counts as 1). */
  maxPly: number;
  /** Min pinch points for a line to light the board up. */
  minLengthToDisplay: number;
  /** Elo-logistic scaling constant for cp → win-prob. */
  wpScale: number;
  /** Root prefilter slack: a candidate whose *root* eval already concedes
   * more than cap+margin can never pass the post-walk cap check (its root
   * eval ≈ its perfect-defense outcome), so its walk is skipped entirely.
   * The margin absorbs eval drift between the root search and the line's
   * end. */
  rootPrefilterMargin: number;
}

export const DEFAULT_RASHID_CONFIG: RashidConfig = {
  multipvRoot: 8,
  multipvOpp: 4,
  narrowThreshold: 0.15,
  heroSacrificeCap: 0.1,
  maxPly: 8,
  minLengthToDisplay: 2,
  wpScale: 400,
  rootPrefilterMargin: 0.03,
};

/**
 * Canonical key for a config — part of the derived-result cache key (plan
 * §C7 layer B), so two configs that differ in any constant never share cached
 * `RashidResult`s. Key order is fixed by sorting, not object literal order.
 */
export function rashidConfigKey(cfg: RashidConfig): string {
  const entries = Object.entries(cfg).sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(Object.fromEntries(entries));
}

/* ---------------- scores, sentinels, win-probability ---------------- */

/**
 * Mate sentinel base (spec §1): hero mates in N → +(MATE_BASE − N), hero gets
 * mated in N → −(MATE_BASE − N). Keeps "mate in 3" > "mate in 5" > any cp
 * eval. A terminal checkmate on the board scores ±MATE_BASE (distance 0).
 */
export const MATE_BASE = 100000;

/** Scores at or beyond this magnitude are mate sentinels, not centipawns. */
export const MATE_SENTINEL_MIN = MATE_BASE - 1000;

/** True if a hero-perspective score is a mate sentinel (either side). */
export function isMateScore(score: number): boolean {
  return Math.abs(score) >= MATE_SENTINEL_MIN;
}

function stmScore(m: AnalyzedMove): number {
  if (m.mate != null) {
    return m.mate > 0 ? MATE_BASE - m.mate : -(MATE_BASE + m.mate);
  }
  if (m.cp == null) {
    throw new Error(`AnalyzedMove ${m.uci} has neither cp nor mate`);
  }
  return m.cp;
}

/**
 * Sentinel-encoded score from the hero's perspective. `stmIsHero` tells us
 * whether the side to move in the analyzed position is the hero — engine
 * evals are side-to-move POV, so at opponent nodes everything negates.
 */
export function heroScoreOf(m: AnalyzedMove, stmIsHero: boolean): number {
  const s = stmScore(m);
  return stmIsHero ? s : -s;
}

/**
 * cp → expected score in [0,1] via the Elo logistic (spec §2). All gap and
 * threshold decisions happen in this space so thresholds behave the same in
 * quiet and sharp positions. Mate sentinels clamp to 0/1 — which is also why
 * already-won positions stop lighting up: every gap up there is ~0.
 */
export function wp(score: number, wpScale: number = DEFAULT_RASHID_CONFIG.wpScale): number {
  if (score >= MATE_SENTINEL_MIN) return 1;
  if (score <= -MATE_SENTINEL_MIN) return 0;
  return 1 / (1 + Math.pow(10, -score / wpScale));
}

/**
 * Display form of a hero-perspective score: pawns with sign ("+1.5", "-0.4",
 * "0.0") or mate ("M3" / "-M3").
 */
export function formatRashidScore(score: number): string {
  if (score >= MATE_SENTINEL_MIN) return `M${MATE_BASE - score}`;
  if (score <= -MATE_SENTINEL_MIN) return `-M${MATE_BASE + score}`;
  const pawns = (score / 100).toFixed(1);
  return score > 0 ? `+${pawns}` : pawns; // (-x).toFixed already carries the sign
}

/* ---------------- only-move detection (spec §3) ---------------- */

export interface OnlyMoveAssessment {
  /** True iff missing the best reply swings hero's expected score by
   * ≥ narrowThreshold. */
  isOnlyMove: boolean;
  /** The opponent's best reply (their tightrope step), UCI. */
  bestUci: string;
  /** Hero-perspective score if the opponent finds the best reply. */
  bestScore: number;
  /** wp(second) − wp(best); ≥ 0 by construction, 0 when fewer than 2 moves. */
  gap: number;
  /** Hero-perspective score of the second-best reply — the punishment floor
   * at this pinch point — or null when not an only-move. Any deviation from
   * best yields hero at least this much, because second-best is the
   * opponent's least bad alternative. */
  missScore: number | null;
}

/**
 * The atomic operation: given MultiPV output for an **opponent-to-move**
 * position (side-to-move POV, best-first for the opponent), decide whether
 * the opponent is on a tightrope step.
 *
 * Note the sort direction trap the spec warns about: the opponent's best move
 * is the one with the *lowest* hero score. We re-sort defensively rather than
 * trusting the engine's ordering survived perspective flips.
 */
export function detectOnlyMove(
  opponentMoves: AnalyzedMove[],
  cfg: RashidConfig = DEFAULT_RASHID_CONFIG,
): OnlyMoveAssessment {
  if (opponentMoves.length === 0) {
    throw new Error('detectOnlyMove called with no moves (terminal positions are the walk’s job)');
  }
  const scored = opponentMoves
    .map((m) => ({ uci: m.uci, score: heroScoreOf(m, false) }))
    .sort((a, b) => a.score - b.score); // ascending hero score = opponent's preference

  const [best, second] = scored;
  if (best == null) throw new Error('unreachable: length checked above');
  if (second == null) {
    // A single analyzed move with >1 legal is an adapter/data bug upstream;
    // treat as "opponent has a choice" so we fail toward silence, not toward
    // a fake tightrope.
    return { isOnlyMove: false, bestUci: best.uci, bestScore: best.score, gap: 0, missScore: null };
  }
  const gap = wp(second.score, cfg.wpScale) - wp(best.score, cfg.wpScale);
  const isOnlyMove = gap >= cfg.narrowThreshold;
  return {
    isOnlyMove,
    bestUci: best.uci,
    bestScore: best.score,
    gap,
    missScore: isOnlyMove ? second.score : null,
  };
}

/* ---------------- the walk (spec §4) ---------------- */

export interface PinchPoint {
  /** 1-based half-move index within `line` of the forced opponent reply. */
  ply: number;
  /** The only-move itself, UCI. */
  moveUci: string;
  /** Hero-perspective punishment if the opponent misses (spec §3). */
  missScore: number;
}

export interface RashidLine {
  /** The hero move that enters the tightrope. */
  rootUci: string;
  /** Full forced sequence from the root, UCI, hero move first. */
  line: string[];
  pinchPoints: PinchPoint[];
  /** Number of pinch points — forced (single-legal) replies excluded. */
  length: number;
  /** Hero-perspective score at the end of the line under perfect defense. */
  riskScore: number;
  /** min/max over pinch-point missScores; null when length = 0. */
  rewardFloor: number | null;
  rewardMax: number | null;
  /** wp(best root move) − wp(riskScore): what entering the trap concedes
   * against perfect defense. Must stay ≤ heroSacrificeCap to qualify. */
  sacrifice: number;
}

/** Why a walk stopped where it did. */
export type WalkEndReason =
  | 'open' // the opponent gained a real choice (gap < narrowThreshold)
  | 'terminal' // checkmate / stalemate / draw rule on the board
  | 'repetition' // position repeated inside the line (perpetual-shaped)
  | 'budget'; // maxPly reached

/**
 * Per-root-candidate verdict — the "why not" trace. Rashid rejecting a move
 * silently is indistinguishable from Rashid not seeing it; tuning (plan R6)
 * and any human trying to understand a non-detection need the reason.
 */
export type RashidCandidateDiag =
  // Skipped before walking: the root eval already concedes more than
  // cap + margin versus the best move.
  | { uci: string; verdict: 'prefiltered'; rootConcession: number }
  // Walked, but no pinch point found before the line ended.
  | {
      uci: string;
      verdict: 'no-tightrope';
      endReason: WalkEndReason;
      endGap: number | null;
      plies: number;
    }
  // Found a tightrope, but perfect defense costs more than the cap.
  | { uci: string; verdict: 'cap-busted'; length: number; sacrifice: number }
  | { uci: string; verdict: 'qualified'; length: number };

export interface RashidResult {
  /** True iff `best` exists — a qualifying line with length ≥
   * minLengthToDisplay. */
  lightsUp: boolean;
  best: RashidLine | null;
  /** All cap-passing lines with length ≥ 1, ranked (spec §4: length, then
   * reward floor, then risk). Kept so the UI can show secondary arrows. */
  lines: RashidLine[];
  /** Hero-perspective score of the engine's best root move (the perfect-play
   * baseline the sacrifice is measured against). */
  bestRootScore: number;
  /** One entry per analyzed root candidate, in root ranking order. */
  candidates: RashidCandidateDiag[];
}

interface ScoredMove {
  uci: string;
  score: number;
}

function applyUci(chess: Chess, uci: string): void {
  // Throws on an illegal move — that means a corrupt script or adapter bug,
  // and silence would let a bogus line through.
  chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4) : undefined,
  });
}

function verboseToUci(m: Move): string {
  return m.from + m.to + (m.promotion ?? '');
}

/** First element, or a loud failure — an engine that returns no moves for a
 * non-terminal position is an adapter bug, never a "no trap here". */
function topOf<T>(arr: T[], where: string): T {
  const t = arr[0];
  if (t == null) throw new Error(`engine returned no moves (${where})`);
  return t;
}

/** Terminal score at a game-over node: mate distance 0 (±MATE_BASE), draws 0. */
function terminalScore(chess: Chess, heroColor: 'w' | 'b'): number {
  if (chess.isCheckmate()) {
    return chess.turn() === heroColor ? -MATE_BASE : MATE_BASE;
  }
  return 0; // stalemate / insufficient material / draw rules
}

/**
 * Walk one root candidate: alternate opponent / hero nodes down the forced
 * line until the tightrope ends (opponent gains a real choice), the game
 * ends, a position repeats, or maxPly is hit. Returns the line — length 0 is
 * a valid outcome meaning "this move forces nothing".
 */
interface WalkOutcome {
  line: string[];
  pinchPoints: PinchPoint[];
  riskScore: number;
  endReason: WalkEndReason;
  /** The gap at the open node that ended the walk; null for other reasons. */
  endGap: number | null;
}

async function walkLine(
  rootFen: string,
  rootUci: string,
  heroColor: 'w' | 'b',
  analyze: RashidAnalyzeFn,
  cfg: RashidConfig,
): Promise<WalkOutcome> {
  const chess = new Chess(rootFen);
  applyUci(chess, rootUci);
  const line: string[] = [rootUci];
  const pinchPoints: PinchPoint[] = [];
  // Repetition guard: a "tightrope" that cycles (e.g. perpetual check) must
  // terminate — we key on fenKey so clock-only differences still match.
  const seen = new Set<string>([fenKey(rootFen) as string]);

  for (;;) {
    const heroToMove = chess.turn() === heroColor;
    const fen = chess.fen();

    if (chess.isGameOver()) {
      return {
        line,
        pinchPoints,
        riskScore: terminalScore(chess, heroColor),
        endReason: 'terminal',
        endGap: null,
      };
    }
    const key = fenKey(fen) as string;
    if (seen.has(key)) {
      // Repetition inside the forced line — treat as the draw it is heading
      // toward. wp(0) = 0.5, which the sacrifice cap then judges honestly.
      return { line, pinchPoints, riskScore: 0, endReason: 'repetition', endGap: null };
    }
    seen.add(key);

    if (line.length >= cfg.maxPly) {
      // Budget cap: one MultiPV-1 call for the final eval, hero POV.
      const a = await analyze(fen, 1);
      return {
        line,
        pinchPoints,
        riskScore: heroScoreOf(topOf(a, 'maxPly eval'), heroToMove),
        endReason: 'budget',
        endGap: null,
      };
    }

    const legal = chess.moves({ verbose: true });
    const only = legal.length === 1 ? legal[0] : undefined;
    if (only != null) {
      // Forced for either side: no engine call, no pinch point (plan §C4) —
      // nobody can go wrong where there is no choice.
      applyUci(chess, verboseToUci(only));
      line.push(verboseToUci(only));
      continue;
    }

    if (heroToMove) {
      // Interior hero node: play the engine's best — the asymmetry only
      // exists at the root decision to *enter* the trap (spec §4).
      const a = await analyze(fen, 1);
      const bestUci = topOf(
        a
          .map((m) => ({ uci: m.uci, score: heroScoreOf(m, true) }))
          .sort((x, y) => y.score - x.score),
        'interior hero node',
      ).uci;
      applyUci(chess, bestUci);
      line.push(bestUci);
      continue;
    }

    // Opponent node: the only-move test.
    const assess = detectOnlyMove(await analyze(fen, cfg.multipvOpp), cfg);
    if (!assess.isOnlyMove) {
      // Tightrope ends: the opponent has a real choice here, and their best
      // reply's eval is the perfect-defense outcome of the whole line.
      return {
        line,
        pinchPoints,
        riskScore: assess.bestScore,
        endReason: 'open',
        endGap: assess.gap,
      };
    }
    pinchPoints.push({
      ply: line.length + 1,
      moveUci: assess.bestUci,
      // isOnlyMove guarantees missScore is set.
      missScore: assess.missScore as number,
    });
    applyUci(chess, assess.bestUci);
    line.push(assess.bestUci);
  }
}

/** Spec §4 ranking: length, then reward floor, then risk — all descending. */
function compareLines(a: RashidLine, b: RashidLine): number {
  if (a.length !== b.length) return b.length - a.length;
  const floorA = a.rewardFloor ?? -Infinity;
  const floorB = b.rewardFloor ?? -Infinity;
  if (floorA !== floorB) return floorB - floorA;
  return b.riskScore - a.riskScore;
}

/**
 * Full Rashid analysis of one **hero-to-move** position (spec §4–6).
 *
 * Throws on a terminal root or a root where it is not the hero's turn — both
 * are caller bugs, and returning a silent "nothing here" would mask them.
 */
export async function rashidAnalyze(
  rootFen: string,
  heroColor: 'w' | 'b',
  analyze: RashidAnalyzeFn,
  cfg: RashidConfig = DEFAULT_RASHID_CONFIG,
): Promise<RashidResult> {
  const chess = new Chess(rootFen);
  if (chess.turn() !== heroColor) {
    throw new Error('rashidAnalyze: root must be hero to move');
  }
  if (chess.isGameOver()) {
    throw new Error('rashidAnalyze: root is a terminal position');
  }

  const rootMoves: ScoredMove[] = (await analyze(rootFen, cfg.multipvRoot))
    .map((m) => ({ uci: m.uci, score: heroScoreOf(m, true) }))
    .sort((a, b) => b.score - a.score);
  const bestRootScore = topOf(rootMoves, 'root').score;
  const bestRootWp = wp(bestRootScore, cfg.wpScale);

  const lines: RashidLine[] = [];
  const candidates: RashidCandidateDiag[] = [];
  for (const candidate of rootMoves) {
    // Root prefilter (plan §C1.2): if the move already concedes more than the
    // cap at the root, no tightrope can redeem it — skip the whole walk.
    const concession = bestRootWp - wp(candidate.score, cfg.wpScale);
    if (concession > cfg.heroSacrificeCap + cfg.rootPrefilterMargin) {
      candidates.push({ uci: candidate.uci, verdict: 'prefiltered', rootConcession: concession });
      continue;
    }

    const walked = await walkLine(rootFen, candidate.uci, heroColor, analyze, cfg);
    const length = walked.pinchPoints.length;
    if (length === 0) {
      // Forces nothing — not a Rashid line.
      candidates.push({
        uci: candidate.uci,
        verdict: 'no-tightrope',
        endReason: walked.endReason,
        endGap: walked.endGap,
        plies: walked.line.length,
      });
      continue;
    }

    const sacrifice = bestRootWp - wp(walked.riskScore, cfg.wpScale);
    if (sacrifice > cfg.heroSacrificeCap) {
      // Too dubious even for a trap.
      candidates.push({ uci: candidate.uci, verdict: 'cap-busted', length, sacrifice });
      continue;
    }

    candidates.push({ uci: candidate.uci, verdict: 'qualified', length });
    const missScores = walked.pinchPoints.map((p) => p.missScore);
    lines.push({
      rootUci: candidate.uci,
      line: walked.line,
      pinchPoints: walked.pinchPoints,
      length,
      riskScore: walked.riskScore,
      rewardFloor: Math.min(...missScores),
      rewardMax: Math.max(...missScores),
      sacrifice,
    });
  }

  lines.sort(compareLines);
  const best = lines.find((l) => l.length >= cfg.minLengthToDisplay) ?? null;
  return { lightsUp: best !== null, best, lines, bestRootScore, candidates };
}
