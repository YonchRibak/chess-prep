# SRS & drilling

## FSRS, on the client

Scheduling uses **`ts-fsrs`** — do not hand-roll SM-2.
[apps/web/src/lib/srs/scheduler.ts](../../apps/web/src/lib/srs/scheduler.ts) owns all of it:

- `params = generatorParameters({ enable_fuzz: true })`, one module-level `FSRS` instance.
- `applyGrade(dto, grade, now?)` → new `SrsCardDto` with `updatedAt = now`.
- `emptyCardFor(moveId, now?)` for freshly created prep moves.
- `previewGrades(dto, now?)` → what each button would schedule (for UI hints).
- `fromDto` / `toDto` translate between the wire shape (ISO strings, camelCase) and
  ts-fsrs's `Card` (Date objects, snake_case). All conversion is confined here.

Grades map 1:1 to ts-fsrs ratings: `Again=1, Hard=2, Good=3, Easy=4`
([drill.ts](../../packages/shared/src/drill.ts)). FSRS states are `0=new, 1=learning,
2=review, 3=relearning`.

**Persist every FSRS field**, not just `due` — rescheduling breaks otherwise. The DB
column set mirrors the DTO exactly.

## SRS is per move, not per line

The user drills the moves they actually forget. One card per prep `Move`, enforced by
`uniq_user_move (user_id, move_id)`. Cards are auto-created when a move is inserted on
the user's turn (`isUserMove(fenTurn(parentFen), rep.color)`).

## Drill rules

Per-repertoire, stored as partial jsonb, always read through `mergeDrillRules()`:

| Rule | Default | Meaning |
|---|---|---|
| `minDepth` | 0 | Skip cards shallower than this (plies from root) |
| `maxDepth` | 0 | Skip cards deeper than this. **`0` means no upper bound**, not "depth zero" |
| `branching` | `'all'` | `'all'` or `'main_line_only'` (only `isMainLine` moves) |
| `blindfold` | `false` | Hide pieces; show the move list only |
| `evalAfterAnswer` | `false` | Reveal engine eval after grading |
| `scope` | `{ kind: 'all' }` | Phase 9a line scope — see below. Composes with the rules above |

## Line scopes (Phase 9a)

"Drill only the Advance Variation" is a **predicate evaluated at queue-build time**, not
a stored copy of a line — a copy would drift from the tree it was cut from, silently.
Logic lives in [packages/shared/src/scope.ts](../../packages/shared/src/scope.ts) with
[tests](../../packages/shared/src/scope.test.ts):

| `scope.kind` | Matches on | Authoring cost |
|---|---|---|
| `all` (default) | everything | — |
| `openingName` | the **deepest ECO name along the card's path**, boundary-matched so `Caro-Kann Defense` catches all its variations but not an unrelated `…Deferred` | zero — the book already names it |
| `tag` | the move's `line_tags` | one tag at one branch point, in the editor's Move panel |

