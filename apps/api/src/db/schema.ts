import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const repertoires = pgTable('repertoires', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // 'white' | 'black' — which side the repertoire prepares.
  color: text('color').notNull(),
  // Denormalized root so the client can quickly know where the tree starts.
  rootFenKey: text('root_fen_key').notNull(),
  rootFullFen: text('root_full_fen').notNull(),
  tags: text('tags').array().notNull().default([]),
  drillRules: jsonb('drill_rules').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repertoireId: uuid('repertoire_id')
      .notNull()
      .references(() => repertoires.id, { onDelete: 'cascade' }),
    fenKey: text('fen_key').notNull(),
    fullFen: text('full_fen').notNull(),
  },
  (t) => [unique('uniq_repertoire_fen').on(t.repertoireId, t.fenKey)],
);

export const moves = pgTable(
  'moves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repertoireId: uuid('repertoire_id')
      .notNull()
      .references(() => repertoires.id, { onDelete: 'cascade' }),
    parentPositionId: uuid('parent_position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    childPositionId: uuid('child_position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    san: text('san').notNull(),
    uci: text('uci').notNull(),
    comment: text('comment'),
    annotation: text('annotation'),
    isMainLine: boolean('is_main_line').notNull().default(false),
    priority: integer('priority').notNull().default(0),
    // Phase 7: explicit "won't cover" marker. The user has decided not to prep
    // this branch — the walker skips dropped moves (and their subtrees) and
    // they never resurface as uncovered. Distinct from Skip (ephemeral / per
    // session). Cards on dropped user-side moves are kept for SRS history
    // intent but the walker won't drill them.
    isDropped: boolean('is_dropped').notNull().default(false),
  },
  (t) => [unique('uniq_parent_san').on(t.repertoireId, t.parentPositionId, t.san)],
);

/**
 * One SRS card per move. Created automatically when a move is added for the
 * user's color (i.e., when it's "their" move to play from the parent position).
 * Stores raw FSRS state — the client owns the scheduling math.
 */
export const srsCards = pgTable(
  'srs_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    moveId: uuid('move_id')
      .notNull()
      .references(() => moves.id, { onDelete: 'cascade' }),
    due: timestamp('due', { withTimezone: true }).notNull(),
    stability: doublePrecision('stability').notNull().default(0),
    difficulty: doublePrecision('difficulty').notNull().default(0),
    elapsedDays: doublePrecision('elapsed_days').notNull().default(0),
    scheduledDays: doublePrecision('scheduled_days').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    // FSRS State enum: 0=new, 1=learning, 2=review, 3=relearning.
    state: smallint('state').notNull().default(0),
    lastReview: timestamp('last_review', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uniq_user_move').on(t.userId, t.moveId),
    index('idx_user_due').on(t.userId, t.due),
  ],
);

/**
 * Read-only ECO opening reference. One row per known named position, keyed by
 * normalized `fen_key`. The importer (apps/api/src/scripts/import-openings.ts)
 * drops and reloads this table from the bundled lichess `chess-openings` TSVs.
 *
 * `pgn_moves` is the canonical move sequence from the starting position used
 * by the Phase 6 browser to step through a line; everywhere else, identity is
 * by `fen_key`.
 */
export const openingBookEntries = pgTable(
  'opening_book_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eco: text('eco').notNull(),
    name: text('name').notNull(),
    variation: text('variation'),
    fenKey: text('fen_key').notNull(),
    fullFen: text('full_fen').notNull(),
    pgnMoves: text('pgn_moves').notNull(),
  },
  (t) => [
    unique('uniq_opening_fen_key').on(t.fenKey),
    index('idx_opening_eco').on(t.eco),
    index('idx_opening_name').on(t.name),
  ],
);

/**
 * Phase 8a daily-diet settings. One row per user. `newCardsPerDay` caps how
 * many cards in FSRS state=new can enter the daily diet — without this,
 * fresh repertoires flood the first sessions. `dailyDietLastResetAt` is the
 * canonical "today" boundary used to count new cards shown today (we count
 * by `lastReview > daily_diet_last_reset_at`, no separate counter).
 */
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  newCardsPerDay: integer('new_cards_per_day').notNull().default(20),
  dailyDietLastResetAt: timestamp('daily_diet_last_reset_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DbUser = typeof users.$inferSelect;
export type DbRepertoire = typeof repertoires.$inferSelect;
export type DbPosition = typeof positions.$inferSelect;
export type DbMove = typeof moves.$inferSelect;
export type DbSrsCard = typeof srsCards.$inferSelect;
export type DbOpeningBookEntry = typeof openingBookEntries.$inferSelect;
export type DbUserSettings = typeof userSettings.$inferSelect;
