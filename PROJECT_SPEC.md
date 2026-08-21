# Chess Prep Tool — Build Spec

A web-first PWA for chess opening preparation: learn from a built-in opening database, build your own repertoire on top of named openings, and drill those moves flashcard-style with spaced repetition. Engine analysis is available everywhere except inside an open flashcard.

This document is the build brief for a coding agent. Work through it phase by phase. Each phase ends in a runnable, testable state — do not start a phase before the previous one runs.

**Status legend:** ✅ done · 🚧 in progress · ⏭ next · ⏸ parked (not in current cycle)

---

## 1. Product goals

The owner is a competitive chess player and fullstack developer. They previously used Lotus Chess for flashcard drilling and want the same core loop with deeper customizability, plus integration with a named-opening database so prep is grounded in real theory.

Primary use case priority, in order:
1. Building and drilling a personal opening repertoire on top of a named-opening database.
2. A daily mixed-side drill that just works.
3. Engine-assisted analysis for free study (but **never** during an unanswered flashcard).
4. Optional later: opponent scouting via move-frequency heatmap (parked, see §8).

Non-negotiable qualities:
- Flashcard drilling must work **offline** (PWA, local-first data with sync).
- The user must never be locked in: PGN import **and** export for every repertoire.
- More customizable drilling than Lotus: per-repertoire drill rules (depth limits, side, blindfold, eval-after-answer, weak-spot targeting), plus a daily-diet mixed session.
- Engine never leaks the answer mid-card. This is a hard mode-level guarantee, not a UI hide.

### Core flashcard loop — the walker

The atomic unit is a **prepared move**: a parent position (normalized FEN) + the single move the user wants to play there. The whole app is one **walker** session over the position-keyed tree. The walker steps node-by-node; at each node, what happens depends on (a) whose turn it is and (b) whether the user has prepped it:

| State | When | What the walker does |
|---|---|---|
| **Your move — build** | User turn, no prep | Asks *"What's your move?"* with book suggestions. User plays; one `Move` + one SRS card saved. |
| **Your move — drill** | User turn, prep exists | Shows the bare position. User produces the move; auto-graded (correct = Good, wrong = Again). |
| **Choose responses — build** | Opponent turn, no branches | Asks *"Which responses do you want to prepare against?"* — multi-select from book + free legal move. Each pick saved as a `Move` and opens a new branch. |
| **Opponent replies — drill** | Opponent turn, ≥1 branch | Auto-plays one saved branch (drill seed: most-due-child; build seed: round-robin next). |

Build and drill are not separate UIs — they're two **seeds** into the same walker:
- **Drill** seeds with FSRS-due cards. If it hits an unprepped node, the panel slides into build mode for that node, then resumes the queue.
- **Build** seeds at the shallowest uncovered position and walks round-robin (breadth-first across branches). If it hits a node already prepped, the panel slides into drill mode for that node, then continues.

**Daily session** (Phase 8a) is a Drill-seed walker that pulls due cards across every repertoire for the chosen side (White / Black / Mixed) until the due pool is empty.

Everything else in this spec — the opening DB, multi-repertoire daily diet, engine gating, per-repertoire drill rules — is customization layered on top of the walker.

---

## 2. Tech stack

Do not substitute these without flagging a reason. The chess ecosystem lives in JS/TS, so the stack follows it.

