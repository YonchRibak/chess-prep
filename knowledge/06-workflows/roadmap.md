# Roadmap & status

Full detail in [PROJECT_SPEC.md](../../PROJECT_SPEC.md) §5. This is the summary an agent
needs to know what exists before proposing work.

Legend: ✅ done · ⏸ parked

## Shipped

| Phase | What landed |
|---|---|
| **0** ✅ | Monorepo skeleton — pnpm workspaces, Vite/React/Tailwind, Hono/Drizzle/Postgres |
| **1** ✅ | Interactive board — Chessground + chess.js, `useChessRules`/`useBoard`, undo/redo, flip, FEN load, check/mate/stalemate |
| **2** ✅ | Repertoire CRUD + PGN — position-keyed tree, transposition collapse, tree editor, comments/annotations/main-line/priority, PGN import (variations + NAGs + comments) and export, tags |
| **3** ✅ | Drill engine + SRS — FSRS grading, IndexedDB offline, push-queue sync, drill modes `due`/`walkthrough`/`weak`/`random`, per-repertoire rules, flow mode |
| **4** ✅ | Engine layer — Stockfish Worker + UCI, `useEngine`, EnginePanel, repertoire health check |
| **5** ✅ | Opening DB foundation — vendored lichess ECO TSVs, importer CLI, endpoints, shared matcher, client hooks with debounce + cache |
| **6** ✅ | Opening browser + auto-naming — `BrowseOpenings`, `OpeningHeader`, "Add to my repertoire" via idempotent `appendLine` |
| **7** ✅ | **The walker** — build + drill as one loop, drill-pauses-for-build, one-prep invariant, drop-branch, coverage stats |
| **8a** ✅ | Daily diet — scope picker, round-robin interleave across repertoires, `new_cards_per_day` cap, `UserSettings` |
| **8b** ✅ | Engine gating — module-level `setGated`, per-phase gating in the walker, arrows + eval in build phases |
| **8c** ✅ | Navigation & flow polish — path-replay board loading, `MoveLine`, retrain-on-wrong-answer, working skip, inline 409 swap, daily-first home, single creation flow, hash routing |

**End of Phase 8 is the real MVP** and it is reached. Everything below is additive.

## Known debt (deliberately deferred)

- **Three drill implementations** — classic `DrillSession`, the walker's drill seed, and
  `DailyDiet` are separate code paths. Merging them into one multi-repertoire walker is
  the intended endgame; classic drill stays reachable via the repertoire card's overflow
  menu until then. See [srs-drilling](../03-domain/srs-drilling.md#three-drill-implementations-known-debt).
- **One-prep invariant has no DB constraint** — hardening it to a partial unique index
  needs a stored `is_user_side` column on `moves`, deferred to the v2 `option_label` work.
- **No auth** — single-user via `DEFAULT_USER_ID`.
- **No component/E2E tests.**

## Parked

### Phase 9 — Opponent scouting ⏸
The headline differentiator from Lotus, explicitly deferred. When unparked:
- Fetch opponent games by username + filters from Lichess (`/api/games/user/{u}`, NDJSON)
  and Chess.com (archives endpoint, then monthly URLs sequentially).
- Aggregate into `OpponentPosition` / `OpponentMove` keyed by normalized FEN, with
  frequency and W/D/L per move.
- Frequency heatmap via Chessground arrows — width/opacity ∝ frequency, color by score.
- Gap finder: positions where the opponent meets the user's repertoire but has little
  experience or a poor score.

Notes for whoever builds it: Chessground shapes take `{ orig, dest, brush }`, so define
custom brushes for graded widths/colors. Stream Lichess NDJSON with
`Accept: application/x-ndjson` and a descriptive User-Agent; back off on 429.

The TypeScript types already exist in
[packages/shared/src/types.ts](../../packages/shared/src/types.ts) — **but there are no
tables and no code paths.**

### Phase 10 — Polish ⏸
Stats dashboard (retention per line, weakest openings, drill streaks, due-card forecast),
full PWA offline pass, install prompts, background sync, optional Capacitor wrap for app
stores.

## v2 idea worth not blocking

**Multiple labeled prep options per position** — a *blitz* move, a *classical* move, a
*must-win* move, a *draw-is-enough* move, each its own card, with the walker picking the
active label. Needs an `option_label` column on `moves` and relaxing `uniq_user_move` to
`(user, move, option_label)`. **Do not build it** — but avoid code that assumes "one row
per `(user, parent_position)`" beyond the constraint itself.
