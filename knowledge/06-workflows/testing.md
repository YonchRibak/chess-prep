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
| [explorer.test.ts](../../packages/shared/src/explorer.test.ts) | Phase 9b candidate policy: frequency cutoffs and the reply cap (what stops auto-expansion exploding the frontier), that a popular move the engine dislikes is never promoted, that no explorer data degrades to plain engine order, and that thin samples score `null` rather than 100% |
| [attempts.test.ts](../../packages/shared/src/attempts.test.ts) | Phase 9d: mistake ranking — recency ordering, the window cutoff, that a move only ever answered correctly is never ranked, and that correct answers demote a **repaired** mistake below a fresh one (without this the mode becomes a permanent hall of shame); plus interference never reporting the current position or an unprepped SAN |
| [refutation.test.ts](../../packages/shared/src/refutation.test.ts) | Phase 9d: PV→SAN conversion for shadow lines — the ply cap, and that a **stale** PV truncates at the first unplayable move instead of throwing (a partial refutation is still worth storing; an exception would lose the whole thing) |
| [scope.test.ts](../../packages/shared/src/scope.test.ts) | Phase 9a: opening-name boundary matching, tag matching, tag inheritance (replace vs inherit vs clear), `parseLineScope` validation, and that a malformed scope degrades to "no filter" rather than "no cards" |

### apps/web — pure logic, no DOM
| File | Guards |
|---|---|
| [walker.test.ts](../../apps/web/src/lib/walker/walker.test.ts) | BFS round-robin order, dropped-subtree skipping, coverage stats; scoped building stays inside its line and returns `null` rather than escaping it; Phase 9d: a shadow line is not coverage, is absent from `movesByParent` but present in `allMovesByParent`, and counts as neither live nor dropped |
| [queue.test.ts](../../apps/web/src/lib/drill/queue.test.ts) | Drill queue per mode + rules; daily-diet interleaving and the new-card cap; line scopes — including that an `openingName` scope with **no** name lookup yields an empty queue (fail closed); Phase 9d `mistakes` mode ordering, that it ignores the due date, that it fails closed with no attempt log, and that it composes with a line scope; that a shadow line is never drilled **even if it somehow carries a card**; and that a rule-filtered *user* move is never auto-played as an opponent reply in walkthrough |
| [interference.test.ts](../../apps/web/src/lib/drill/interference.test.ts) | Phase 9d: that interference reports only **user-side, non-dropped, non-shadow** preps at a *different* position — the exclusions that keep the hint from being false (naming a move the user played by mistake as "your prep" would confirm the error) — and the message phrasing with and without a book name |
| [autoExpand.test.ts](../../apps/web/src/lib/walker/autoExpand.test.ts) | Phase 9c: that auto-expansion **never re-adds a dropped branch**, never writes from book-ordered (alphabetical) candidates, and stays capped |
| [candidates.test.ts](../../apps/web/src/lib/openings/candidates.test.ts) | UCI→SAN conversion at the engine boundary, dropping stale/illegal lines, and that book rows carry no fake 0% frequency |
| [scheduler.test.ts](../../apps/web/src/lib/srs/scheduler.test.ts) | FSRS DTO ↔ card conversion and grading |
| [engine.test.ts](../../apps/web/src/lib/engine/engine.test.ts) | UCI parsing, and **`setGated`** |
| [arrows.test.ts](../../apps/web/src/lib/engine/arrows.test.ts) | Rank → brush/color mapping |
| [useChessRules.test.ts](../../apps/web/src/lib/chess/useChessRules.test.ts) | Rules wrapper |

### apps/api — needs Postgres
| File | Guards |
|---|---|
| [repertoires.invariant.test.ts](../../apps/api/src/services/repertoires.invariant.test.ts) | One-prep-per-user-turn-position, including the `swap` path |
| [malformedIds.test.ts](../../apps/api/src/services/malformedIds.test.ts) | That a malformed uuid is a 404 on every by-id service (paired against a valid-but-absent id, so the two stay indistinguishable), a 400 on a query filter, and a skip inside a sync batch — never the `500` the raw uuid cast used to produce. The `isUuid` half needs no database |
| [deleteAll.test.ts](../../apps/api/src/services/deleteAll.test.ts) | That `deleteAllRepertoires` wipes its own user's repertoires and cascades their cards — and, the assertion that actually matters, that a **bystander user's** repertoire survives. A missing `where user_id` passes every "did it delete?" check and fails only this one. Runs against a throwaway user, never `DEFAULT_USER_ID` |
| [refutations.invariant.test.ts](../../apps/api/src/services/refutations.invariant.test.ts) | Phase 9d, the whole feature stated as what must **not** happen: no card for any ply of a shadow line, no claim on the one prep slot, omitted from PGN export, promotion to prep is one-way, idempotent re-save, and the ply cap is enforced |
| [import-openings.parity.test.ts](../../apps/api/src/scripts/import-openings.parity.test.ts) | Importer rows match `fenKey()`-normalized lookups, byte for byte |
| [explorer.test.ts](../../apps/api/src/services/explorer.test.ts) | Parsing third-party explorer JSON (malformed rows dropped, totals taken from the position rather than the truncated move list) and the fenKey guard. Pure — needs no DB despite living beside the integration tests |

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

