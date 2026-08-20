/**
 * Phase 9b: opening-explorer statistics, and the policy for turning them into
 * candidate moves.
 *
 * Three candidate sources exist, each with exactly one job
 * ([repertoire-growth.md](../../../knowledge/03-domain/repertoire-growth.md)):
 *
 * | Source | Job |
 * |---|---|
 * | ECO book | naming, and shallow breadth |
 * | **explorer (here)** | *which opponent replies matter* — frequency and W/D/L |
 * | Stockfish | *which move the user should play* |
 *
 * Using one source for all three is the mistake to avoid. The book has no
 * frequency data and dries up around ply 8–10, so it cannot say a reply is 62%
 * of games rather than merely that it has a name. Conversely popularity is not
 * correctness, so the explorer must not pick the user's own move — it only
 * re-ranks moves the engine already approved.
 *
 * Everything here is pure: fetching and caching live in the API
 * (`services/explorer.ts`), so this policy is testable and identical on both
 * sides of the wire.
 */

/** One move's record in a position, as the explorer reports it. */
export interface ExplorerMoveStat {
  san: string;
  uci: string;
  white: number;
  draws: number;
  black: number;
}

/** A position's explorer record. `total` is games, not moves. */
export interface ExplorerEntry {
  fenKey: string;
  /**
   * Which dataset and filters produced this row — e.g.
   * `lichess:blitz,rapid,classical:1600`. Part of the cache key, because the
   * same position has genuinely different statistics per rating band and time
   * control; merging them would silently average away the distinction.
   */
  source: string;
  total: number;
  moves: ExplorerMoveStat[];
  fetchedAt: string;
}

export function movePlayCount(m: ExplorerMoveStat): number {
  return m.white + m.draws + m.black;
}

/** Share of the position's games in which this move was played, 0..1. */
export function moveShare(m: ExplorerMoveStat, total: number): number {
  if (total <= 0) return 0;
  return movePlayCount(m) / total;
}

/**
 * Score from the perspective of the side to move, 0..1 (a draw counts a half).
 * Returns `null` below `minGames` — a 100% score over three games is noise, and
 * showing it next to a real number invites the user to trust it.
 */
export function moveScore(
  m: ExplorerMoveStat,
  sideToMove: 'w' | 'b',
  minGames = 10,
): number | null {
  const n = movePlayCount(m);
  if (n < minGames) return null;
  const wins = sideToMove === 'w' ? m.white : m.black;
  return (wins + m.draws / 2) / n;
}

export interface OpponentReplyPolicy {
  /** Stop once the kept moves cover this share of games. */
  cumulativeShare: number;
  /** Ignore moves rarer than this. */
  minShare: number;
  /** Never return more than this many. */
  maxReplies: number;
  /** Ignore the whole entry below this many games — too thin to rank. */
  minTotalGames: number;
}

export const DEFAULT_OPPONENT_REPLY_POLICY: OpponentReplyPolicy = {
  cumulativeShare: 0.8,
  minShare: 0.05,
  maxReplies: 3,
  minTotalGames: 20,
};

export interface RankedReply {
  san: string;
  uci: string;
  /** 0..1 share of games at this position. */
  share: number;
  games: number;
  /** Score for the player to move, or null when too few games to mean anything. */
  score: number | null;
}

/**
 * Which opponent replies are worth preparing against.
 *
 * Descending frequency, taking moves until the kept set covers
 * `cumulativeShare` of games, skipping anything under `minShare`, capped at
 * `maxReplies`. The cap is what keeps auto-expansion from exploding: opponent
 * moves carry no SRS card, but each one still widens the frontier the user will
 * later be asked about.
 *
 * Returns `[]` for a cold or too-thin entry. Callers must have a book fallback
 * — a drill session has to work with the cache empty
 * ([local-first-sync](../../../knowledge/02-architecture/local-first-sync.md)).
 */
