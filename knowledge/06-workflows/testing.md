# Testing

Vitest everywhere. `pnpm test` runs all three packages; `apps/api` uses
`--passWithNoTests` because its suites need a live database.

## The test files

### packages/shared — pure logic
| File | Guards |
|---|---|
| [fen.test.ts](../../packages/shared/src/fen.test.ts) | `fenKey()` normalization |
| [openings.test.ts](../../packages/shared/src/openings.test.ts) | Importer/lookup normalization parity (pure-logic half) |
| [pgn.test.ts](../../packages/shared/src/pgn.test.ts) | PGN round-trip: variations, NAGs, comments |
| [study.test.ts](../../packages/shared/src/study.test.ts) | Study S1: chapter splitting and naming fallbacks, tag dedupe (case-insensitive collisions), `[FEN]` chapters attaching vs. a **detached chapter being rejected**, merge (shared prefix carries every chapter tag, first comment wins), the prep policy (variation and cross-chapter demotion, first chapter wins, opponent alternates untouched, black-side parity, sole hero move promoted), live reachability excluding a demoted subtree while honouring a live transposition, and parity with the legacy `pgnToTree` on a single chapter |
| [explorer.test.ts](../../packages/shared/src/explorer.test.ts) | Phase 9b candidate policy: frequency cutoffs and the reply cap (what stops auto-expansion exploding the frontier), that a popular move the engine dislikes is never promoted, that no explorer data degrades to plain engine order, and that thin samples score `null` rather than 100% |
| [attempts.test.ts](../../packages/shared/src/attempts.test.ts) | Phase 9d: mistake ranking — recency ordering, the window cutoff, that a move only ever answered correctly is never ranked, and that correct answers demote a **repaired** mistake below a fresh one (without this the mode becomes a permanent hall of shame); plus interference never reporting the current position or an unprepped SAN |
| [refutation.test.ts](../../packages/shared/src/refutation.test.ts) | Phase 9d: PV→SAN conversion for shadow lines — the ply cap, and that a **stale** PV truncates at the first unplayable move instead of throwing (a partial refutation is still worth storing; an exception would lose the whole thing) |
| [scope.test.ts](../../packages/shared/src/scope.test.ts) | Phase 9a: opening-name boundary matching, tag matching, tag inheritance (replace vs inherit vs clear), `parseLineScope` validation, and that a malformed scope degrades to "no filter" rather than "no cards" |
| [prep.test.ts](../../packages/shared/src/prep.test.ts) | Flow F2: `parsePrepTarget` validation; that the *default* preset equals the reply policy's own `minShare` (so "Standard" can't silently diverge from un-guided building); color inference from the book's movetext |
| [rashid.test.ts](../../packages/shared/src/rashid.test.ts) | Rashid R1 domain core against a scripted fake engine: only-move detection (gap in win-prob space, opponent-preference sort direction, mate sentinels), the walk's **laziness** via the fake's call log (no call past a failed check, none for a prefiltered root or a forced reply — engine calls are Rashid's entire cost), forced replies not counting as pinch points, repetition ending a cycling line as a draw, the sacrifice cap rejecting a too-expensive gambit *after* it passed the root prefilter, and reward floor/max ordering through mate sentinels; plus the per-candidate "why not" trace naming each rejection's reason (prefiltered / open-node gap / cap-busted / budget) so a non-detection is explainable rather than silent |
| [coverage.test.ts](../../packages/shared/src/coverage.test.ts) | Flow F3.2: game-weighted coverage — mass weighted by reply shares, depth-cap mass counts as covered, the truncated rare-move tail counts as uncovered, and cold nodes park mass as *unknown* (with `gameWeightedCoverageUsable` refusing to display a guess) rather than inflating the percentage |

### apps/web — pure logic, no DOM
| File | Guards |
|---|---|
| [walker.test.ts](../../apps/web/src/lib/walker/walker.test.ts) | BFS round-robin order, dropped-subtree skipping, coverage stats; scoped building stays inside its line and returns `null` rather than escaping it; Phase 9d: a shadow line is not coverage, is absent from `movesByParent` but present in `allMovesByParent`, and counts as neither live nor dropped. Flow F2 (`findNextBuildNodeLineFirst`): continues the branch just extended instead of jumping to a shallower gap, backtracks to the nearest sibling at the depth cap, returns `null` when the scoped+capped subtree is covered (the guided "done"), respects scope/skips/drops/shadows; `computeScopedCoverage` counting |
| [queue.test.ts](../../apps/web/src/lib/drill/queue.test.ts) | Drill queue per mode + rules; daily-diet interleaving and the new-card cap; line scopes — including that an `openingName` scope with **no** name lookup yields an empty queue (fail closed); Phase 9d `mistakes` mode ordering, that it ignores the due date, that it fails closed with no attempt log, and that it composes with a line scope; that a shadow line is never drilled **even if it somehow carries a card**; and that a rule-filtered *user* move is never auto-played as an opponent reply in walkthrough. Flow F4 (`buildSmartQueue`): due→mistakes→new ordering, dedup across segments, that the new-card cap shares the daily diet's already-shown-today accounting (no double-spend), scope composition, shadow exclusion |
| [interference.test.ts](../../apps/web/src/lib/drill/interference.test.ts) | Phase 9d: that interference reports only **user-side, non-dropped, non-shadow** preps at a *different* position — the exclusions that keep the hint from being false (naming a move the user played by mistake as "your prep" would confirm the error) — and the message phrasing with and without a book name |
| [autoExpand.test.ts](../../apps/web/src/lib/walker/autoExpand.test.ts) | Phase 9c: that auto-expansion **never re-adds a dropped branch**, never writes from book-ordered (alphabetical) candidates, and stays capped |
| [candidates.test.ts](../../apps/web/src/lib/openings/candidates.test.ts) | UCI→SAN conversion at the engine boundary, dropping stale/illegal lines, and that book rows carry no fake 0% frequency |
| [scheduler.test.ts](../../apps/web/src/lib/srs/scheduler.test.ts) | FSRS DTO ↔ card conversion and grading |
| [treeIndex.test.ts](../../apps/web/src/lib/tree/treeIndex.test.ts) | S4 extraction: the breadcrumb through a transposition prefers the main-line ancestor, `flattenTree` emits siblings in order with balanced parentheses and **keeps dropped edges** (browsing shows the tree, drilling filters it), `sortSiblings` order |
| [rashidScan.test.ts](../../apps/web/src/store/rashidScan.test.ts) | S4 study scan store: only lit positions become findings and carry a clickable path and chapter tag; alternates included for a study and excludable; a rerun on the same study keeps findings while another study resets them; cancel stops the run and a stale run's late result is dropped; `loadFromCache` reads the precompute tier before the live tier using **the writer's exact key** (`resultKeyForTier`) |
| [router.test.ts](../../apps/web/src/lib/router.test.ts) | Flow F1: view ↔ hash round-trips for every view kind, including session scopes with spaces and interior colons; that a malformed `?scope=` param degrades to *absent* (stored rules apply) rather than nulling a valid route or inventing a scope. Flow F2: `guided=1` round-trips (alone and with a scope) and anything else parses un-guided |
| [lineIndex.test.ts](../../apps/web/src/lib/lines/lineIndex.test.ts) | Flow F1 line navigator: name-hierarchy nesting, tag entries, dropped/refutation exclusion, misses-per-line — and the property the navigator exists to keep: each entry's `dueCount` **equals the length of the due queue its Start button launches** with the same scope |
| [engine.test.ts](../../apps/web/src/lib/engine/engine.test.ts) | UCI parsing, **`setGated`**, go-command selection (`nodes` budget for Rashid, `movetime` precedence), and `id name` capture for the Rashid cache key |
| [rashidLive.test.ts](../../apps/web/src/lib/engine/rashidLive.test.ts) | Rashid R3 live probe: a layer-B hit resolves without initializing the engine, a retuned config misses (the derivation key carries the full config), cancellation surfaces as `RashidCancelled` control flow, and — the assertion that extends the no-leak guarantee across workers — the **singleton's** gate refuses a probe on Rashid's own dedicated engine, even a cache hit |
| [rashidPrecompute.test.ts](../../apps/web/src/lib/engine/rashidPrecompute.test.ts) | Rashid R5: priority enumeration (BFS depth order, hero turns only, dropped/refutation subtrees excluded — engine minutes must not be spent on positions the user never plays toward — transpositions once) and the run loop: computed/cached/lit/failed accounting, one bad position not sinking the run, cancellation between positions, and the drill pause that **waits** rather than aborting; S4: `includeDropped` visits hero positions under a dropped edge but never a shadow line, and `onResult` reports every processed position |
| [rashidAdapter.test.ts](../../apps/web/src/lib/engine/rashidAdapter.test.ts) | Rashid R2 boundary: multipv-rank ordering survives the EngineLine→AnalyzedMove mapping (the domain core's best-first contract), the layer-A cache key differs on **every** determinism component, a cache hit resolves without initializing the engine (cached positions survive a wasm boot failure), a budget mismatch misses, and a **gated engine is refused before any worker traffic** — awaiting it would hang forever, and silence is how answers leak |
| [arrows.test.ts](../../apps/web/src/lib/engine/arrows.test.ts) | Rank → brush/color mapping |
| [rashidArrows.test.ts](../../apps/web/src/lib/engine/rashidArrows.test.ts) | Rashid R4 arrow encoding: risk-band boundaries, reward→thickness clamp (mate = max), best line full-opacity with the Length badge vs pale unlabeled capped runners-up, empty board when nothing lights up, and that every brush a shape can name is actually registered (an unregistered brush fails silently — chessground just doesn't draw) |
| [useChessRules.test.ts](../../apps/web/src/lib/chess/useChessRules.test.ts) | Rules wrapper |

### apps/api — needs Postgres
| File | Guards |
|---|---|
| [repertoires.invariant.test.ts](../../apps/api/src/services/repertoires.invariant.test.ts) | One-prep-per-user-turn-position, including the `swap` path |
| [studies.sync.test.ts](../../apps/api/src/services/studies.sync.test.ts) | Study S2: import of a two-chapter study (tags, provenance, demoted alternate uncarded, cards only for live hero moves); that an **identical re-import changes nothing and keeps every card row**; a changed comment updates and a removed line deletes with its card while the rest keep their cards; swapping the study's main line moves the prep slot (old card kept, new created); a refutation shadow line and its positions survive; an opponent-side manual drop survives while a hero-side one is reset; the update path refuses hand-built repertoires and root changes; undropping a demoted alternate is a 409 |
| [malformedIds.test.ts](../../apps/api/src/services/malformedIds.test.ts) | That a malformed uuid is a 404 on every by-id service (paired against a valid-but-absent id, so the two stay indistinguishable), a 400 on a query filter, and a skip inside a sync batch — never the `500` the raw uuid cast used to produce. The `isUuid` half needs no database |
| [deleteAll.test.ts](../../apps/api/src/services/deleteAll.test.ts) | That `deleteAllRepertoires` wipes its own user's repertoires and cascades their cards — and, the assertion that actually matters, that a **bystander user's** repertoire survives. A missing `where user_id` passes every "did it delete?" check and fails only this one. Runs against a throwaway user, never `DEFAULT_USER_ID` |
| [refutations.invariant.test.ts](../../apps/api/src/services/refutations.invariant.test.ts) | Phase 9d, the whole feature stated as what must **not** happen: no card for any ply of a shadow line, no claim on the one prep slot, omitted from PGN export, promotion to prep is one-way, idempotent re-save, and the ply cap is enforced |
| [import-openings.parity.test.ts](../../apps/api/src/scripts/import-openings.parity.test.ts) | Importer rows match `fenKey()`-normalized lookups, byte for byte |
| [explorer.test.ts](../../apps/api/src/services/explorer.test.ts) | Parsing third-party explorer JSON (malformed rows dropped, totals taken from the position rather than the truncated move list) and the fenKey guard. Pure — needs no DB despite living beside the integration tests |
| [explorer.tier.test.ts](../../apps/api/src/services/explorer.tier.test.ts) | Flow F3 (integration): tier order — cold cache + no network falls through to the bundled **snapshot** (labeled as such) instead of `null`, and a cache row still beats the snapshot because it is newer |
| [import-explorer-snapshot.test.ts](../../apps/api/src/scripts/import-explorer-snapshot.test.ts) | Flow F3: snapshot importer parsing — the fenKey parity guard (a row keyed off-normalization would silently never be hit), loud per-line rejection of malformed vendored data. Pure |

## Four tests that must not be weakened

These exist because the failure they prevent is **silent**:

1. **`engine.test.ts` → `setGated`** — asserts a gated `analyze()` emits only `stop` and
   never `go`. This *is* the "engine never leaks the answer" guarantee.
   ([engine](../03-domain/engine.md))
2. **`repertoires.invariant.test.ts`** — the one-prep invariant has no database
   constraint behind it, so this test is the only thing stopping a refactor from allowing
   two prep moves per position. ([data-model](../02-architecture/data-model.md#invariants-that-are-not-database-constraints))
3. **The FEN parity pair** — drift in `fenKey()` between the importer, the API, and the
   client breaks transposition collapse and opening naming with no error anywhere.
   ([fen-keying](../03-domain/fen-keying.md))
4. **`autoExpand.test.ts` → "NEVER re-adds a dropped branch"** — a position whose replies
   were all dropped is indistinguishable from an untouched one by the walker's "no live
   children" rule, so weakening this filter makes auto-expansion re-add exactly what the
   user rejected, silently, every session.
   ([walker](../03-domain/walker.md#auto-expansion-phase-9c))

## Writing testable code here

- **Inject `now` and `rng`.** `buildDrillQueue`, `applyGrade`, and `maybeResetDailyDiet`
  all take an optional clock (and the queue takes an RNG) precisely so tests are
  deterministic. Follow that pattern for anything time- or randomness-dependent.
- **Keep logic pure.** The walker, queue builders, scheduler, and arrow mapping are all
  plain functions over plain data (`RepertoireFull`, `SrsCardDto[]`) — no React, no
  network. That's why they're cheap to test; keep new logic on that side of the line
  rather than inside components.
- There is currently **no component/E2E test layer**. Changes to session UI need manual
  verification — and there are [three drill implementations](../03-domain/srs-drilling.md#three-drill-implementations-known-debt)
  to check.

## Integration tests share your dev database

`apps/api` tests run against the `DATABASE_URL` in `apps/api/.env` — the same database the
dev server uses. There is no separate test database and no transaction rollback, so a test
that creates rows must delete them itself.

Two rules, both learned from a real leak:

- **The cleanup list accumulates across the whole file.** Ids are pushed as repertoires
  are created and deleted in `afterAll`. A `beforeEach` that resets that list pairs
  wrongly with an `afterAll` cleanup — only the last test's ids survive to be deleted, and
  every earlier test leaves a repertoire behind on **every run**. The suite still passes,
  so the only symptom is a slowly growing list of `phase7-invariant …` rows in the app.
  That bug shipped and produced ten junk repertoires before anyone looked.
- **Never operate on `DEFAULT_USER_ID` destructively.** Anything testing a bulk or
  unscoped delete creates its own throwaway user row and cleans that up instead —
  otherwise `pnpm test` eats the developer's own repertoires, which is exactly the
  failure the code under test is capable of.

