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
| **9a** ✅ | Line scopes — `moves.line_tags` with inherit-on-insert, `DrillRules.scope` (`all` / `openingName` / `tag`), honored by both queue builders and the walker's build seed, offline opening-name cache, scope picker in drill setup and a tag field in the editor |
| **9b** ✅ | Explorer cache + ranking — `explorer_entries`, the lichess read-through client (never throws, backs off on 429), `GET /explorer/:fenKey`, and the pure candidate-selection policy in `packages/shared` |
| **9d** ✅ | Mistake rehearsal — `drill_attempts` (migration `0008`), logged by all three drill implementations, the recency-weighted `mistakes` drill mode, interference detection on every miss, and refutation shadow lines (`moves.is_refutation`, migration `0009`): stored, never carded, never walked, never exported |
| **9c** ✅ | Growth loop — opt-in `repertoires.auto_expand`, silent opponent expansion (never re-adds a dropped branch, never writes from book order), engine+explorer candidates in the build prompt, idle frontier prefetcher |

**End of Phase 8 is the real MVP** and it is reached. Everything below is additive.

## Flow phases (F1–F4)

Restructuring the app around intent instead of mechanism — see
[FLOW_PROPOSAL.md](../../FLOW_PROPOSAL.md) and
[FLOW_IMPLEMENTATION_PLAN.md](../../FLOW_IMPLEMENTATION_PLAN.md). Lettered to avoid
colliding with parked Phases 10/11.

| Phase | Status | What it is |
|---|---|---|
| **F1** ✅ | Session-scoped line scope (the stored scope demoted to default; daily-diet footgun killed) + line navigator (`#/lines/:id/train\|grow`) with per-line badges |
| **F2** ✅ | Guided prepare: `#/prepare` wizard, `PrepTarget` presets, line-first traversal (`findNextBuildNodeLineFirst`), session-forced auto-expand, lock-in micro-rehearsal, structural coverage-to-target meter |
| **F3** ✅ | Bundled explorer snapshot (`explorer_snapshot_entries` tier + generator/importer — the frequency floor for the dev-401 machine) + game-weighted coverage (`shared/coverage.ts`, meter upgrade). The snapshot JSONL itself still needs one `snapshot:build` run from a machine that can reach the explorer |
| **F4** ✅ | Smart default Train queue (`buildSmartQueue`, walker drill seed default with the five modes behind an "advanced" disclosure) + home re-org (Today · Prepare against… · Train/Grow cards; nav = Repertoires · Today · Prepare) + terminology pass (Build→Grow, Drill→Train in user-facing copy only) |

## Known debt (deliberately deferred)