**Frontend**
- React + TypeScript, built with Vite.
- PWA from the start (`vite-plugin-pwa`), installable, offline drilling.
- **Board rendering:** Chessground (Lichess's board lib). Chosen for smooth drag, premoves, and native arrow/shape annotation. Do NOT use chessboard.jsx.
- **Chess rules:** `chess.js` for move legality, FEN/PGN, move generation.
- **PGN tree parsing:** `@mliebelt/pgn-parser` for repertoire imports with variations, NAGs, comments.
- **SRS scheduling:** FSRS via `ts-fsrs`. Do not hand-roll SM-2.
- State management: Zustand. No Redux.
- Styling: Tailwind CSS.

**Engine**
- `stockfish.wasm` running in a Web Worker so analysis never blocks the UI. Communicate over UCI. Leela is out of scope for v1.

**Backend**
- Node + TypeScript. Hono.
- Postgres. Drizzle ORM.
- Shared types package between client and server (`packages/shared`), monorepo via pnpm workspaces.

**Local-first**
- Drilling data (cards, schedules, repertoire trees) persisted in IndexedDB (`idb`) so the app works offline. Backend is the sync/backup target, not the source of truth for a drill session.

**Opening database**
- ECO dataset bundled into the API/DB: import the lichess-org `chess-openings` TSV files (ECO code, name, FEN, UCI/PGN moves) as a read-only lookup keyed by normalized FEN. License: CC0 / public domain — safe to vendor. If that source breaks, fall back to any equivalent ECO TSV.

**Mobile**
- No native build in v1. The PWA covers phones. If app-store presence is wanted later, wrap with Capacitor.

---

## 3. Architecture rule (enforce throughout)

Keep four concerns strictly separate:
- **Chessground** draws the board and shapes. It does not know rules.
- **chess.js** validates moves and generates legal moves. It does not draw.
- **Stockfish** evaluates. It does nothing else.
- **Opening DB** identifies named positions. It does not score, draw, or own user data.

Wrap each in its own module/hook (`useBoard`, `useChessRules`, `useEngine`, `useOpeningId`). Most chess apps tangle these and become unmaintainable — do not.

**Engine isolation rule:** the engine layer must accept a "gated" flag from drill mode. When gated, `analyze()` is a no-op and any in-flight analysis is cancelled. Hiding the panel is not enough — see Phase 8.

---

## 4. Data model

The flexibility that Lotus lacks comes from modeling repertoires as **position-keyed move trees**, not linear lines. Key on a normalized FEN.

**FEN normalization** (already implemented in `packages/shared/src/fen.ts`): strip the halfmove clock and fullmove number from the FEN before using it as a position key. Transpositions collapse to one node. Side-to-move, castling rights, and en passant stay in the key. Both client, server, **and** the opening DB use the same helper.

### Entities

```
User (id, email, created_at)

Repertoire (id, user_id, name, color['white'|'black'], tags[], drill_rules,
            root_fen_key, root_full_fen,
            auto_expand,          -- Phase 9c: opt-in silent opponent auto-expansion
            created_at, updated_at)

Position (id, repertoire_id, fen_key, full_fen)

Move (
  id, repertoire_id,
  parent_position_id, child_position_id,
  san, uci,
  comment, annotation, is_main_line, priority,
  is_dropped,       -- Phase 7: persistent "won't cover"; walker skips it and its subtree
  line_tags[],      -- Phase 9a: line membership, inherited from the parent edge on insert
  -- DB constraint: uniq_parent_san on (repertoire_id, parent_position_id, san)
  --   — no duplicate SAN from one parent, but DOES allow multiple distinct
  --     children per parent (intentional: opponent branches, AND historically
  --     allows two user-side moves; the "one prep per user position" rule
  --     in Phase 7 is application-level, see §4 Rules and Phase 7 below).
  -- Opening identity is NOT denormalized here; look it up via fenKey()
  --   against OpeningBookEntry on read (see Phase 5/6).
)

SrsCard (
  id, user_id, move_id,
  due, stability, difficulty, elapsed_days, scheduled_days,
  reps, lapses, state, last_review, updated_at,
  -- Persist EVERY FSRS field, not just `due`, or rescheduling breaks.
)

-- Opening database (read-only reference; added in Phase 5)
OpeningBookEntry (
  id,
  eco,              -- e.g. "E60"
  name,             -- e.g. "King's Indian Defense"
  variation,        -- e.g. "Sämisch Variation" (nullable)
  fen_key,          -- normalized FEN — primary lookup key, unique
  full_fen,
  pgn_moves,        -- canonical move sequence from the start position
)

ExplorerEntry (             -- (added in Phase 9b) — a CACHE, never a source of truth
  id,
  fen_key,
  source,                   -- dataset + filters, e.g. "lichess:blitz,rapid,classical:1600"
  total,                    -- games at this position
  moves,                    -- jsonb: [{ san, uci, white, draws, black }]
  fetched_at,
  -- unique (fen_key, source). Safe to truncate; every reader works with it cold.
)

DrillAttempt (              -- (added in Phase 9d) — APPEND-ONLY; never updated
  id,
  user_id,
  move_id,                  -- cascades
  repertoire_id,            -- denormalized so the log scopes without a join
  played_san,               -- what makes this more than FSRS's `lapses` counter
  was_correct,              -- correct attempts logged too: they decay a repaired mistake
  at,
  -- index (user_id, at), index (move_id). Duplicates accepted, not deduplicated.
)

UserSettings (              -- (added in Phase 8a)
  user_id,
  new_cards_per_day,        -- default 20
  daily_diet_last_reset_at,
  updated_at,
)

-- Phase 10 (parked): OpponentDataset / OpponentPosition / OpponentMove
```

### Rules
- SRS operates **per move**, not per line — the user drills the moves they actually forget. ✅ enforced at the DB level by `srs_cards.uniq_user_move` on `(user_id, move_id)` — one SrsCard per Move row.
- The opening database is **read-only reference**. The user's repertoire tree lives in its own tables and never mutates `OpeningBookEntry`.
- **"One prep move per user-turn position" is a v1 application-level invariant, NOT a DB constraint.** `uniq_user_move` only prevents duplicate cards on the same move; it does not prevent two distinct user-side Moves from the same parent (the `moves` table only has `uniq_parent_san` on `(repertoire_id, parent_position_id, san)`). Phase 7's build flow / `appendLine` is responsible for refusing or replacing a second user-side Move from the same parent. Hardening this to a partial unique index needs a stored `is_user_side` column on `moves` — deferred to the v2 `option_label` work.

---

## 5. Features by phase

### Phase 0 — Monorepo skeleton ✅ done
pnpm workspace `apps/web` + `apps/api` + `packages/shared`. Vite + React + TS + Tailwind on the web; Hono + Drizzle + Postgres on the API. Shared package imports cleanly on both sides.

### Phase 1 — Interactive board ✅ done
Chessground + chess.js wired together. `useChessRules`, `useBoard`. Undo/redo, flip, load FEN, illegal-move snap-back, check/checkmate/stalemate.

### Phase 2 — Repertoire CRUD + PGN ✅ done
Position-keyed tree, transposition collapse, tree view editor, comments/annotations/main-line/priority, PGN import (variations + NAGs + comments) and export, tags. Round-trip fidelity verified.

### Phase 3 — Drill engine + SRS ✅ done
Flashcard loop with FSRS grading; IndexedDB offline; sync on reconnect via push queue. Drill modes implemented: `due`, `walkthrough`, `weak`, `random`. Per-repertoire rules: min/max depth, branching (all vs main_line_only), blindfold, evalAfterAnswer flag (UI wiring for the eval reveal is finished in Phase 8).

**Flow mode (default loop):** the session auto-grades on move attempt — correct = Good, wrong = Again — and keeps the cards flowing without a manual reveal pane. Walkthrough mode uses ONE persistent board across the whole session: after a correct user move the saved opponent reply auto-plays on the same board and the user is now in the next card. Random / due / weak modes snap-load the next card's parent FEN. The drill mode selected in DrillSetup is threaded through the view (`{ kind: 'drill-session', repertoireId, mode }`); the walkthrough queue carries an `opponentResponseSan` on each card so `DrillSession` can play it via `useChessRules.playSan()`.

### Phase 4 — Engine layer ✅ done
Stockfish in a Web Worker with the UCI protocol. `useEngine` for on-demand analysis with configurable depth and MultiPV. EnginePanel with eval bar + top lines in the repertoire editor. Repertoire health check: batch-eval every move, flag moves N cp worse than top.

---

### Phase 5 — Opening database foundation ✅ done

The lichess `chess-openings` TSVs (`a.tsv`–`e.tsv`, 3,733 unique fenKeys) are vendored under `apps/api/data/openings/`. An `OpeningBookEntry` table (unique on `fen_key`) and an idempotent importer CLI (`pnpm --filter @chess-prep/api db:import-openings`) drop + reload from the bundled TSVs. Every row goes through the shared `fenKey()` normalizer; a pure-logic parity test in `packages/shared/src/openings.test.ts` plus a DB-touching integration test in `apps/api/src/scripts/import-openings.parity.test.ts` together assert byte-identical normalization between importer and lookup.

Server endpoints: `GET /openings?q&eco&limit`, `GET /openings/by-fen/:fenKey`, and `POST /openings/identify-deepest` (path-walk lookup in one round trip). Shared helpers `identifyOpening` and `identifyDeepestOpening` live in `packages/shared/src/openings.ts` so client and server share one matcher. Client-side: `useOpeningId(fen)` and `useDeepestOpeningId(path)` hooks with 80 ms debounce and a process-wide in-memory cache.

### Phase 6 — Opening database browser + auto-naming ✅ done

New top-level view `BrowseOpenings` (top-nav button "Browse openings"). Search box + ECO letter chips (A–E) + free-form ECO code filter, debounced; results group by base name with the bare line first, then alphabetical variations. Clicking any opening loads its position on the board and replays `pgn_moves` into a local SAN list; free move-play extends the line and a breadcrumb / back / start let the user jump.

Auto-naming via reusable `OpeningHeader` component (uses `useDeepestOpeningId`) — refines as the user steps deeper (e.g. "Caro-Kann Defense" → "Caro-Kann Defense, Advance Variation") and suffixes "…" when the current FEN is off-book but an ancestor is known. The header is mounted in both the browser AND the `RepertoireEditor`.

One-click **"Add to my repertoire"** modal — pick an existing repertoire OR create a new one (the name input prefills with the deepest matched opening, editable). Commits the navigated SAN list via a new `POST /repertoires/:id/moves/batch` endpoint (service: `appendLine`) that walks the line in a single transaction, idempotent on `(parent_position, san)` — verified end-to-end: first commit `added: N reused: 0`, re-run `added: 0 reused: N`. New SRS cards are auto-created for any newly-inserted move on the user's turn.

---

### Phase 7 — The walker: build + drill as one loop ✅ done

Implemented. Surface area:
- New top-level `WalkerSession` view with two seeds (Build / Drill), reached via per-repertoire "Build" and "Drill (walker)" buttons in `RepertoireList` and `RepertoireEditor`. The pre-existing single-repertoire drill remains accessible as "Classic drill" (it will be retired or merged in Phase 8).
- `lib/walker/walker.ts` — pure BFS-from-root that returns the shallowest position needing attention (user-prep OR opponent-picks), naturally giving round-robin across branches at the same ply depth. Skips dropped moves and their subtrees. Includes `findNextBuildNodeFrom` for "Keep building this branch" after drill-pauses-for-build, `computeCoverage` for the walker header stats, and `pickOpponentReplyForDrill` for most-due-child branch selection. Unit-tested in `walker.test.ts`.
- **Drill-pauses-for-build:** when the Drill seed plays an opponent reply and lands on an unprepped user-turn position, the panel slides into "New prep — fill this gap" without leaving the session. After save: a "Keep building / Back to drill" prompt (default = Back to drill).
- **One prep per user-turn position** is enforced server-side by `enforceOnePrepPerUserPosition` and covered by `repertoires.invariant.test.ts`. The walker UI catches 409 and offers an explicit swap confirmation.
- **Drop branch:** new `is_dropped` boolean column on `moves` (migration `0003_drop_branch.sql`), surfaced via `patchMove({ isDropped })`. UI: per-response Drop in the walker's opponent-picks panel, a Drop/restore button in the editor's candidate-moves list, and a "Dropped branches" panel in the walker's sidebar with one-click undrop. `buildDrillQueue` and the walker's BFS both treat dropped moves as if they don't exist.
- **Opening name header** in the walker (reuses `OpeningHeader` + `useDeepestOpeningId` from Phase 6) — refines only when the *name* changes between plies.


Collapse build and drill into a **single walker session** over the position-keyed tree. The walker steps node-by-node; what it does at each node depends on (a) whose turn it is and (b) whether the user has prepped it. Build vs drill are not separate UIs — they're different **seeds** into the same walker. This phase delivers the §1 core flashcard loop end-to-end and turns the existing Phase 3 drill into one specific entry point of the walker.

#### Two entry points, one UI

Top-nav exposes two buttons: **Drill** and **Build**. Both open the same view (board left, one contextual right-panel). Only the queue seed differs:

- **Drill** seeds with FSRS-due cards (oldest-due first). When the walker hits an unprepped node, the panel slides into build mode for that one node, then resumes the drill queue.
- **Build** seeds at the shallowest uncovered position in the chosen repertoire. Walks the tree round-robin (breadth-first across branches). When the walker hits a node already prepped, the panel slides into drill mode for that one node, then continues building.

Either seed converges to the same four panel states. The user does not switch modes — the panel adapts to the current node.

#### Four panel states

| State | Node condition | Panel shows |
|---|---|---|
| **Your move — build** | User turn, no prep saved | *"What's your move?"* + book continuations as one-click suggestions + free play on board + skip-branch link |
| **Your move — drill** | User turn, prep exists | Bare board; user produces the move; auto-graded (correct = Good, wrong = Again) |
| **Choose responses — build** | Opponent turn, no branches saved | Multi-select list of book continuations with names + free legal move + skip |
| **Opponent replies — drill** | Opponent turn, ≥1 branch saved | Auto-plays one saved response — drill seed: **most-due-child**; build seed: **round-robin next** |

The right-panel header shows the auto-identified opening (only updates when the *name* changes, e.g. entering Winawer — not on every ply), plus a small tree map of in-flight vs uncovered branches with progress like "Branch 3 of 5 at ply 5."

#### Two distinct gestures (keep visually distinct)

- **Navigate** (click an entry in the saved-tree sidebar or use a PGN step button): moves the board to an existing position. Does **not** create or change a card.
- **Set as prep** (play a move on the board from the current position via drag / click-click, OR click a suggested book continuation in the prompt panel and confirm it): saves a `Move` row against the current parent position. On the user's turn this also creates an SRS card. On the opponent's turn it opens that response as a new branch the walker will visit. The gesture is what makes it prep — book-ness is irrelevant.

#### New repertoire

From a "New repertoire" button (top nav), the user picks a side (White / Black) and a base opening using the Phase 6 browser modal. The base can be a top-level opening (e.g. "French Defense" → 2-ply auto-insert) or a deep variation (e.g. "King's Indian, Sämisch" → 9-ply auto-insert). The opening's canonical `pgn_moves` are auto-inserted into the tree via the existing `appendLine` service, with cards auto-created for each user-side move in that prefix. The Build session opens at the position after the prefix. (The pre-existing Phase 2 "blank repertoire from scratch" flow stays.)

#### Round-robin descent — worked example ("French as White")

Auto-insert puts `1.e4 e6` in the tree and creates the `1.e4` card. Build opens at the post-`1...e6` position.

1. **Ply 1 (user):** *"Move after 1...e6?"* → `2.d4` → card #2.
2. **Ply 2 (opp), pick:** `2...d5` + `2...c5` → two branches open.
3. **Ply 3 (user, both branches in turn before going deeper):**
   - Branch A `2...d5` → `3.Nc3` → card #3.
   - Branch B `2...c5` → `3.d5` → card #4.
4. **Ply 4 (opp, both branches):**
   - A picks `3...Nf6, 3...Bb4, 3...dxe4` → 3 sub-branches.
   - B picks `3...e6, 3...Nf6` → 2 sub-branches.
5. **Ply 5 (user):** cycle through all 5 leaves, prompting for each.
6. ... and so on.

Property: at any stop point you have *some* coverage at every branch — never "deeply prepped against one defense, zero against another."

#### Drill-pauses-for-build pattern

When the Drill seed lands on an unprepped position (typically because an opponent reply branches into a line you covered earlier and didn't fill in):

1. The card that led here is graded as usual.
2. Opponent auto-plays the next saved move (or none if none exists).
3. If the resulting node has no user-side prep, the panel becomes **"Your move — build"** with a soft "New prep" label — no modal, no mode switch animation.
4. User adds the move; an SRS card is created.
5. The walker prompts once: *"Keep building this branch?"* — defaults to **"Back to drill"** (finish today's due queue first; the new branch will surface in the next Build session). "Keep building" descends into the new branch round-robin until the user exits.

This is what makes the walker continuous: gaps in coverage get discovered through normal use, and filling them costs one click and one move.

#### Default decisions (locked in for v1)

- **Skip granularity:** the skip button defers the prompt to next session (it resurfaces). A separate **"Drop branch"** action with confirmation marks a branch "won't cover" — never resurfaces.
- **Drill weighting at branched opponent nodes:** most-due-child wins (drilling effort tracks forgetting).
- **Opening name guidance density:** show the name only when it *changes* between plies, not on every move.

#### Important behaviors

- A book move only becomes a card if the user has explicitly set it as prep. Browsing book continuations alone never creates cards.
- For opponent-turn positions, **only the responses the user selected** are saved into the tree. The rest are not part of the repertoire and won't trigger drills. (Gaps are filled by Phase 9's growth loop and surface again in Phase 10's opponent scouting.)
- Respect the existing per-repertoire "test all branches vs main-line-only" rule when building the drill queue.
- **Coverage status is derived, not stored.** Any opponent-turn position whose children set is empty = uncovered. No new column on `Position`; the walker computes this.
- **One prep move per user-turn position in v1 — application-level invariant, NOT a DB constraint.** `srs_cards.uniq_user_move` is on `(user_id, move_id)` (one card per Move row); `moves.uniq_parent_san` is on `(repertoire_id, parent_position_id, san)` (no duplicate SAN from one parent, but multiple distinct SANs allowed). The walker / `appendLine` service must check before inserting a user-side Move: if one already exists from this parent, refuse the insert or apply the swap path below. Add an integration test that hits this path directly so a future refactor cannot silently allow two prep moves per position.
- **Changing a prep move** (e.g. swap `4.Bg5` for `4.e5`): delete the old user-side Move (cascade removes its SrsCard) and insert the new one. The new card starts in FSRS `state='new'` — SRS history of the old move is **not** preserved through a swap in v1. (If preserving it matters: detach card from old Move, repoint `move_id` to new Move, then delete old Move. Spec doesn't require this in v1 — flag the decision if you hit it.)
- To prep two alternative systems against the same line, create separate repertoires. (v2 `option_label` will let one repertoire hold both — see below.)
- **Future (parked, not in v1):** support multiple labeled prep options per position — e.g. a *blitz* move (fast, sharp), a *classical* move (solid, deep), a *must-win* move (sharpest, accepts risk), a *draw-is-enough* move (safest). Each option would be its own card; the walker picks the active label. This requires relaxing `uniq_user_move` to `uniq (user, move, option_label)` and adding an `option_label` column to `Move`. Do **not** build this in Phase 7; capture the intent here so the v1 schema doesn't paint us into a corner — keep the constraint as-is, but avoid any code that assumes "one row per `(user, parent_position)`" beyond the constraint itself.

**Done when:**
- Create a "French as White" repertoire. Auto-insert puts `1.e4 e6` in the tree and creates the `1.e4` card.
- Open **Build**: walker opens at the post-`1...e6` position; panel shows "Your move." Play `2.d4`. Panel shows "Choose responses." Pick `2...d5` and `2...c5`. Walker round-robins — prompts "Your move" on the `2...d5` branch, then on the `2...c5` branch, before either descends deeper.
- After building several user-side cards, open **Drill**: walker pulls the first due card; opponent replies auto-play; if the walker reaches an unprepped node, the panel slides into "Your move — build" without leaving the session, and after the user adds the move the "Keep building / Back to drill" prompt appears (defaulting to back-to-drill).
- Drop a branch via the explicit "Drop branch" action with confirmation; verify it never resurfaces in either seed.

---

### Phase 8 — Daily diet + engine gating ✅ done

Both halves shipped together. Surface area:
- **8a Daily diet:** new top-nav "Daily" button → `DailyDiet` page. Scope picker (White / Black / Mixed), per-user `new_cards_per_day` cap with inline editor. Pulls full snapshots for every matching repertoire, builds a per-rep due-card queue via the existing `buildDrillQueue`, then **interleaves by repertoire round-robin** so consecutive cards typically come from different openings (`buildDailyDietQueue` in `lib/drill/queue.ts`). New-card cap counts only `state===new` cards; state=learning/review/relearning are unconditionally included. Session UI mirrors the flow-mode drill (auto-grade on attempt). End screen breaks accuracy down per repertoire so the weakest opening of the day is visible.
- **`UserSettings`:** new table (migration `0004_user_settings.sql`), service in `services/userSettings.ts`, route at `GET/PATCH /settings`. Get-on-first-read seeds defaults. Tracked: `newCardsPerDay` (default 20) and `dailyDietLastResetAt` (used as the "today" boundary for the new-card cap so a mid-session reload doesn't double-count).
- **8b Engine gating:** hard guarantee at the engine **module** level (`Engine.setGated(true)`). While gated, `analyze()` is a no-op AND any in-flight analysis is `stop`-ed. `DrillSession` and `DailyDiet` flip the gate on for their mount lifetime and back off on unmount. `WalkerSession` gates **per phase** rather than per mount: build phases (`attention`, `drill-paused-for-build`) run the engine — eval bar, MultiPV lines, and suggested-move arrows on the board (`lib/engine/arrows.ts`, drawn via Chessground shapes) — because there is no card answer to leak while the user is authoring prep; every drill phase re-gates the module. `useEngine` accepts a `gated` prop for the same flow. Eval is now also wired into the opening browser per spec. Unit test in `engine.test.ts` (`setGated`) asserts that gated `analyze()` emits ONLY `stop` and never `go`.


Two things that ship together because they're the user's actual day-one loop.

#### 8a · Daily diet (mixed session)

A single daily session that mixes due cards across all of the user's repertoires. Mechanically, this is the **Drill-seed walker** (Phase 7) with its source set to every repertoire matching the chosen side, rather than a single repertoire.

- The only thing the user selects is scope: **White**, **Black**, or **Mixed**.
- The Drill seed pulls all due SRS cards (per FSRS) across every matching repertoire, **interleaves them so consecutive cards come from different openings where possible** (round-robin by repertoire/opening, not pure shuffle), and feeds them to the walker as one continuous run.
- Each card behaves like any other walker drill node: show the position, user produces the move, FSRS grades it. Drill-pauses-for-build still applies — if the walker hits an unprepped node mid-session, the panel slides into build mode for that one node.
- Show lightweight session progress (cards done / remaining, today's streak). At the end, show a short summary (accuracy, which openings were weakest today).
- "Mixed" simply unions the White and Black due-card pools.
- **New-card cap:** add a per-user setting `new_cards_per_day` (default 20). Cards in FSRS `state === 'new'` enter the daily diet only up to this cap; the rest stay queued. Without this, freshly built repertoires flood the first sessions.

This generalizes the existing single-repertoire drill — refactor `buildDrillQueue` so it can take a list of repertoires, or build a thin wrapper that calls it per repertoire and round-robins the results.

#### 8b · Engine hidden during drilling

Stockfish analysis available everywhere **except** while a flashcard is unanswered.

- In browse / build / free-analysis modes: eval bar, top engine lines (MultiPV), and the top 3 suggested moves as board arrows (best = green, then blue / yellow), via the existing Web Worker. The user can analyze any position freely. ✅ wired in the repertoire editor, the opening browser, and the walker's build phases.
- In **drill / daily-diet mode:**
  - While a card is awaiting the user's move, no eval bar, no engine lines, no hints — nothing that reveals the answer.
  - After the user submits and it's graded, the engine view may be revealed, gated behind the per-repertoire `evalAfterAnswer` rule (already in `DrillRules`). If off, stay hidden for the whole session.
- **Hard guarantee:** add a `gated: boolean` flag at the Engine layer (the singleton in `apps/web/src/lib/engine/engine.ts`). When `gated`, `analyze()` is a no-op and any in-flight analysis is immediately `stop`-ed. `useEngine` exposes this so DrillSession can flip it on for the active card and off after reveal. This way there is no DOM panel to peek at and no worker chatter to inspect — the engine is not running.

**Done when:** a daily-diet White session pulls due cards from multiple white repertoires, interleaves them, respects the new-card cap, and the engine is provably idle (`analyze` not called) during an unanswered card. After answer + grade + `evalAfterAnswer=true`, the eval shows up.

---

### Phase 8c — Navigation & flow polish ✅ done

UX pass driven by daily use ("hard to navigate, hard to create"). Surface area:

- **Line context everywhere:** walker and daily sessions now load the board by
  **replaying the move path from the repertoire root** (`findPathToPosition` in
  `lib/walker/walker.ts`) instead of snap-loading FENs. `rules.history` is
  therefore the true current line, which drives a SAN move list
  (`components/MoveLine.tsx`) above the board, the full-path deepest-opening
  lookup (fixes the old shallow 2-position path in drill mode), and the
  last-move highlight that makes branch jumps legible.
- **Retrain on wrong answer** (walker drill + daily diet): a miss grades Again,
  briefly shows the correct move on the board, takes it back, and requires the
  user to physically play it before the session advances.
- **Walker fixes:** "Skip for now" actually works (session-local exclude set
  threaded into `findNextBuildNode` — previously the skip set was never
  consulted); prep-swap 409 confirmation is inline in the panel (no
  `window.confirm`); "won't cover" is a per-row button on each book
  continuation (the SAN-typing drop input is gone); opponent responses can be
  added one-click (click the row) or batched (checkboxes); keyboard shortcuts
  (`s` skip, `↵` back-to-drill, `b` keep building).
- **Daily-first home:** the repertoire list opens with a "Today" banner (total
  due cards → start daily session) and per-repertoire badges (due / cards /
  to-build) computed offline-first from IndexedDB (`lib/repStats.ts`). Cards
  show two primary actions (Drill, Build) with everything else (Edit, Classic
  drill, Health check, Export PGN, Rename, Delete) in an overflow menu.
- **Creation flow:** ONE "New repertoire" button routes to the opening browser
  — pick a line on a real board, "Add to my repertoire" → create new →
  "Start building" jumps straight into the walker. Blank + Import PGN live as
  secondary actions (browser header / list header). The old search-in-a-modal
  guided create is gone.
- **Hash routing** (`lib/router.ts`): view state syncs with `location.hash`
  (`#/walker/:id/build`, `#/daily`, …) so browser back/forward, refresh, and
  bookmarks work. Deep links to repertoire views load the repertoire first
  (`store.loadRepertoire`).

Still open (deliberately deferred): merging the three drill implementations
(classic `DrillSession`, walker drill seed, `DailyDiet`) into one
multi-repertoire walker — see Phase 8a note; classic drill remains reachable
via the card overflow menu until then.

### Phase 9 — Repertoire growth & line scopes 🚧 in progress (9a, 9b, 9c ✅ done; 9d all but shadow lines)

Two asks that are one feature: an opening should hold all its branches yet be
drillable one line at a time, and building should happen *inside* drilling
instead of being hand-authored line by line. They join because auto-growth is
what makes the tree big enough to need scoping, and scoping is what makes
auto-growth safe to enable — and because both happen on the same write: a move
created by the growth loop is labeled at insert time.

Full design, including the failure modes each rule prevents:
**[knowledge/03-domain/repertoire-growth.md](knowledge/03-domain/repertoire-growth.md)**.
Summary:

- **Line scopes.** A line is a *predicate*, not a stored object — copying the
  tree would let the copy drift. Two kinds: **derived** from the ECO deepest-name
  path walk (zero authoring cost, covers "only the Advance Variation"), and
  **explicit** `moves.line_tags` inherited from the parent edge on insert (for
  what the book can't express — `vs-danny`, `blitz-only`). `DrillRules` gains
  `scope: { kind: 'all' | 'openingName' | 'tag', value? }`, read through
  `mergeDrillRules()` and honored by both queue builders and the build seed.
- **Candidate sources, one job each.** ECO book → naming and shallow breadth
  (bundled, no frequency, dries up ~ply 8–10). Lichess opening explorer →
  *which opponent replies matter*, via frequency and W/D/L, cached in
  `explorer_entries` (a cache, never a source of truth — sessions must work with
  it cold). Stockfish → *the user's own move*, in the already-ungated walker
  build phase. Selection logic lives in `packages/shared` with tests.
- **The growth loop.** Opponent branches auto-expand silently (they carry no SRS
  card, so widening the frontier is free); the user's move always prompts, but
  with candidates pre-ranked one click away. `newCardsPerDay` stays the only
  throttle. Opt-in per repertoire, and it must never re-add a dropped branch.
- **Mistake rehearsal.** A `drill_attempts` log gives a recency-weighted
  `mistakes` drill mode (it shipped as a `DrillMode` value rather than a scope —
  scope filtering already runs first, so the two compose for free),
  **interference detection** (the played SAN is the correct prep at a *different*
  position — the common transposition confusion, nearly free from the existing
  index), and optional refutation shadow lines that are stored but never prep and
  never carded. The shadow lines are **not built**.

Sub-phases: **9a** scopes ✅ **done** — `moves.line_tags` (migration `0005`) with
inherit-on-insert, `DrillRules.scope`, filtering in `buildDrillQueue` /
`buildDailyDietQueue` / the walker build seed, an offline opening-name cache, and
UI in drill setup + the editor · **9b** explorer cache +
ranking ✅ **done** — `explorer_entries` (migration `0006`), a read-through lichess
client that never throws and backs off on 429, `GET /explorer/:fenKey`, and the pure
selection policy in `packages/shared` (consumed by the 9c build prompt) ·
**9c** auto-expand + candidate UI + frontier prefetcher ✅ **done** — opt-in
`repertoires.auto_expand` (migration `0007`); auto-expansion never re-adds a dropped
branch and refuses to write from book-ordered candidates (only real frequencies
authorize a silent write) · **9d** mistake rehearsal 🚧 — `drill_attempts`
(migration `0008`) written by all three drill implementations and held locally in
IndexedDB so the mode works offline, the recency-weighted `mistakes` drill mode,
and interference detection surfaced on every miss. **Refutation shadow lines and
weakness-steered growth are not built.**

The 9b fetch/aggregate/frequency-per-fenKey plumbing is the same as Phase 10
needs, which is why growth now comes before scouting.

### Phase 10 — Opponent scouting ⏸ parked (was Phase 9; originally old Phase 5)

Headline differentiator from Lotus, but explicitly deferred — the four features above are the new MVP. When unparked:

- Fetch opponent games by username + filters from Lichess (`/api/games/user/{u}`, NDJSON) and Chess.com (archives endpoint, monthly).
- Aggregate into `OpponentPosition`/`OpponentMove` keyed by normalized FEN with frequency and W/D/L per move.
- Frequency heatmap: Chessground arrows where width/opacity ∝ how often the opponent played the move, color by their score (green = scored well, red = scored poorly).
- Gap finder: positions where the opponent meets the user's repertoire but has little experience or a poor score.

Notes for the future builder: Chessground's shape API takes `{ orig, dest, brush }`; define custom brushes for graded widths/colors and map frequency → brush, score → color. Stream Lichess NDJSON with `Accept: application/x-ndjson` + a descriptive User-Agent, back off on 429. Chess.com: hit the archives endpoint first, then fetch monthly URLs sequentially.

### Phase 11 — Polish ⏸ parked
Stats dashboard (retention per line, weakest openings, drill streaks, due-card forecast). Full PWA offline pass, install prompts, background sync. Optional Capacitor wrap for app stores.

---

## 6. Implementation notes & gotchas

- **Stockfish + COOP/COEP:** `stockfish.wasm` with threads needs cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). Configure in Vite dev and production hosting, or fall back to single-threaded. ✅ handled.
- **Chessground styling:** Chessground ships its own CSS and needs piece sprites; import its base CSS and a piece set, give the board container an explicit size or it renders 0×0. ✅ handled.
- **FEN keying parity:** `packages/shared/src/fen.ts` is the single source of truth. The opening DB importer MUST run every TSV row through `fenKey()` before persisting, and `/openings/by-fen/:fenKey` MUST treat the path param as already-normalized (no re-parse). Add a test that loads a few known ECO lines, plays them out on chess.js, normalizes via `fenKey()`, and asserts the DB row matches — this catches whitespace/encoding drift.
- **Deepest-name lookup:** identify the line by walking the path from the root and keeping the **last** non-null match. Don't look up only the current FEN — there are positions reachable by transposition whose immediate FEN isn't in the book but whose ancestors are.
- **Drill ↔ Engine isolation:** the gating flag must live at the engine module, not just in the panel component. A future feature must not be able to "enable engine for the editor" and accidentally leak it into a drill running in another tab/route.
- **New-card cap accounting:** count "new cards shown today" by `last_reviewed` crossing the daily reset boundary (per `UserSettings.daily_diet_last_reset_at`), not by a separate counter — keeps it crash-safe.
- **FSRS:** persist all FSRS card fields, not just due date, or rescheduling breaks. ✅ schema does this.
- **Sync conflicts:** last-write-wins by `updatedAt` on SrsCards. ✅ already implemented in `mergeCardsLocal`.

---

## 7. Suggested milestone for "usable by the owner"

End of **Phase 8** is the real MVP for the new direction — opening-grounded repertoires, a daily mixed drill, and an engine that never spoils a card. **Phase 8 is now done.** Phases 9–11 are additive and can be built while already using the tool daily.

The Phase-3 single-repertoire drill (already shipped) is usable today; Phases 5–8 make it materially better and resolve the "Lotus gap" around opening identity and daily-diet ergonomics.
