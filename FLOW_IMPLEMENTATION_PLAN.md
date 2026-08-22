# Flow Implementation Plan

Implements [FLOW_PROPOSAL.md](FLOW_PROPOSAL.md). Four phases, **F1–F4** (the letter
avoids colliding with parked Phases 10/11 in [PROJECT_SPEC.md](PROJECT_SPEC.md)).
Ordering follows the proposal's feel-per-effort ranking: F1 fixes the Winawer problem
and the daily-diet footgun with zero new domain logic; F2 is the guided-prepare
headline; F3 gives it a data floor; F4 is consolidation and cosmetics.

Every phase ends with `pnpm typecheck && pnpm lint && pnpm test` green, its
knowledge-base updates **in the same commits as the code**, and one branch per phase
(`feat/flow-f1-session-scope`, etc.). Per standing debt, any drill-behavior change is
checked against **all three drill implementations**
([srs-drilling.md](knowledge/03-domain/srs-drilling.md#three-drill-implementations-known-debt)).

---

## F1 — Session scope + line navigator

**Goal:** "drill only the Winawer tonight" is two taps, session-local, and can no
longer silently reshape the daily diet.

### F1.1 Session-scoped scope override

The queue builders need **no signature change**: `buildDrillQueue` already receives
`rules` ([queue.ts:32](apps/web/src/lib/drill/queue.ts#L32)), so a session scope is
just the caller passing `{ ...mergeDrillRules(rep.drillRules), scope: sessionScope }`.
The work is threading the session value to those callers:

1. **View union** ([store/app.ts:15](apps/web/src/store/app.ts#L15)): add optional
   `scope?: LineScope` to `walker-session` and `drill-session`.
2. **Hash routing** ([lib/router.ts](apps/web/src/lib/router.ts)): encode as an
   optional suffix — `#/walker/:id/:seed?scope=openingName:Caro-Kann%20Defense` /
   `?scope=tag:vs-danny`. `hashToView` parses through the existing `parseLineScope`
   ([scope.ts:135](packages/shared/src/scope.ts#L135)); a malformed scope param is
   treated as **absent** (session falls back to stored rules), keeping
   `viewToHash`/`hashToView` total. Round-trip test alongside the existing routing
   tests. Deep-link refresh preserving the scope is the point of putting it in the
   hash rather than only in store state.
3. **WalkerSession** ([WalkerSession.tsx:324-335](apps/web/src/pages/WalkerSession.tsx#L324-L335)):
   resolve `scopeOptionsRef` from `view.scope ?? mergeDrillRules(active.drillRules).scope`.
   The existing once-at-session-start ref pattern already guards staleness — only the
   source expression changes. Same precedence in the drill-seed queue build and in
   classic [DrillSession.tsx](apps/web/src/pages/DrillSession.tsx).
4. **Daily diet: untouched.** It keeps reading stored rules; the footgun dies because
   one-off narrowing no longer writes them. The stored `drillRules.scope` remains as
   the editor-level *default*, exactly as today.

**Tests:** view↔hash round-trip incl. scopes with spaces/colons; walker resolves view
scope over stored scope; absent view scope falls back to stored.

### F1.2 Line navigator

1. **Pure aggregation** — new `apps/web/src/lib/lines/lineIndex.ts`:
   `buildLineIndex(rep, indices, pathNames, cards, attempts, now)` → `LineNavEntry[]`
   where `LineNavEntry = { scope: LineScope; label: string; depth: number;
   dueCount: number; cardCount: number; toBuild: number; recentMisses: number }`.
   - **Opening-name entries:** each card's deepest name comes from one
     [pathNames.ts](apps/web/src/lib/openings/pathNames.ts) pass (already one BFS per
     tree); counts aggregate up the name hierarchy using the boundary matching in
     `matchesOpeningName` ([scope.ts:48](packages/shared/src/scope.ts#L48)) so
     "Caro-Kann Defense" includes its variations. Nesting is derived by name-prefix
     over the names actually present — no new ECO parsing.
   - **Tag entries:** one entry per distinct `line_tags` value on live edges.
   - Exclusions mirror the queue builders: dropped subtrees and `is_refutation` edges
     contribute nothing.
   - `recentMisses` reuses `rankMistakes` input filtering from
     [attempts.ts](packages/shared/src/attempts.ts) — count of ranked moves in scope.
   - `toBuild`: count of attention nodes in the scoped subtree (walk once with the
     existing indices; do **not** call `findNextBuildNode` per line).
2. **View** — add `{ kind: 'lines'; repertoireId: string; intent: 'train' | 'grow' }`,
   hash `#/lines/:id/:intent`, page `pages/LineNavigator.tsx`. Rows: "All" first with
   a prominent Start, then name entries indented by hierarchy, then tag entries.
   Start → `go({ kind: 'walker-session', repertoireId, seed, scope })` (scope omitted
   for "All"). Adding a view touches the four documented places: union, `viewToHash`,
   `hashToView`, `App` switch.
3. **Entry points** — repertoire card's **Drill/Build** route to
   `lines/:id/train|grow` instead of straight into the walker. Name cache warming
   (`nameCache.ts`) happens on navigator load so an `openingName` start is never
   cold-empty; a cold cache renders name entries disabled with a "names not cached —
   go online once" hint rather than silently showing zero due (mirrors the
   fail-closed rule in [srs-drilling.md](knowledge/03-domain/srs-drilling.md#line-scopes-phase-9a)).

**Tests (Vitest, pure):** aggregation nesting, tag entries, dropped/refutation
exclusion, due counts consistent with `buildDrillQueue` for the same scope (property:
navigator's `dueCount` = length of the queue it launches).

### F1 knowledge-base updates
- [views-and-routing.md](knowledge/05-web/views-and-routing.md): new view + hash forms.
- [srs-drilling.md](knowledge/03-domain/srs-drilling.md): session-scope precedence;
  stored scope demoted to default; the daily-diet interaction note rewritten.
- [walker.md](knowledge/03-domain/walker.md): scope source paragraph.
- [components-and-hooks.md](knowledge/05-web/components-and-hooks.md): LineNavigator, lineIndex.
- [testing.md](knowledge/06-workflows/testing.md): new test purposes.

**Acceptance:** from the list, two taps reach a Winawer-only session; the hash
deep-links it; stored drill rules and tomorrow's daily diet are byte-identical before
and after.

---

## F2 — Guided prepare ("Prepare against…")

**Goal:** the proposal §3.2 session, end to end, assembled from existing machinery.

### F2.1 Session parameters & wizard

1. **Prep target type** — in `packages/shared` (it parameterizes shared policy):
   `PrepTarget = { minShare: number; maxDepthPlies: number }` with presets
   `default (0.05 — the existing DEFAULT_OPPONENT_REPLY_POLICY.minShare)`,
   `broader (0.02)`, `mainLines (0.20)`; depth default 12. Persist last-used per
   repertoire as an optional field inside the `drill_rules` jsonb (read via
   `mergeDrillRules`, validated on write next to `parseLineScope`). It is not
   conceptually a drill rule — accepted wart, noted in the doc, migration-free.
   Revisit only if a second growth setting appears.
2. **View** — `{ kind: 'prepare' }`, hash `#/prepare`, page `pages/PrepareWizard.tsx`.
   Steps map to existing endpoints:
   - **Search:** `GET /openings?q` type-ahead (endpoint exists). "Start from a
     position/PGN" alternative reuses the BrowseOpenings board component.
   - **Color inference:** side that played the *last* move of the opening's
     `pgn_moves` owns it; the user gets the other color (Caro-Kann → prepare as
     White). Shown with a one-tap flip. Pure helper + tests in shared.
   - **Destination:** look up the stem fenKey across local full snapshots (already in
     IndexedDB for [repStats.ts](apps/web/src/lib/repStats.ts)) among repertoires of
     that color → default *extend*, else *create* via the existing
     `createRepertoire({ seedSans })`.
   - **Stem seeding:** for *extend*, commit the stem via
     `POST /repertoires/:id/moves/batch` (idempotent `appendLine`; a re-run is
     `added: 0, reused: N`). This is what makes a scoped build startable — under a
     non-`all` scope the root is never offered
     ([walker.md](knowledge/03-domain/walker.md#scoped-building)), so the stem must
     exist before the walker starts.
   - **Launch:** `go({ kind: 'walker-session', repertoireId, seed: 'build',
     scope, guided: true })`.
3. **Walker session mode** — `walker-session` gains optional `guided?: true`
   (hash: `#/walker/:id/build?guided=1&scope=…`). In guided mode:
   - **Auto-expand is forced on for the session** — an override at queue time, not a
     write to `repertoires.auto_expand`. All 9c guarantees hold unchanged (dropped
     branches never re-added, explorer-sourced writes only, caps).
   - Reply selection uses the session's `PrepTarget.minShare` by passing a policy
     into `selectOpponentReplies` ([explorer.ts:116](packages/shared/src/explorer.ts#L116)
     — the `policy?` param exists precisely for this); depth stops at
     `maxDepthPlies`.

### F2.2 Line-at-a-time traversal

New pure function in [walker.ts](apps/web/src/lib/walker/walker.ts):
`findNextBuildNodeLineFirst(rep, indices, options & { lastReachedFenKey?: string })`.
Strategy: continue from the position just extended (the existing
`findNextBuildNodeFrom` does the descend), until the branch hits `maxDepthPlies` or
runs out of in-scope attention nodes; then backtrack to the nearest in-scope ancestor
with an unexplored sibling; BFS from the stem only when nothing is in progress.
`WalkerSession` picks the strategy by session type: guided → line-first, plain Grow →
existing BFS (unchanged default, per the proposal). ~Everything is already exposed to
implement this outside `findNextBuildNode` — no changes to it.

**Tests:** traversal-order assertions on a fixture tree (finish Advance line to depth
cap before touching Classical; backtrack order; scope respected; dropped subtrees
skipped; refutation edges invisible via the existing `movesByParent` choke point).

### F2.3 Lock-in micro-rehearsal

In `WalkerSession`'s phase machine, a new `lock-in` phase:

1. During guided build, collect the session's newly created user moves
   (`AddedMove.moveId` per line).
2. Trigger: the current line reached target depth, **or** 5 new moves accumulated,
   **or** the session is ending.
3. Build the mini-queue directly from the known path (the session just created it —
   no need to widen `buildDrillQueue`): DrillItems for those moves in line order with
   `opponentResponseSan` filled from the saved replies, replayed walkthrough-style on
   the persistent board.
4. Grading uses the normal path — real FSRS grades via `applyGrade`, attempts via
   `logAttempt` (all three implementations already do this; the lock-in must too).
5. **Engine gating:** lock-in is a drill phase — `setGated(true)` for its duration,
   flipping back when the walker returns to build. The per-phase gating pattern
   already exists in the walker ([engine.md](knowledge/03-domain/engine.md)); this
   adds one phase to it. *If a lock-in card can see an eval before grading, the
   feature is wrong.*
6. After the pass: one-line summary ("Line locked in — 4/5 first try"), back to build.

### F2.4 Coverage-to-target meter, v1 (structural)

Header widget: `covered / (covered + toBuild)` attention-node counts within scope +
depth cap, and "N lines to target" from the traversal's remaining-branch count.
Extends `computeCoverage` with a scoped variant next to it; game-weighted upgrade
lands in F3. Session end state (traversal returns null in scope) → summary screen:
lines added, cards created, worst lock-in line, **"Drill these now"** → walker drill
seed with the same session scope.

### F2 knowledge-base updates
- [walker.md](knowledge/03-domain/walker.md): line-first strategy, lock-in phase, guided mode.
- [srs-drilling.md](knowledge/03-domain/srs-drilling.md): lock-in grading + attempt logging.
- [engine.md](knowledge/03-domain/engine.md): the lock-in gating row.
- [explorer.md](knowledge/03-domain/explorer.md): policy parameterization by PrepTarget.
- [views-and-routing.md](knowledge/05-web/views-and-routing.md): `prepare` view, guided/hash params.
- [glossary.md](knowledge/01-overview/glossary.md): *prep target*, *lock-in*, *guided session*.
- [roadmap.md](knowledge/06-workflows/roadmap.md): F-phase status table.

**Acceptance:** "Caro-Kann" typed in the wizard → White inferred → new/extended
repertoire → session where opponent replies auto-appear by frequency, each user-turn
prompt shows eval+popularity candidates, every completed line is immediately
rehearsed and graded, a meter counts down to target, and the summary can launch a
scoped drill. Manual board moves accepted at every prompt.

---

## F3 — Frequency floor + game-weighted coverage

**Goal:** the guided flow works on the 401 dev machine, offline-warmed, and the
meter speaks in share-of-games.

### F3.1 Bundled explorer snapshot

1. **Generator** — `apps/api/src/scripts/build-explorer-snapshot.ts`: BFS from the
   start position, expanding only moves above a share floor (~2%), to ~12 plies,
   fetching from the lichess explorer with the existing client's rate-limit manners
   (429 → global backoff). Output: vendored JSONL under
   `apps/api/data/explorer-snapshot/` with a `generated_at` stamp. Run manually,
   from a machine where the host answers (the 401 box can't — that's the point);
   committed like the ECO TSVs. Licensing mirrors the book precedent (lichess data,
   CC0-adjacent — note the source in the data README).
2. **Table + importer** — `explorer_snapshot_entries`, same shape as
   `explorer_entries` minus `fetched_at` semantics; a drop-and-reload importer
   (`db:import-explorer-snapshot`) exactly like
   [import-openings.ts](apps/api/src/scripts/import-openings.ts). **Not** merged into
   `explorer_entries`: that table is a truncatable cache and the snapshot must
   survive truncation.
3. **Service tier** — [services/explorer.ts](apps/api/src/services/explorer.ts):
   live → stale cache → **snapshot** → `null`. Response `source` distinguishes
   `'snapshot'` so the UI can label staleness ("stats as of 2026-06"). The
   never-throws contract is unchanged.
4. **Consumers need zero changes** — `selectOpponentReplies`,
   `rankUserCandidates`, auto-expansion, and the prefetcher all take an
   `ExplorerEntry`; they don't care which tier produced it. The 9c rule "only
   explorer-sourced candidates authorize a write" is *satisfied*, not weakened: a
   snapshot is real frequency data ([FLOW_PROPOSAL.md §3.6](FLOW_PROPOSAL.md)).
5. **Deferred, noted:** shipping a client-side copy for fully-offline *building*.
   The IndexedDB warm cache + prefetcher already cover the realistic offline case
   (drilling offline, building mostly online).

**Tests:** importer parses/normalizes via `fenKey()` (parity with the book importer's
guard); service tier order incl. snapshot hit on cold cache + dead network;
`probe:explorer` extended to print which tier answered.

### F3.2 Game-weighted coverage

Pure, in `packages/shared/src/coverage.ts`: given the scoped tree frontier and an
`ExplorerEntry` per opponent-turn node, the share of games that reach prepared moves —
the number the meter shows ("74% of games covered"). Falls back to F2.4's structural
count when entries are missing (cold client cache), labeled as such. Client computes
from the IndexedDB-warmed entries; the prefetcher already warms the frontier.

**Tests:** weighting math on fixture trees; graceful mixed cold/warm degradation.

### F3 knowledge-base updates
- [explorer.md](knowledge/03-domain/explorer.md): the tier, the snapshot's
  non-cache nature, generator workflow, the dev-401 note updated (it's now mitigated).
- [data-model.md](knowledge/02-architecture/data-model.md): new table.
- [dev-setup.md](knowledge/06-workflows/dev-setup.md): import script.
- [endpoints.md](knowledge/04-api/endpoints.md): `source: 'snapshot'` value.

**Acceptance:** with Wi-Fi off and `explorer_entries` truncated, the guided flow
still ranks opponent replies by real frequency on the API host; the meter reads in
share-of-games whenever entries are warm.

---

## F4 — Smart Train queue + home re-org

**Goal:** one Train button that does the right thing; a home screen organized by
intent.

### F4.1 Smart default queue

`buildSmartQueue(args)` in [queue.ts](apps/web/src/lib/drill/queue.ts): concatenate
**due (FSRS order) → mistakes (9d ranking, deduped against due) → new cards** (capped
by `newCardsPerDay`, counted with the existing `lastReview > dailyDietLastResetAt`
mechanism so it composes with the daily diet's cap rather than double-spending it).
Scope filters first, as today. The walker drill seed uses it by default; the five
modes remain selectable behind an "advanced" disclosure on the session screen, and
classic `DrillSession`/`DrillSetup` are left as-is pending the planned consolidation
(this phase must not grow a fourth implementation — it's a queue-builder change
consumed by the walker only).

**Tests:** ordering, dedup, cap accounting shared with daily diet, scope composition.

### F4.2 Home re-org

[RepertoireList.tsx](apps/web/src/pages/RepertoireList.tsx): Today banner (exists) →
**Prepare against…** entry (`#/prepare`) → repertoire cards with **Train / Grow**
(renamed from Drill/Build, routing to the F1 navigator). "Browse openings" moves from
the top nav into the Prepare wizard + overflow; the nav becomes *Repertoires ·
Today · Prepare*. Coverage badge on each card upgrades to the F3.2 number when warm.

### F4.3 Terminology pass

User-facing strings only — walker header, buttons, empty states: Build→Grow,
Drill→Train, "prep"→unchanged (it's the domain term). No identifier renames; code
vocabulary stays aligned with the knowledge base.

### F4 knowledge-base updates
- [srs-drilling.md](knowledge/03-domain/srs-drilling.md): smart queue.
- [views-and-routing.md](knowledge/05-web/views-and-routing.md): nav changes.
- [product.md](knowledge/01-overview/product.md): the intent-first frame.
- [roadmap.md](knowledge/06-workflows/roadmap.md): F-phases done; note that classic
  drill consolidation debt is now *smaller* (walker default path no longer needs the
  mode picker).

**Acceptance:** a cold-start user reaches a correct session from any of the three
home rows without knowing the words "walker", "seed", "scope", or "mode".

---

## Sequencing & sizing

| Phase | Depends on | Size | Risk notes |
|---|---|---|---|
| **F1** | — | S–M (2 focused items) | Lowest risk; pure + routing. Ship alone, use for a week — it changes daily use immediately |
| **F2** | F1 (scope param, navigator entry) | L (wizard + traversal + lock-in) | The lock-in gating flip and the guided auto-expand override are the two invariant-sensitive spots — both get dedicated tests |
| **F3** | none technically; F2 makes it worth it | M (generator is fire-and-forget) | Generator must run off the 401 machine; treat data freshness like the book (regenerate ~yearly) |
| **F4** | F1 (navigator), better after F2 | S–M | Mostly UI; the queue builder is the only logic |

Standing invariants explicitly *not* touched, and verified per phase: offline
drilling (all new queue logic is client-side and pure), PGN round-trip (refutations
and snapshots never export), engine gating (one new gated phase, zero gating-boundary
moves), one-prep invariant (409/swap path reused by the wizard's batch append),
dropped-branch semantics (every new traversal goes through `movesByParent`).

## Open decisions (small, non-blocking — defaults chosen)

1. **`PrepTarget` inside `drill_rules` jsonb** — pragmatic, migration-free, slightly
   misfiled. Default: do it, revisit if a second growth setting appears.
2. **Train button: navigator vs. straight to "All".** Default: open the navigator
   with "All" as the first prominent row — one extra tap, in exchange for the scope
   feature being discoverable at all.
3. **Snapshot depth/floor (12 plies, 2%)** — tune from the generator's actual output
   size before vendoring; the numbers are a starting point, not a contract.
