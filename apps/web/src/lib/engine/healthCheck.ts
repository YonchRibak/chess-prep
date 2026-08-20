import { fenTurn, isUserMove, type Color } from '@chess-prep/shared';
import type { AnalysisProgress } from './engine.ts';
import { getEngine } from './engine.ts';
import type {
  RepertoireFull,
  RepertoireMove,
  RepertoirePosition,
} from '../../api/client.ts';

export interface HealthCheckOptions {
  /** Analysis depth per position. Higher = slower but more reliable. */
  depth: number;
  /** Number of top lines to track. The prepped move only flags if it's in this set or absent. */
  multipv: number;
  /** Eval delta (cp) above which a move is flagged as "questionable". */
  flagThresholdCp: number;
}

export const DEFAULT_HEALTH_OPTIONS: HealthCheckOptions = {
  depth: 15,
  multipv: 3,
  flagThresholdCp: 50,
};

export interface MoveAssessment {
  move: RepertoireMove;
  parent: RepertoirePosition;
  /** Eval of the engine's top choice from the parent position, side-to-move POV. */
  topCp: number | null;
  topMate: number | null;
  topSanPv: string[];
  /** Eval of the prepped move, side-to-move POV — null if it didn't appear in MultiPV. */
  preppedCp: number | null;
  preppedMate: number | null;
  /** topCp - preppedCp (positive = prepped is worse). null if either side mates. */
  deltaCp: number | null;
  /** True if the prepped move was outside the top-N lines at the given depth. */
  notInTopN: boolean;
  /** True if flagged as questionable (delta > threshold OR not in top N). */
  flagged: boolean;
  /** Engine's best move (UCI). */
  engineBestUci: string;
}

export interface HealthCheckProgress {
  total: number;
  done: number;
  current: RepertoireMove | null;
  flagged: MoveAssessment[];
}

/**
 * Run a health check on every user-side prepped move in a repertoire.
 * Calls `onProgress` after each move completes. Returns the final report.
 *
 * Cancellation: pass a signal that resolves to true to abort. The current
 * position's analysis completes but no more are started.
 */
export async function runHealthCheck(
  repertoire: RepertoireFull,
  options: HealthCheckOptions,
  onProgress: (p: HealthCheckProgress) => void,
  shouldCancel: () => boolean = () => false,
): Promise<MoveAssessment[]> {
  const engine = getEngine();
  await engine.init();

  const positionById = new Map(repertoire.positions.map((p) => [p.id, p]));

  // Collect candidate user-color moves to check.
  const candidates: { move: RepertoireMove; parent: RepertoirePosition }[] = [];
  for (const m of repertoire.moves) {
    const parent = positionById.get(m.parentPositionId);
    if (!parent) continue;
    if (!isUserMove(fenTurn(parent.fullFen), repertoire.color as Color)) continue;
    candidates.push({ move: m, parent });
  }

  const assessments: MoveAssessment[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (shouldCancel()) break;
    const { move, parent } = candidates[i]!;
    onProgress({
      total: candidates.length,
      done: i,
      current: move,
      flagged: assessments.filter((a) => a.flagged),
    });

    const result = await engine.analyzeOnce(parent.fullFen, {
      depth: options.depth,
      multipv: options.multipv,
    });
    const assessment = scoreAgainstEngine(move, parent, result, options);
    assessments.push(assessment);
  }

  onProgress({
    total: candidates.length,
    done: assessments.length,
    current: null,
    flagged: assessments.filter((a) => a.flagged),
  });
  return assessments;
}

function scoreAgainstEngine(
  move: RepertoireMove,
  parent: RepertoirePosition,
  result: AnalysisProgress,
  options: HealthCheckOptions,
): MoveAssessment {
  const lines = result.lines.slice().sort((a, b) => a.multipv - b.multipv);
  const top = lines[0];
  const preppedUci = move.uci.slice(0, 4); // strip promotion suffix for matching
  const prepped = lines.find((l) => l.pv[0]?.slice(0, 4) === preppedUci);

  const topCp = top?.cp ?? null;
  const topMate = top?.mate ?? null;
  const preppedCp = prepped?.cp ?? null;
  const preppedMate = prepped?.mate ?? null;

  let deltaCp: number | null = null;
  if (topCp != null && preppedCp != null) {
    deltaCp = topCp - preppedCp;
  } else if (top?.mate != null && prepped == null) {
    // Engine sees mate but prepped move wasn't in top N — definitely flag.
    deltaCp = null;
  }

  const notInTopN = prepped == null;
  let flagged = false;
  if (notInTopN) flagged = true;
  else if (deltaCp != null && deltaCp > options.flagThresholdCp) flagged = true;
  // If engine sees mate but prepped doesn't (different sign of mate), flag.
  if (topMate != null && preppedMate == null && prepped) {
    if (topMate > 0) flagged = true;
  }

  return {
    move,
    parent,
    topCp,
    topMate,
    topSanPv: top?.pv ?? [],
    preppedCp,
    preppedMate,
    deltaCp,
    notInTopN,
    flagged,
    engineBestUci: top?.pv[0] ?? '',
  };
}