- **Three drill implementations** — classic `DrillSession`, the walker's drill seed, and
  `DailyDiet` are separate code paths. Merging them into one multi-repertoire walker is
  the intended endgame; classic drill stays reachable via the repertoire card's overflow
  menu until then. See [srs-drilling](../03-domain/srs-drilling.md#three-drill-implementations-known-debt).
  *Smaller since F4:* the walker's default Train path no longer needs a mode picker
  page — the smart queue replaced that surface — so consolidation now only has to
  absorb classic drill's blindfold/walkthrough rendering and the diet's multi-rep
  interleave.
- **One-prep invariant has no DB constraint** — hardening it to a partial unique index
  needs a stored `is_user_side` column on `moves`, deferred to the v2 `option_label` work.
- **No auth** — single-user via `DEFAULT_USER_ID`.
- **No component/E2E tests.**

## Next up

**Phase 9 is complete.** The remaining candidate from the 9d design is
**weakness-steered growth** — using the attempt log to expand the frontier where the user
is weak rather than uniformly. Nothing is built for it; the log it would read
(`drill_attempts`) already exists, so it is a policy change in the walker's build seed,
not new plumbing. Design note in
[repertoire-growth](../03-domain/repertoire-growth.md#mistake-rehearsal).

## Study flow (S1–S5)

Preparation moves to lichess studies; the app rehearses them. Detail in
[study](../03-domain/study.md).

| Phase | Status | What it is |
|---|---|---|
| **S1** ✅ | Shared parsing (`study.ts`): chapters → line tags, main-line-only hero prep policy with demoted alternates, live reachability |
| **S2** ✅ | API: `repertoires.source` (migration `0011`), `POST /repertoires/import-study` + `POST /repertoires/:id/import-study` — a diff-based re-sync that keeps SRS history |
| **S3** ✅ | Web: Studies home as the default landing (`#/`; repertoire list → `#/repertoires`), upload/update modal with the sync summary, note-on-miss pause in all three drill implementations |
| **S4** ✅ | Study browser (`#/study/:id`: shared `TreeView`, note on the current move, eval + Rashid probe off by default, keyboard stepping) and the Rashid study scan (`store/rashidScan.ts`: outlives the view, alternates included, findings list, cache reload) |

| **S5** ✅ | One-click chapter rehearsal (`#/rehearse/:id/:chapter`: shuffled hero moves, stub cards, animated line transitions, hint/skip/note/retry, summary, resume), Expand variations (uncovered opponent replies → record your move, engine hidden by default), and `moves.origin` (migration `0012`) so those extensions survive re-import (kept / adopted / demoted / removed) |

Debt introduced: whole-study export is still single-game (`exportPgn` unchanged);
demoted alternates share `is_dropped` with the user's own drops (see study.md for the
`prep_role` escape hatch); S5 is a **fourth drill implementation** — the extracted
`missFlow.ts` / `useLineTransition` are the consolidation path and the older three have
not adopted them yet.

## In progress — Rashid (trap-finding layer)

An analysis layer that finds moves forcing the opponent onto a chain of "only moves"
and scores them Risk/Reward/Length. Spec at [rashid-engine-spec.md](../../rashid-engine-spec.md),
phased plan at [rashid-dev-plan.md](../../rashid-dev-plan.md), status detail in
[rashid.md](../03-domain/rashid.md).

| Phase | Status |
|---|---|
| **R1** ✅ | Domain core in `packages/shared/src/rashid.ts` — only-move detection, lazy walk, ranking — fully unit-tested against a scripted fake engine |
| **R2** ✅ | Engine adapter (`rashidAdapter.ts`: sequential queue, gate fail-fast, engine-id capture) + cache layer A (`rashidRaw` IndexedDB store, db v4) |
| **R0** ✅ | Measured (rashid-dev-plan.md §R0 results): ~350ms per 300k-node pv4 search, ~3s/position, MultiPV width free at fixed nodes → **in-browser precompute confirmed**, budgets 1M precompute / 300k live. Caveat: the wasm engine is classical-eval (not NNUE) — it undervalues speculative sacs, the very moves Rashid hunts |
| **R3** ✅ | Live probe on a dedicated engine (`rashidLive.ts`, singleton-gate-aware) + cache layer B (`rashidResults`, db v5, config-keyed) + `RashidPanel` in the editor (data only, off by default) + the "why not" candidate trace |
| **R4** ✅ | Board arrows (`rashidArrows.ts`): hue = risk band via custom brushes, thickness = reward floor, badge = length; pale runners-up capped at 2; Rashid-vs-engine arrow-mode precedence in the editor |
| **R5** ✅ | Background precompute (`rashidPrecompute.ts`): BFS-priority over hero positions on a third engine instance, pauses while drilling, resumable via the caches (no invalidation needed — they're position-keyed); live probes prefer precompute-tier entries. Progress UI in the RashidPanel |
| **R6** | Not started — tuning pass + triviality filter (the lab's knobs and why-not trace are its instruments) |

## Parked

### Phase 10 — Opponent scouting ⏸
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

### Phase 11 — Polish ⏸
Stats dashboard (retention per line, weakest openings, drill streaks, due-card forecast),
full PWA offline pass, install prompts, background sync, optional Capacitor wrap for app
stores.

## v2 idea worth not blocking

**Multiple labeled prep options per position** — a *blitz* move, a *classical* move, a
*must-win* move, a *draw-is-enough* move, each its own card, with the walker picking the
active label. Needs an `option_label` column on `moves` and relaxing `uniq_user_move` to
`(user, move, option_label)`. **Do not build it** — but avoid code that assumes "one row
per `(user, parent_position)`" beyond the constraint itself.