export function selectOpponentReplies(
  entry: ExplorerEntry | null | undefined,
  sideToMove: 'w' | 'b',
  policy: Partial<OpponentReplyPolicy> = {},
): RankedReply[] {
  const p = { ...DEFAULT_OPPONENT_REPLY_POLICY, ...policy };
  if (!entry || entry.total < p.minTotalGames) return [];

  const ranked = entry.moves
    .map((m) => ({
      san: m.san,
      uci: m.uci,
      games: movePlayCount(m),
      share: moveShare(m, entry.total),
      score: moveScore(m, sideToMove),
    }))
    .filter((m) => m.share >= p.minShare)
    // Frequency first; SAN only as a tiebreak so the result is deterministic.
    .sort((a, b) => (b.share - a.share) || a.san.localeCompare(b.san));

  const out: RankedReply[] = [];
  let covered = 0;
  for (const m of ranked) {
    if (out.length >= p.maxReplies) break;
    out.push(m);
    covered += m.share;
    if (covered >= p.cumulativeShare) break;
  }
  return out;
}

/** One engine suggestion, reduced to what ranking needs. */
export interface EngineCandidate {
  san: string;
  uci: string;
  /** Centipawns from the side-to-move's perspective. */
  cp?: number;
  /** Mate distance; positive means the side to move mates. */
  mate?: number;
}

export interface UserCandidate extends EngineCandidate {
  /** Engine order, 1 = best. Preserved so the UI can show "engine's #2". */
  engineRank: number;
  /** Explorer share at this position, 0..1, or null when unknown. */
  share: number | null;
  games: number | null;
  score: number | null;
}

export interface UserCandidatePolicy {
  /** How many engine lines to consider. */
  limit: number;
  /**
   * How far below the engine's best a move may be (centipawns) and still be
   * offered. Popularity must not promote a move the engine considers bad.
   */
  maxCentipawnLoss: number;
}

export const DEFAULT_USER_CANDIDATE_POLICY: UserCandidatePolicy = {
  limit: 3,
  maxCentipawnLoss: 50,
};

/**
 * The user's own candidate moves: **engine first, explorer only as a
 * tiebreaker**.
 *
 * Moves outside `maxCentipawnLoss` of the engine's best are dropped entirely,
 * so a popular-but-bad move can never surface. Among the survivors — which the
 * engine considers near-equivalent — the more played move is offered first,
 * because between two sound moves the one people actually play is the one with
 * theory behind it and the one the opponent has prepared for.
 *
 * A missing explorer entry degrades to plain engine order, which is the whole
 * point: this must work offline.
 */
export function rankUserCandidates(
  engineLines: readonly EngineCandidate[],
  entry: ExplorerEntry | null | undefined,
  sideToMove: 'w' | 'b',
  policy: Partial<UserCandidatePolicy> = {},
): UserCandidate[] {
  const p = { ...DEFAULT_USER_CANDIDATE_POLICY, ...policy };
  if (engineLines.length === 0) return [];

  const statByUci = new Map((entry?.moves ?? []).map((m) => [m.uci, m]));
  const total = entry?.total ?? 0;

  const withRank = engineLines.slice(0, p.limit).map((line, i) => {
    const stat = statByUci.get(line.uci);
    return {
      ...line,
      engineRank: i + 1,
      share: stat ? moveShare(stat, total) : null,
      games: stat ? movePlayCount(stat) : null,
      score: stat ? moveScore(stat, sideToMove) : null,
    };
  });

  const best = withRank[0]!;
  const survivors = withRank.filter((c) => withinLoss(best, c, p.maxCentipawnLoss));

  return survivors.sort((a, b) => {
    // Explorer popularity decides only among engine-equivalent moves; when
    // neither has data, engine order stands.
    const sa = a.share ?? -1;
    const sb = b.share ?? -1;
    if (sa !== sb) return sb - sa;
    return a.engineRank - b.engineRank;
  });
}

/**
 * Is `c` within `maxLoss` centipawns of `best`?
 *
 * Mate scores don't convert to centipawns, so they're compared on their own
 * terms: a mate for the side to move beats any non-mate, being mated loses to
 * any non-mate, and two mates compare by distance.
 */
function withinLoss(best: EngineCandidate, c: EngineCandidate, maxLoss: number): boolean {
  if (best.mate !== undefined || c.mate !== undefined) {
    const bm = mateRank(best);
    const cm = mateRank(c);
    if (bm !== cm) return cm >= bm;
    if (best.mate !== undefined && c.mate !== undefined) return c.mate <= best.mate;
    return true;
  }
  return (best.cp ?? 0) - (c.cp ?? 0) <= maxLoss;
}

/** 1 = mating, 0 = no mate either way, -1 = getting mated. */
function mateRank(c: EngineCandidate): number {
  if (c.mate === undefined) return 0;
  return c.mate > 0 ? 1 : -1;
}
