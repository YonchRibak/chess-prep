# Opening explorer (Phase 9b)

**Status: built and wired.** The table, fetch/cache service, endpoint, selection policy
(9b) and the walker's candidate UI + auto-expansion (9c) all exist and are tested.

Related: [opening-database](opening-database.md) (the ECO book, a *different* source with
a different job) · [engine](engine.md) · [srs-drilling](srs-drilling.md) ·
[data-model](../02-architecture/data-model.md)

## One job per source

The mistake this design exists to prevent is using one source for all three jobs:

| Source | Its one job | Offline |
|---|---|---|
| ECO book (`opening_book_entries`) | naming, and shallow breadth | yes — bundled |
| **Explorer** (`explorer_entries`) | *which opponent replies matter* — frequency and W/D/L | only from cache |
| Stockfish | *which move the user should play* | yes |

The book cannot rank opponent replies: it has no frequency data and dries up around ply
8–10, so it can say a move has a name but not that it is 62% of games. The explorer
cannot pick the user's move: **popularity is not correctness**. It only re-ranks moves the
engine has already approved.

## The cache

Table `explorer_entries` — `(fen_key, source, total, moves jsonb, fetched_at)`, unique on
`(fen_key, source)`. Service:
[apps/api/src/services/explorer.ts](../../apps/api/src/services/explorer.ts).

- **It is a cache, never a source of truth.** Safe to truncate. Every caller must work
  with it cold, the same rule that keeps the backend non-authoritative for a live drill
  session ([local-first-sync](../02-architecture/local-first-sync.md)).
- `source` encodes the dataset **and its filters** — `lichess:blitz,rapid,classical:1600`.
  The same position has genuinely different statistics per rating band and time control;
  keying on `fen_key` alone would silently blend them. Changing a filter changes the key,
  which retires old rows by construction instead of by a migration.
- `moves` is jsonb, not a child table: it is always read and written whole and it is
  disposable.
- Rows are refetched after 7 days. Opening statistics move over months.

### Failure is a supported state

`getExplorerEntry()` **never throws**. On a network failure, a timeout, or a malformed
payload it returns the stale row, or `null`. A `429` additionally arms a 60-second global
backoff — Lichess asks for wholesale backoff, not per-endpoint retry — during which reads
still serve from cache.

The endpoint mirrors this: `GET /explorer/:fenKey` returns **`200` with `entry: null`** on
a cold miss with no network. A 5xx there would turn a degraded-but-fine situation into a
broken build prompt.

Third-party JSON is validated field by field (`parseExplorerResponse`), not type-asserted.
Totals come from the position's own `white/draws/black` rather than the sum of the
returned moves, because lichess truncates the move list — summing it would inflate every
share to fill a truncated 100%.

## Selection policy

Pure, in [packages/shared/src/explorer.ts](../../packages/shared/src/explorer.ts) with
[tests](../../packages/shared/src/explorer.test.ts), so client and server rank identically.

**`selectOpponentReplies(entry, sideToMove, policy?)`** — descending frequency, taking
moves until the kept set covers ~80% of games, skipping anything under 5%, capped at 3,
and refusing entries under 20 games. Returns `[]` when cold or too thin, and the caller
falls back to book continuations. The cap is what stops Phase 9c auto-expansion from
exploding the frontier: opponent moves carry no SRS card, but each still widens the set of
positions the user will later be asked about.

**`rankUserCandidates(engineLines, entry, sideToMove, policy?)`** — engine first. Moves
more than 50cp below the engine's best are dropped outright, so a popular-but-bad move can
never surface. Among the survivors, which the engine considers near-equivalent, the more
played move goes first: between two sound moves, the one people actually play is the one
with theory behind it and the one the opponent has prepared for. With no explorer entry it
degrades to plain engine order — the offline path. Mate scores are compared on their own
terms rather than converted to centipawns.

`moveScore()` returns `null` below 10 games instead of a number: a 100% score over three
games is noise, and rendering it beside a real figure invites the user to trust it.

## Consuming it (Phase 9c)

[lib/openings/candidates.ts](../../apps/web/src/lib/openings/candidates.ts) composes the
sources and is where UCI becomes SAN (chess.js only, at that one boundary). Engine lines
are matched against the board's FEN before use, so a late result for the *previous* node
can never be offered as prep here.

**The book fallback may be shown, never written from.** `getOpponentCandidates` falls back
to book continuations when the explorer is cold — but the book is ordered
named-then-alphabetical, not by popularity, so its top three after 1.e4 are `a5, a6, b6`.
Displaying that is honest (the panel labels it); silently prepping it is not, which is why
`selectAutoExpandSans` refuses any source but `'explorer'`. See
[walker](walker.md#auto-expansion-phase-9c).

The [frontier prefetcher](../../apps/web/src/lib/openings/prefetch.ts) warms entries for
uncovered positions during idle time. It is purely an optimization: one request at a time,
capped per call, no retries — a failed warm just means the next prompt pays latency it
would have paid anyway.

## Local gotcha

`explorer.lichess.ovh` answers **401 from an nginx** on the primary dev machine, for every
request regardless of headers, while `lichess.org` itself responds normally — so the cache
stays cold there. Diagnose with `pnpm --filter @chess-prep/api probe:explorer`, which
prints the entry or `NULL`; the service's silence is deliberate, so the probe is how you
tell "no data" from "broken". See [dev-setup](../06-workflows/dev-setup.md).
