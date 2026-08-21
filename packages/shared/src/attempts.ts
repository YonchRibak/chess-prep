/**
 * Phase 9d mistake rehearsal — the drill-attempt log and what it unlocks.
 *
 * Before this, a miss graded Again and left no trace beyond FSRS's `lapses`
 * counter. A counter cannot answer "what did I get wrong *this week*" and it
 * cannot say *what the user played instead*, which is the interesting half: the
 * wrong move is usually the user's own prep from a different position.
 *
 * An attempt is `(moveId, playedSan, wasCorrect, at)` — append-only, cheap, and
 * the input to both features below. Everything here is pure: the client ranks
 * mistakes offline from its local log, and the server stores the same shape.
 */

/** One recorded answer to one card. Append-only; never updated. */
export interface DrillAttemptDto {
  id: string;
  moveId: string;
  repertoireId: string;
  /** SAN the user actually played — equals the prep's SAN when `wasCorrect`. */
  playedSan: string;
  wasCorrect: boolean;
  /** ISO timestamp of the attempt. */
  at: string;
}

/** An attempt before it has a server id — what the client records locally. */
export type NewDrillAttempt = Omit<DrillAttemptDto, 'id'> & { id?: string };

/**
 * How far back the `mistakes` mode looks, and how fast a miss stops mattering.
 *
 * The window exists so the mode means "recent errors" rather than "every error
 * I ever made" — the latter is what FSRS `lapses` already gives, and is exactly
 * the drill mode this one is meant to be *distinct* from.
 */
export const MISTAKES_WINDOW_DAYS = 14;
export const MISTAKE_HALF_LIFE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MistakeRankingOptions {
  now?: Date;
  windowDays?: number;
  halfLifeDays?: number;
}

export interface MistakeStat {
  moveId: string;
  /** Recency-weighted severity; higher means "rehearse this sooner". */
  score: number;
  /** Raw miss count inside the window — shown to the user, not used to sort. */
  misses: number;
  /** ISO time of the most recent miss inside the window. */
  lastMissAt: string;
}

/**
 * Rank moves by recent, unrepaired mistakes.
 *
 * Each miss contributes an exponentially decaying weight, and each *correct*
 * attempt in the window pays back half a unit of the same weight. That payback
 * is the whole point: without it a move the user missed once and has since
 * answered correctly five times keeps outranking a fresh miss forever, and the
 * mode degenerates into a permanent hall of shame.
 *
 * A move with no miss inside the window is not ranked at all, regardless of how
 * the arithmetic lands.
 */
export function rankMistakes(
  attempts: readonly DrillAttemptDto[],
  options: MistakeRankingOptions = {},
): MistakeStat[] {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? MISTAKES_WINDOW_DAYS;
  const halfLifeDays = options.halfLifeDays ?? MISTAKE_HALF_LIFE_DAYS;
  const cutoff = now.getTime() - windowDays * DAY_MS;

  const byMove = new Map<string, { score: number; misses: number; lastMissAt: string }>();

  for (const a of attempts) {
    const t = Date.parse(a.at);
    if (Number.isNaN(t) || t < cutoff || t > now.getTime()) continue;
    const ageDays = (now.getTime() - t) / DAY_MS;
    const weight = Math.pow(2, -ageDays / halfLifeDays);

    const entry = byMove.get(a.moveId) ?? { score: 0, misses: 0, lastMissAt: '' };
    if (a.wasCorrect) {
      entry.score -= weight / 2;
    } else {
      entry.score += weight;
      entry.misses += 1;
      if (!entry.lastMissAt || t > Date.parse(entry.lastMissAt)) entry.lastMissAt = a.at;
    }
    byMove.set(a.moveId, entry);
  }

  const out: MistakeStat[] = [];
  for (const [moveId, e] of byMove) {
    if (e.misses === 0) continue;
    out.push({ moveId, score: Math.max(0, e.score), misses: e.misses, lastMissAt: e.lastMissAt });
  }
  // Highest score first; ties broken by the more recent miss so the ordering is
  // total and therefore stable across runs.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Date.parse(b.lastMissAt) - Date.parse(a.lastMissAt);
  });
  return out;
}

/* ---------------- interference detection ---------------- */

/** The minimum a caller must know about a prepped move to test interference. */
export interface PrepRef {
  moveId: string;
  parentPositionId: string;
  san: string;
}

export interface Interference extends PrepRef {
  /** Ply depth of the *other* position, when the caller knows it. */
  depth?: number;
}

/**
 * "That's your move in the Advance, not here."
 *
 * When a miss's played SAN is the user's own prep at a **different** position in
 * the same tree, the error is almost never a memory blank — it is a
 * transposition confusion between two lines that look alike. Naming the other
 * line is the highest-value feedback available here, and it costs one pass over
 * an index the drill queue already builds.
 *
 * `preps` must contain only user-side, non-dropped moves: an opponent reply
 * sharing the SAN is a coincidence, not a confusion, and reporting it would
 * train the user to distrust the hint.
 */
export function findInterference(
  playedSan: string,
  currentParentPositionId: string,
  preps: readonly PrepRef[],
): Interference[] {
  const needle = playedSan.trim();
  if (!needle) return [];
  return preps.filter((p) => p.san === needle && p.parentPositionId !== currentParentPositionId);
}
