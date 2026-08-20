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
| [scope.test.ts](../../packages/shared/src/scope.test.ts) | Phase 9a: opening-name boundary matching, tag matching, tag inheritance (replace vs inherit vs clear), `parseLineScope` validation, and that a malformed scope degrades to "no filter" rather than "no cards" |

### apps/web — pure logic, no DOM
| File | Guards |
|---|---|
| [walker.test.ts](../../apps/web/src/lib/walker/walker.test.ts) | BFS round-robin order, dropped-subtree skipping, coverage stats; scoped building stays inside its line and returns `null` rather than escaping it |
| [queue.test.ts](../../apps/web/src/lib/drill/queue.test.ts) | Drill queue per mode + rules; daily-diet interleaving and the new-card cap; line scopes — including that an `openingName` scope with **no** name lookup yields an empty queue (fail closed), and that a rule-filtered *user* move is never auto-played as an opponent reply in walkthrough |
| [scheduler.test.ts](../../apps/web/src/lib/srs/scheduler.test.ts) | FSRS DTO ↔ card conversion and grading |
| [engine.test.ts](../../apps/web/src/lib/engine/engine.test.ts) | UCI parsing, and **`setGated`** |
| [arrows.test.ts](../../apps/web/src/lib/engine/arrows.test.ts) | Rank → brush/color mapping |
| [useChessRules.test.ts](../../apps/web/src/lib/chess/useChessRules.test.ts) | Rules wrapper |

### apps/api — needs Postgres
| File | Guards |
|---|---|
| [repertoires.invariant.test.ts](../../apps/api/src/services/repertoires.invariant.test.ts) | One-prep-per-user-turn-position, including the `swap` path |
| [import-openings.parity.test.ts](../../apps/api/src/scripts/import-openings.parity.test.ts) | Importer rows match `fenKey()`-normalized lookups, byte for byte |

## Three tests that must not be weakened

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
