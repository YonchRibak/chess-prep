# Repertoire growth & line scopes

**Status: 9a, 9b and 9c are BUILT; 9d is designed, NOT built.**

- **Line scopes (9a) are shipped** — `moves.line_tags`, `DrillRules.scope`, and the
  filtering in both queue builders and the walker's build seed. The authoritative
  description of what exists is
  [srs-drilling](srs-drilling.md#line-scopes-phase-9a); the section below is the design
  it was built from and may differ in detail from the code.
- **The explorer cache and candidate ranking (9b) are shipped** — table, service,
  endpoint, and the pure selection policy, all tested. Authoritative description:
  [explorer](explorer.md). **No UI consumes them yet.**
- **Auto-expansion, the candidate UI and the frontier prefetcher (9c) are shipped** —
  opt-in per repertoire via `repertoires.auto_expand`. Authoritative descriptions:
  [walker](walker.md#auto-expansion-phase-9c) and [explorer](explorer.md).
- **`drill_attempts`, the mistakes scope, interference detection and shadow lines have no
  table, no module, and no UI.** Read that section as intent, not current state.

See [roadmap](../06-workflows/roadmap.md) and PROJECT_SPEC §5.

Related: [walker](walker.md) · [srs-drilling](srs-drilling.md) ·
[opening-database](opening-database.md) · [engine](engine.md) ·
[data-model](../02-architecture/data-model.md)

## The problem

Two user-facing asks that look separate and are not:

1. **An opening is a tree, but I need to drill one line of it.** "Caro-Kann" should hold
   every branch, yet when preparing for an opponent who always plays the Advance, the
   session should contain only that.
2. **Building should happen inside drilling.** The user should not hand-author every
   reply in every line; when a drill reaches an uncovered position, the app should supply
   ranked candidate moves and take one click.

They are one feature because **auto-growth is what makes the tree large enough to need
scoping, and scoping is what makes auto-growth safe to switch on**. The join is that both
happen on the same write: a move created by the growth loop is labeled at insert time, so
labels never need a backfill pass.

## What is already true

Do not rebuild these:

- The repertoire is already a position-keyed tree with multiple children per parent
  ([data-model](../02-architecture/data-model.md)). Branching openings need no schema
  change.
- **Drill-pauses-for-build** already exists ([walker](walker.md#drill-pauses-for-build)):
  a drill landing on an unprepped node becomes an inline build prompt.
- **Retrain-on-wrong-answer** already exists
  ([srs-drilling](srs-drilling.md#flow-mode)).
- The engine is already ungated during walker *build* phases
  ([engine](engine.md#who-gates-what)), so candidate suggestion needs no gating change —
  and must not attempt one.

The gaps are: where candidate moves come from, who decides which opponent replies to
cover, and how a session addresses a subset of a tree.

## Line scopes (request 1)

A "line" is **not** a stored object — modeling it as one would duplicate the tree and let
the copy drift. A line is a **scope**: a predicate over moves, evaluated at queue-build
time. Two kinds:

| Kind | Source | Authoring cost |
|---|---|---|
| **Derived** | `identifyDeepestOpening()` along each card's path — the same call that drives [OpeningHeader](../../apps/web/src/components/OpeningHeader.tsx) | Zero |
| **Explicit** | `moves.line_tags`, inherited from the parent edge on insert | One tag, at one branch point |

Derived scopes cover most of the ask ("only the Advance Variation") for free, because the
ECO book already names the path. Explicit tags exist only for what the book cannot
express — opponent-specific or format-specific prep (`vs-danny`, `blitz-only`).

**Inheritance rule:** a new `Move` copies its parent edge's `line_tags` unless the caller
supplies tags explicitly, in which case the supplied set replaces (not merges with) the
inherited one and re-roots inheritance for the subtree. The failure mode this prevents is
silent: without inheritance, auto-grown branches are born untagged, so a scoped drill
quietly omits exactly the moves the growth loop just added — a session that looks
complete but isn't.

`DrillRules` gains:

```ts
scope?: { kind: 'all' | 'openingName' | 'tag'; value?: string }  // default { kind: 'all' }
```

Read through `mergeDrillRules()` like every other rule. `buildDrillQueue` and
`buildDailyDietQueue` filter on it; the walker's build seed accepts it too, so "keep
building, but only in this line" works. Scope composes with the existing `minDepth` /
`maxDepth` / `branching` rules rather than replacing them.

Note the derived kind needs the card's **path**, not just its parent FEN — deepest-name
lookup is a path walk ([opening-database](opening-database.md#deepest-name-lookup)).
The queue builder already has the tree; matching is a name-prefix test against the last
non-null match along the path.

## Candidate sources (request 2)

Three sources, each for one job. Using one for all three is the mistake to avoid.

| Source | Job | Offline |
|---|---|---|
| **ECO book** (`opening_book_entries`) | Naming, and shallow breadth | Yes — bundled |
| **Lichess opening explorer** | *Which opponent replies matter* — frequency and W/D/L | Only from cache |
| **Stockfish** | *Which move the user should play* | Yes |

The book is the wrong tool for choosing opponent replies: 3,733 fenKeys, no frequency
data, and it dries up around ply 8–10. Only the explorer can say that a reply is 62% of
games rather than merely that it has a name. Conversely the explorer is the wrong tool
for choosing the user's move — popularity is not correctness.

**Selection policy** (belongs in `packages/shared`, with tests — it is a client/server
contract and pure logic):

- **Opponent replies:** take moves by descending frequency until cumulative share ≥ ~80%,
  each ≥ ~5%, capped at ~3. Fall back to book continuations when the explorer is cold.
- **User move:** engine top-3, re-ranked by explorer popularity, each shown with eval,
  opening name, and share-of-games.

`explorer_entries` is a **cache, not a source of truth**: `(fen_key, source, total,
moves jsonb, fetched_at)`. A drill session must be fully usable with it cold — same rule
as the backend never being authoritative for a live session
([local-first-sync](../02-architecture/local-first-sync.md)).

This is the same fetch/aggregate/frequency-per-fenKey plumbing that Phase 10 opponent
scouting needs. Build it once here; scouting then becomes mostly UI.

## The growth loop

The flow-killer is asking N questions per new position. The fix is an asymmetry:

> **Opponent branches auto-expand silently. The user's moves always ask — but with
> candidates pre-ranked, one click away.**

This is sound precisely because opponent-turn moves carry **no SRS card**
([glossary](../01-overview/glossary.md)): auto-adding the top replies widens the frontier
at zero drill cost. Only the user's own move creates a card, and that is the one decision
worth a prompt. The walker's existing drill-pause then fires on user-turn nodes only, and
shows ranked candidates instead of a blank board.

Two constraints keep this from misbehaving:

- **The `newCardsPerDay` cap is the throttle.** Auto-growth adds cards only through the
  user-turn prompt, which already flows through the daily cap
  ([srs-drilling](srs-drilling.md#daily-diet)). Do not add a second throttle; do not let
  growth bypass this one.
- **A frontier prefetcher** keeps candidates instant: a background queue of positions one
  ply past current coverage, warmed into IndexedDB (explorer entry + a shallow engine
  pass) during idle time. It is an optimization — every path must still work with an
  empty cache.

Auto-expansion must be **opt-in per repertoire** and must respect `is_dropped`: a dropped
branch is a standing "won't cover" instruction and the growth loop re-adding it would be
a silent violation of the user's intent.

## Mistake rehearsal

Today a miss grades Again and leaves no trace beyond FSRS's `lapses` counter. A
`drill_attempts` log — `(move_id, played_san, was_correct, at)` — is cheap and unlocks
three things the counter cannot:

1. **A `mistakes` scope** — recent *actual* errors, recency-weighted, composable with a
   line scope ("Caro-Kann mistakes from the last two weeks"). Distinct from the existing
   `weak` drill mode, which keys off FSRS stability/lapses with no recency.
2. **Interference detection** — when the played SAN is the user's *correct* prep at a
   different position in the same tree. This is the common transposition confusion, it is
   a lookup in the `movesByParent` index the walker already builds, and naming it
   ("that's your move in the Advance, not here") is the highest-value feedback available
   for near-zero cost.
3. **Refutation shadow lines** — after a miss, optionally store the engine's punishment
   a few plies deep, tagged as a refutation: **stored but never prep, never carded, never
   walked by the build seed**. If this ever produces an SRS card, the feature is wrong.

The log also feeds growth: expand the frontier where the user is weak rather than
uniformly.

## Data model deltas

| Change | Table | Note |
|---|---|---|
| `line_tags text[] not null default '{}'` | `moves` | ✅ applied, migration `0005_line_tags`. Inherited on insert |
| new `explorer_entries` | — | ✅ applied, migration `0006_explorer_entries`. Cache; safe to truncate |
| new `drill_attempts` | — | Append-only; cascade from `moves` |
| `scope` field | `repertoires.drill_rules` (jsonb) | ✅ shipped. Partial, via `mergeDrillRules()`; validated on write by `parseLineScope` |

Refutation shadow lines need a marker on `moves` distinguishing them from prep — either a
value in `line_tags` or a dedicated column. Prefer a dedicated column if the walker,
queue builder, and export all need to exclude them, since a tag that *must* be checked
everywhere is an invariant with no enforcement.

Interaction with the v2 `option_label` idea
([data-model](../02-architecture/data-model.md#v2-shape-to-avoid-painting-into-a-corner)):
scopes are a *filter* over rows, `option_label` would be a *key* distinguishing rows. They
are orthogonal — do not conflate them, and do not implement scopes in a way that assumes
one prep row per `(user, parent_position)` beyond the existing constraint.

## Phasing

| | Work | Unlocks |
|---|---|---|
| **9a** ✅ | `line_tags` + inherit-on-insert; derived opening-name scope; `DrillRules.scope` + picker | Request 1, entirely — no network |
| **9b** ✅ | `explorer_entries` + Lichess explorer client; candidate ranking in `packages/shared` — see [explorer](explorer.md) | The supply side of request 2 |
| **9c** ✅ | Opponent auto-expand; ranked candidate UI in the build phase; frontier prefetcher | Request 2 — the seamless part |
| **9d** | `drill_attempts`; mistakes scope; interference detection; refutation shadow lines | Mistake rehearsal |

9a is independently valuable and touches no network or new data source — ship it alone.

**Reminder:** any change to drill behavior here must be applied to all
[three drill implementations](srs-drilling.md#three-drill-implementations-known-debt), or
scoping will silently work in one session type and not another.
