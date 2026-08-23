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
| **Explorer** (`explorer_entries` + `explorer_snapshot_entries`) | *which opponent replies matter* — frequency and W/D/L | cache, and (F3) the bundled snapshot |
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

## The bundled snapshot (Flow F3)

Table `explorer_snapshot_entries` — same shape as the cache minus `fetched_at`
semantics (`generated_at` describes the whole dataset). **Not merged into
`explorer_entries` on purpose:** that table is a truncatable cache, and the snapshot
must survive truncation. It is not a cache at all — it is vendored data, imported like
the ECO book.

The service answers in tier order — **fresh cache → live fetch → stale cache →
snapshot → null** (`getExplorerEntryWithTier`; a stale cache row beats the snapshot
because it is newer). The route and `probe:explorer` surface `tier`, and a snapshot
entry's `source` carries its date stamp (`…:snapshot@2026-08-22`) so a UI can label
staleness. The never-throws contract is unchanged, and consumers need zero changes:
`selectOpponentReplies`, `rankUserCandidates`, auto-expansion, and the prefetcher all
take an `ExplorerEntry` and don't care which tier produced it. The 9c rule "only
explorer-sourced candidates authorize a write" is *satisfied*, not weakened — a
snapshot is real frequency data, merely old, and opening statistics move over months.

Workflow (see the data README in
[apps/api/data/explorer-snapshot/](../../apps/api/data/explorer-snapshot/README.md)):
`snapshot:build` runs a BFS from the start position (default 12 plies, 2% share
floor) against the live explorer — run it **from a machine where the host answers**
(the primary dev box can't; that's the point) — and vendors JSONL;
`db:import-explorer-snapshot` drop-and-reloads the table, re-normalizing every fenKey
through `fenKey()` (the same parity guard as the book importer). Regenerate ~yearly.

**Game-weighted coverage (F3.2)** lives in
[packages/shared/src/coverage.ts](../../packages/shared/src/coverage.ts):
`computeGameWeightedCoverage` walks the (scoped) tree pushing probability mass through
explorer shares — prepared replies keep flowing, unprepared ones are uncovered, mass at
a cold node is *unknown* rather than guessed, and `gameWeightedCoverageUsable` gates
display so the meter falls back to the structural count instead of showing a made-up
percentage. The guided walker reads entries `cachedOnly` via
[gameCoverage.ts](../../apps/web/src/lib/walker/gameCoverage.ts) — the meter must never
trigger live lichess fetches.

## Selection policy

Pure, in [packages/shared/src/explorer.ts](../../packages/shared/src/explorer.ts) with
[tests](../../packages/shared/src/explorer.test.ts), so client and server rank identically.

**`selectOpponentReplies(entry, sideToMove, policy?)`** — descending frequency, taking
moves until the kept set covers ~80% of games, skipping anything under 5%, capped at 3,
and refusing entries under 20 games. Returns `[]` when cold or too thin, and the caller
falls back to book continuations. The cap is what stops Phase 9c auto-expansion from
exploding the frontier: opponent moves carry no SRS card, but each still widens the set of
positions the user will later be asked about.

The `policy?` param is how Flow F2's **prep targets** plug in: a guided session passes
`{ minShare }` from the repertoire's `drillRules.prepTarget`
([prep.ts](../../packages/shared/src/prep.ts) presets: 5% / 2% / 20%) through
`getOpponentCandidates({ policy })`, so "broader" preps rarer replies and "main lines"
fewer — same selection mechanism, different floor.

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

## The 401, properly diagnosed (2026-08)

The long-standing "explorer answers 401 on the dev machine" was **not** a local or
network problem. Re-diagnosis showed the 401 comes from lichess's own nginx on **every**
network tried (home ISP, mobile hotspot, VPN — v4 and v6), on both hostnames
(`explorer.lichess.ovh` and the spec's documented `explorer.lichess.org`, same server),
regardless of browser-like headers. The response is `401 Authorization Required` and its
CORS allow-list includes `Authorization` — the host now refuses **anonymous** requests.

Both the cache service and the snapshot generator therefore send
`Authorization: Bearer $LICHESS_TOKEN` when `LICHESS_TOKEN` is set in `apps/api/.env`
(a lichess personal access token, no scopes — see
[dev-setup](../06-workflows/dev-setup.md)). Without a token, requests still go out
anonymously and the service degrades exactly as before: cache → snapshot → book. The
default hostname is now the documented `explorer.lichess.org`.

**Since Flow F3 a cold live host is mitigated regardless:** once the snapshot is
imported, the snapshot tier answers for the common opening positions, so guided building
ranks replies by real frequency; only positions outside the snapshot's depth/floor fall
back to the book. Diagnose with `pnpm --filter @chess-prep/api probe:explorer`, which
prints **which tier answered** (`live` / `fresh-cache` / `stale-cache` / `snapshot` /
`none`) and warns specifically on a 401; the service's silence is otherwise deliberate,
so the probe is how you tell "no data" from "broken".
