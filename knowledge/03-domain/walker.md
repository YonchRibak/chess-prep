# The walker

**Source:** [apps/web/src/lib/walker/walker.ts](../../apps/web/src/lib/walker/walker.ts)
· **Tests:** [walker.test.ts](../../apps/web/src/lib/walker/walker.test.ts)
· **UI:** [pages/WalkerSession.tsx](../../apps/web/src/pages/WalkerSession.tsx)

The walker is a pure traversal over a repertoire tree that answers one question: *what
node needs the user's attention next?* Build and drill are the same UI over the same
traversal, differing only in the **seed** that picks nodes.

## Indices

`buildIndices(rep)` → `WalkerIndices` with three maps: `positionByKey`, `positionById`,
`movesByParent`. Every other function takes these; build them once per session, not per
step.

## Attention nodes

A position needs attention when it has **no live (non-dropped) outgoing move** of the
relevant kind:

- **user turn** → `kind: 'user-prep'` — "What's your move?"
- **opponent turn** → `kind: 'opponent-picks'` — "Which responses do you want to prepare?"

`WalkerNode` carries `position`, `kind`, `depth` (plies from root), `existingMoves`
(live only), and `path` (moves from the root).

Coverage is **derived**, not stored — recomputed from outgoing moves each step.

## Build seed — `findNextBuildNode(rep, indices, options)`

BFS from the repertoire root, returning the **first** position needing attention.
BFS is what produces round-robin: every ply-3 user-turn position is visited before any
ply-4 one. Property: at any stopping point you have *some* coverage against every
defense — never "deeply prepped against one, zero against another".

Options:
- `fromFenKey` — start BFS elsewhere (used by "keep building this branch").
- `exclude: Set<positionId>` — session-local **skip**. Since an attention node has zero
  live children by definition, there's nothing to descend into; skipping just moves to
  the next sibling branch.
- `scope` / `openingLookup` — Phase 9a, see below.

Dropped moves and their entire subtrees are skipped. Returns `null` when everything
reachable is covered.

`findNextBuildNodeFrom(...)` is the localized variant used after drill-pauses-for-build.

### Scoped building

With a [line scope](srs-drilling.md#line-scopes-phase-9a) the build seed keeps building
*inside one line*. A candidate node is judged by the **edge that reached it** — an
attention node has no outgoing moves, so it has no tags or name of its own.

Consequence worth knowing: under a non-`all` scope the **root is never offered**, because
no edge leads into it. Scoped building only makes sense once the line exists; starting one
needs scope `all`. `WalkerSession` resolves the scope once at session start and holds it
in a ref, so the `resumeBuild` path can't close over a stale value and quietly fall back
to building the whole tree.

## Drill seed

The drill queue ([queue.ts](../../apps/web/src/lib/drill/queue.ts), oldest-due-first)
drives node selection. When the queue lands on an unprepped opponent-reply target, the
walker falls through to the build path for that one node.

`pickOpponentReplyForDrill(...)` chooses which saved branch auto-plays at a branched
opponent node: **most-due-child wins**, so drilling effort tracks forgetting. (The build
seed instead round-robins.)

## Drill-pauses-for-build

The pattern that makes the loop continuous — coverage gaps get found through normal use
and cost one click to fill:

1. The card that led here is graded normally.
2. The opponent's saved reply auto-plays (or none).
3. If the resulting node has no user-side prep, the panel becomes **"Your move — build"**
   with a soft "New prep" label. No modal, no mode switch.
4. The user adds the move; an SRS card is created.
5. One prompt: *"Keep building this branch?"* — **defaults to "Back to drill"**.

## Path replay (Phase 8c)

`findPathToPosition(...)` returns the move path from the root. Sessions load the board
by **replaying that path**, not by snap-loading a FEN. Consequences worth knowing:

- `rules.history` is the true current line, which drives [MoveLine.tsx](../../apps/web/src/components/MoveLine.tsx).
- Deepest-opening lookup gets the full path (previously it only saw a shallow 2-position
  path in drill mode, producing wrong names).
- The last-move highlight makes branch jumps legible.

## Two gestures — keep them visually distinct

- **Navigate** (click the sidebar tree, or a PGN step button): moves the board to an
  existing position. Creates and changes **nothing**.
- **Set as prep** (play a move on the board, or click a book continuation and confirm):
  saves a `Move`. On the user's turn this also creates an SRS card; on the opponent's
  turn it opens a new branch. *The gesture is what makes it prep — book-ness is
  irrelevant.* Browsing book continuations never creates cards.

## Skip vs Drop

| | Persistence | Effect |
|---|---|---|
| **Skip** | Session-local (`exclude` set) | Resurfaces next session |
| **Drop** | `moves.is_dropped` in the DB | Never resurfaces in either seed; subtree excluded. Undo via the walker sidebar's "Dropped branches" panel or the editor's candidate-move list |

## Coverage stats

`computeCoverage(rep, indices)` → `CoverageStats` for the walker header ("Branch 3 of 5
at ply 5") and the repertoire list badges.

## Prep conflicts

Adding a second user-side move from the same parent violates the
[one-prep-per-position invariant](../02-architecture/data-model.md#invariants-that-are-not-database-constraints).
The server returns `409`; the walker catches it and offers an inline swap confirmation
(no `window.confirm`). The API call carries `onConflict: 'refuse' | 'swap'`.

## Keyboard shortcuts

`s` skip · `↵` back-to-drill · `b` keep building.
