/**
 * Phase 9c: which opponent replies the build walk may add **without asking**.
 *
 * The asymmetry that makes auto-expansion safe: opponent-turn moves carry no
 * SRS card ([glossary](../../../../../knowledge/01-overview/glossary.md)), so
 * widening the frontier costs the user nothing at drill time. Only the user's
 * own move creates a card, and that one always prompts.
 *
 * Two rules do the real work here, both guarding failures that are otherwise
 * silent:
 *
 * 1. **A dropped branch is never re-added.** `is_dropped` is a standing
 *    "won't cover" instruction. An attention node is defined by having no
 *    *live* children — a position whose every reply was dropped looks exactly
 *    like an untouched one, so without this filter auto-expansion would
 *    faithfully re-add precisely what the user rejected, and keep doing it
 *    every session.
 * 2. **The candidate cap is the throttle.** Left uncapped, each expansion
 *    multiplies the frontier, and the user meets the cost later as a wall of
 *    "what's your move?" prompts.
 *
 * And one rule about *evidence*: auto-expansion acts only on explorer-sourced
 * candidates. The book fallback is ordered by name-then-alphabet, not by how
 * often a move is actually played, so auto-adding its top three after 1.e4
 * would prep `a5, a6, b6` instead of `c5, e5, e6`. It is fine to *show* that
 * list — the user can see it is alphabetical — but never to write from it.
 */
import type { RankedReply } from '@chess-prep/shared';
import type { CandidateSource } from '../openings/candidates.ts';
import type { RepertoireMove } from '../../api/client.ts';

export interface AutoExpandDecision {
  /** SANs to insert silently, in priority order. */
  sans: string[];
  /**
   * Why nothing is being added, when `sans` is empty — the caller falls back
   * to prompting the user, and the reason is worth showing.
   */
  skipped: 'none' | 'no-candidates' | 'all-known' | 'all-dropped' | 'no-frequency-data';
}

export interface AutoExpandOptions {
  /**
   * Where the candidates came from. Anything but `'explorer'` blocks the write
   * — see the evidence rule above.
   */
  source: CandidateSource;
  /** Hard cap on replies added at one position. */
  max?: number;
}

/**
 * Decide what to auto-add at one opponent-turn position.
 *
 * `existing` is every move already saved at that parent — **live and dropped
 * both**, which is the point: the caller must not pre-filter to live moves.
 */
export function selectAutoExpandSans(
  candidates: readonly RankedReply[],
  existing: readonly RepertoireMove[],
  options: AutoExpandOptions,
): AutoExpandDecision {
  const max = options.max ?? 3;
  if (options.source !== 'explorer') return { sans: [], skipped: 'no-frequency-data' };
  if (candidates.length === 0) return { sans: [], skipped: 'no-candidates' };

  const dropped = new Set(existing.filter((m) => m.isDropped).map((m) => m.san));
  const live = new Set(existing.filter((m) => !m.isDropped).map((m) => m.san));

  const fresh = candidates.filter((c) => !dropped.has(c.san) && !live.has(c.san));
  if (fresh.length === 0) {
    // Distinguish the two, because they mean different things to the user:
    // "you already have these" vs "you told me not to cover these".
    const anyDropped = candidates.some((c) => dropped.has(c.san));
    return { sans: [], skipped: anyDropped ? 'all-dropped' : 'all-known' };
  }

  return { sans: fresh.slice(0, max).map((c) => c.san), skipped: 'none' };
}