Honored by `buildDrillQueue`, `buildDailyDietQueue` (so a scoped repertoire contributes
only its scoped cards to the daily diet), and the walker's build seed
([walker](walker.md#scoped-building)) — a scope change must be applied to all
[three drill implementations](#three-drill-implementations-known-debt).

**Names come from a local cache, and a cold cache fails closed.** Scope filtering runs
inside the synchronous queue builders and must behave identically offline, so names are
resolved from a `fenKey → OpeningId` map cached in IndexedDB
([lib/openings/nameCache.ts](../../apps/web/src/lib/openings/nameCache.ts), warmed via
`POST /openings/by-fens`), not per-card HTTP lookups. An `openingName` scope built with
no lookup yields an **empty** queue rather than an unfiltered one: a "scoped" session
that quietly widened to the whole tree is indistinguishable from a correct one until the
user notices they're drilling the wrong opening.

A tag scope needs no network at all.

## Queue building

[apps/web/src/lib/drill/queue.ts](../../apps/web/src/lib/drill/queue.ts) ·
[tests](../../apps/web/src/lib/drill/queue.test.ts)

`buildDrillQueue({ repertoire, cards, mode, rules, now?, rng?, openingLookup?, attempts? })`
→ `DrillItem[]`.
Each item carries the `card`, the `move`, its `parentPosition`, `depth`, and optionally
`opponentResponseSan`. `now` and `rng` are injected so tests are deterministic.

Five modes (`DrillMode`):

| Mode | Selection |
|---|---|
| `due` | FSRS-due cards, oldest first |
| `walkthrough` | Sequential traversal of the line; carries `opponentResponseSan` |
| `weak` | Weak-spot targeting (high lapses / low stability) |
| `random` | Shuffled, via the injected `rng` |
| `mistakes` | Phase 9d: recency-weighted actual misses from the attempt log |

Dropped moves are excluded everywhere.

Two inputs fail **closed** rather than open, for the same reason: a session that silently
widens to the whole tree is indistinguishable from a correct one until the user notices
they're drilling the wrong thing. Omitting `openingLookup` under an `openingName` scope
yields an empty queue; omitting `attempts` under `mode: 'mistakes'` does too.

## Flow mode

The default loop auto-grades on move attempt — **correct = Good, wrong = Again** — with
no manual reveal pane, keeping cards flowing.

- **Walkthrough** uses ONE persistent board for the whole session: after a correct user
  move the saved opponent reply auto-plays on the same board (via
  `useChessRules.playSan()`), and the user is already in the next card.
- `random` / `due` / `weak` load each card's parent line instead.

**Retrain on wrong answer** (walker drill + daily diet): a miss grades Again, briefly
shows the correct move, takes it back, and requires the user to *physically play it*
before advancing.

## Daily diet

[pages/DailyDiet.tsx](../../apps/web/src/pages/DailyDiet.tsx) ·
`buildDailyDietQueue` in [queue.ts](../../apps/web/src/lib/drill/queue.ts)

The user picks only scope: **White / Black / Mixed** (Mixed = union of both pools).
It pulls full snapshots for every matching repertoire, builds a per-repertoire due queue
with `buildDrillQueue`, then **interleaves round-robin by repertoire** so consecutive
cards typically come from different openings — deliberately not a pure shuffle.

**New-card cap:** `UserSettings.newCardsPerDay` (default 20) limits how many
`state === new` cards enter the session. Cards in learning/review/relearning are
included unconditionally. Cards shown today are counted by
`lastReview > dailyDietLastResetAt` rather than a separate counter, so a crash or reload
can't double-count. See [services/userSettings.ts](../../apps/api/src/services/userSettings.ts).

The end screen breaks accuracy down per repertoire, so the day's weakest opening is
visible.

## Mistake rehearsal (Phase 9d)

Log: [drill_attempts](../02-architecture/data-model.md#drill_attempts) ·
pure logic [packages/shared/src/attempts.ts](../../packages/shared/src/attempts.ts) ·
web wrapper [lib/drill/interference.ts](../../apps/web/src/lib/drill/interference.ts).

Every answered card in **all three** drill implementations calls `logAttempt()` — correct
and wrong alike. Correct attempts matter: they are how a repaired mistake decays out.

**`rankMistakes(attempts, { now, windowDays, halfLifeDays })`** — each miss inside a
14-day window contributes an exponentially decaying weight (7-day half-life); each correct
attempt pays back half a unit of the same weight; a move with no miss in the window is not
ranked at all. Without the payback rule the mode degenerates into a permanent hall of
shame, where a move missed once a fortnight ago and answered correctly five times since
still outranks a fresh miss.

`mode: 'mistakes'` orders the queue by that ranking and **ignores the due date** — the
point is to rehearse what was just fumbled, which FSRS has by definition pushed out.
It composes with `rules.scope`, because scope filtering runs before the mode switch.

**Interference detection.** On a miss, `detectInterference(rep, parentPositionId,
playedSan, openingLookup?)` asks whether the played SAN is the user's own prep at a
*different* position in the same tree — the common transposition confusion — and
`describeInterference()` turns a hit into "e4 is your prep in the Caro-Kann Defense:
Advance Variation — not here", shown in the wrong-answer card. Two exclusions carry the
weight: opponent-side moves (a shared SAN there is coincidence, not confusion) and dropped
branches (calling one "your prep" would be false). In the daily diet it is scoped to the
card's **own** repertoire — the same SAN prepped in the other color's repertoire is not
this mix-up.

**Not built:** refutation shadow lines. See
[repertoire-growth](repertoire-growth.md#mistake-rehearsal).

## Three drill implementations (known debt)

Classic [DrillSession.tsx](../../apps/web/src/pages/DrillSession.tsx), the walker's drill
seed, and [DailyDiet.tsx](../../apps/web/src/pages/DailyDiet.tsx) are separate code paths.
Merging them into one multi-repertoire walker is deliberately deferred; classic drill
stays reachable via the repertoire card's overflow menu until then. **Changes to drill
behavior likely need to be made in more than one place** — check all three.
