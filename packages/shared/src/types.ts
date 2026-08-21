/**
 * Entity shapes, mirroring the database schema.
 *
 * **These are not the wire contract.** What actually crosses the network is the
 * service DTO in [apps/api/src/services/repertoires.ts] and its counterpart in
 * [apps/web/src/api/client.ts] (`RepertoireFull`, `RepertoireMove`, …), which
 * carry denormalized helper fields the tables don't have. Keep these in sync
 * with the schema when it changes, but reach for the DTO when writing code
 * that talks to the API.
 */
import type { FenKey } from './fen.js';
import type { DrillRules } from './drill.js';

export type Color = 'white' | 'black';
export type Source = 'lichess' | 'chesscom';
export type SrsState = 'new' | 'learning' | 'review' | 'relearning';

export interface User {
  id: string;
  email: string | null;
  createdAt: string;
}

export interface Repertoire {
  id: string;
  userId: string;
  name: string;
  color: Color;
  tags: string[];
  /** Partial — always read through `mergeDrillRules()`. */
  drillRules: DrillRules;
  /** Phase 9c: opt-in silent auto-expansion of opponent replies while building. */
  autoExpand: boolean;
  rootFenKey: FenKey;
  rootFullFen: string;
  createdAt: string;
  updatedAt: string;
}

export interface Position {
  id: string;
  repertoireId: string;
  fenKey: FenKey;
  fullFen: string;
}

export interface Move {
  id: string;
  repertoireId: string;
  parentPositionId: string;
  childPositionId: string;
  san: string;
  uci: string;
  comment: string | null;
  annotation: string | null;
  isMainLine: boolean;
  priority: number;
  /** Phase 7: persistent "won't cover" marker; the walker skips it and its subtree. */
  isDropped: boolean;
  /** Phase 9a: line membership, inherited from the parent edge on insert. */
  lineTags: string[];
}

export interface SrsCard {
  id: string;
  userId: string;
  moveId: string;
  dueDate: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReviewed: string | null;
  state: SrsState;
}

export interface OpponentDataset {
  id: string;
  userId: string;
  source: Source;
  username: string;
  colorFilter: Color | null;
  timeControlFilter: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  gameCount: number;
  fetchedAt: string;
}

export interface OpponentPosition {
  id: string;
  datasetId: string;
  fenKey: FenKey;
}

export interface OpponentMove {
  id: string;
  datasetId: string;
  parentPositionId: string;
  san: string;
  uci: string;
  timesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
}
