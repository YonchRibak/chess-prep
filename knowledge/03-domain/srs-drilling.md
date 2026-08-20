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

## Queue building

[apps/web/src/lib/drill/queue.ts](../../apps/web/src/lib/drill/queue.ts) ·
[tests](../../apps/web/src/lib/drill/queue.test.ts)

`buildDrillQueue({ repertoire, cards, mode, rules, now?, rng? })` → `DrillItem[]`.
Each item carries the `card`, the `move`, its `parentPosition`, `depth`, and optionally
`opponentResponseSan`. `now` and `rng` are injected so tests are deterministic.

Four modes (`DrillMode`):

| Mode | Selection |
|---|---|
| `due` | FSRS-due cards, oldest first |
| `walkthrough` | Sequential traversal of the line; carries `opponentResponseSan` |
| `weak` | Weak-spot targeting (high lapses / low stability) |
| `random` | Shuffled, via the injected `rng` |

Dropped moves are excluded everywhere.

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

## Three drill implementations (known debt)

Classic [DrillSession.tsx](../../apps/web/src/pages/DrillSession.tsx), the walker's drill
seed, and [DailyDiet.tsx](../../apps/web/src/pages/DailyDiet.tsx) are separate code paths.
Merging them into one multi-repertoire walker is deliberately deferred; classic drill
stays reachable via the repertoire card's overflow menu until then. **Changes to drill
behavior likely need to be made in more than one place** — check all three.
