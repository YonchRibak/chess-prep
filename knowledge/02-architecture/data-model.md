# Data model

Schema: [apps/api/src/db/schema.ts](../../apps/api/src/db/schema.ts) (Drizzle).
Migrations: [apps/api/drizzle/](../../apps/api/drizzle/) — `0000` base, `0001`, `0002`,
`0003_drop_branch`, `0004_user_settings`, `0005_line_tags`, `0006_explorer_entries`.

The flexibility Lotus lacks comes from modeling repertoires as **position-keyed move
trees**, not linear lines.

## Tables

### `users`
`id`, `email` (unique, nullable), `created_at`. Single-user for now — see `DEFAULT_USER_ID`.

### `repertoires`
`user_id`, `name`, `color` (`'white'|'black'`), `tags[]`, `drill_rules` (jsonb),
timestamps, plus a denormalized root: `root_fen_key` / `root_full_fen` so the client
knows where the tree starts without a query.

`drill_rules` is a partial [`DrillRules`](../../packages/shared/src/drill.ts); always
read it through `mergeDrillRules()` rather than assuming fields exist.

### `positions`
`repertoire_id`, `fen_key`, `full_fen`. Unique `uniq_repertoire_fen (repertoire_id, fen_key)`
— **this is what collapses transpositions** to a single node per repertoire.

### `moves`
The edge, and the unit of prep:
`repertoire_id`, `parent_position_id`, `child_position_id`, `san`, `uci`, `comment`,
`annotation`, `is_main_line`, `priority`, `is_dropped`, `line_tags[]`.

Unique `uniq_parent_san (repertoire_id, parent_position_id, san)` — no duplicate SAN
from one parent, but **multiple distinct children per parent are intentionally allowed**
(opponent branches need this).

Opening identity is **not** denormalized here — look it up via `fenKey()` against
`opening_book_entries` on read.

`is_dropped` (migration `0003`) is the persistent "won't cover" marker. Both
`buildDrillQueue` and the walker's BFS treat dropped moves as nonexistent, subtree
included.

`line_tags` (migration `0005`, Phase 9a) is explicit line membership for what the ECO
book can't name — `vs-danny`, `blitz-only`. It is **inherited from the parent edge on
insert** (`inheritLineTags` in [scope.ts](../../packages/shared/src/scope.ts)); supplying
tags explicitly *replaces* the inherited set and re-roots inheritance below. Without
inheritance a move added under a tagged branch point would be born untagged and silently
vanish from a tag-scoped session — a session that looks complete and isn't. Retagging an
existing edge therefore cascades over its subtree (`retagSubtree`). See
[srs-drilling](../03-domain/srs-drilling.md#line-scopes-phase-9a).

### `srs_cards`
One card per prep move. Stores raw FSRS state — `due`, `stability`, `difficulty`,
`elapsed_days`, `scheduled_days`, `reps`, `lapses`, `state` (smallint 0..3),
`last_review`, `updated_at`.

- Unique `uniq_user_move (user_id, move_id)`.
- Index `idx_user_due (user_id, due)`.
- **Persist all FSRS fields, not just the due date** — rescheduling breaks otherwise.

### `opening_book_entries`
Read-only ECO reference: `eco`, `name`, `variation`, `fen_key` (unique), `full_fen`,
`pgn_moves`. Dropped and reloaded wholesale by the importer. User actions never mutate
it. See [opening-database](../03-domain/opening-database.md).

### `explorer_entries`
Phase 9b cache of opening-explorer statistics: `fen_key`, `source`, `total`,
`moves` (jsonb), `fetched_at`, unique on `(fen_key, source)`. **A cache, never a source of
truth — safe to truncate**, and every reader must work with it cold. `source` includes the
dataset's filters (`lichess:blitz,rapid,classical:1600`) because the same position has
different statistics per rating band and time control. Full rationale in
[explorer](../03-domain/explorer.md).

### `user_settings`
One row per user: `new_cards_per_day` (default 20), `daily_diet_last_reset_at`,
`updated_at`. The reset timestamp is the canonical "today" boundary — new cards shown
today are counted by `last_review > daily_diet_last_reset_at`, deliberately with **no
separate counter**, so a crash or mid-session reload can't double-count.

## Invariants that are NOT database constraints

Read this before touching the move-insert path.

**"One prep move per user-turn position"** is a **v1 application-level invariant**.
Nothing in the schema enforces it: `uniq_user_move` only prevents duplicate *cards* on
the same move, and `uniq_parent_san` still permits two distinct user-side SANs from one
parent. Enforcement lives in `enforceOnePrepPerUserPosition` in
[services/repertoires.ts](../../apps/api/src/services/repertoires.ts), covered by
[repertoires.invariant.test.ts](../../apps/api/src/services/repertoires.invariant.test.ts).
The walker UI catches the resulting `409` and offers an explicit swap confirmation
(`onConflict: 'refuse' | 'swap'` on `addMove` / `appendLine`).

Hardening this into a partial unique index would require a stored `is_user_side`
column, deferred to the v2 `option_label` work.

**Changing a prep move** (swap) deletes the old user-side `Move` — cascade removes its
`SrsCard` — and inserts the new one. The new card starts at FSRS `state='new'`; SRS
history is **not** preserved through a swap in v1.

**Coverage is derived, never stored.** There is no `covered` column. Any position whose
live outgoing move set is empty is uncovered; the walker computes it.

## Parked entities

`OpponentDataset` / `OpponentPosition` / `OpponentMove` appear as TypeScript types in
[types.ts](../../packages/shared/src/types.ts) but have **no tables and no code paths** —
they belong to the parked Phase 9 scouting feature. Don't assume they're wired.

## v2 shape to avoid painting into a corner

A future "multiple labeled prep options per position" feature (blitz / classical /
must-win / draw-is-enough moves) would add `option_label` to `moves` and relax
`uniq_user_move` to `(user, move, option_label)`. Don't build it — but avoid writing
code that assumes "exactly one row per `(user, parent_position)`" beyond the constraint
itself.
