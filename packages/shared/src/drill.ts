/**
 * Types for SRS cards, drill rules, and grading.
 *
 * Card state is owned by the client (the scheduler runs there). The server is
 * sync storage. Both sides serialize cards in this shape over the wire.
 */

export type FsrsState = 0 | 1 | 2 | 3; // new | learning | review | relearning

export const FsrsState = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const;

/** Grading buttons. Matches ts-fsrs Rating enum (1..4). */
export type Grade = 1 | 2 | 3 | 4;

export const Grade = {
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
} as const satisfies Record<string, Grade>;

/** Card shape on the wire. Dates are ISO strings, not Date objects. */
export interface SrsCardDto {
  id: string;
  moveId: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: FsrsState;
  lastReview: string | null;
  updatedAt: string;
}

export type DrillMode = 'due' | 'walkthrough' | 'weak' | 'random';

export interface DrillRules {
  /** Skip cards with depth-from-root less than this (in plies). */
  minDepth?: number;
  /** Skip cards with depth-from-root greater than this (in plies). */
  maxDepth?: number;
  /** When a position has multiple prepped moves: test all, or only main_line=true. */
  branching?: 'all' | 'main_line_only';
  /** Hide the board's pieces; show only the move sequence list. */
  blindfold?: boolean;
  /** Show engine evaluation after the user answers (depends on Phase 4 engine). */
  evalAfterAnswer?: boolean;
}

export const DEFAULT_DRILL_RULES: Required<DrillRules> = {
  minDepth: 0,
  maxDepth: 0, // 0 == no upper bound
  branching: 'all',
  blindfold: false,
  evalAfterAnswer: false,
};

export function mergeDrillRules(rules: DrillRules | undefined | null): Required<DrillRules> {
  return { ...DEFAULT_DRILL_RULES, ...(rules ?? {}) };
}

/**
 * The user-side color of a move from parent position with FEN turn-field `parentTurn`.
 * Used to filter which moves get cards and which to drill.
 */
export function isUserMove(parentTurn: 'w' | 'b', repertoireColor: 'white' | 'black'): boolean {
  return (parentTurn === 'w' && repertoireColor === 'white') ||
    (parentTurn === 'b' && repertoireColor === 'black');
}

/** Extract the side-to-move from a (full or normalized) FEN. */
export function fenTurn(fen: string): 'w' | 'b' {
  const parts = fen.trim().split(/\s+/);
  return (parts[1] ?? 'w') as 'w' | 'b';
}
