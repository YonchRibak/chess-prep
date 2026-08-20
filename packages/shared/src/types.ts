import type { FenKey } from './fen.js';

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
