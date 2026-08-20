# Opening database (ECO book)

A **read-only reference**. The user's repertoire lives in its own tables and never
mutates `opening_book_entries`.

## Source data

The lichess-org `chess-openings` TSVs are vendored at
[apps/api/data/openings/](../../apps/api/data/openings/) as `a.tsv`–`e.tsv` —
**3,733 unique fenKeys**. License is CC0 / public domain, so vendoring is safe. If that
upstream ever breaks, any equivalent ECO TSV works.

## Import

[apps/api/src/scripts/import-openings.ts](../../apps/api/src/scripts/import-openings.ts),
run via:

```
pnpm --filter @chess-prep/api db:import-openings
```

Idempotent: it **drops and reloads** the table from the bundled TSVs. Every row passes
through the shared `fenKey()` normalizer — see [fen-keying](fen-keying.md) for why
parity here is critical, and the two parity tests that guard it.

## Table

`opening_book_entries`: `eco`, `name`, `variation` (nullable), `fen_key` (unique),
`full_fen`, `pgn_moves` (canonical sequence from the start position). Indexed on `eco`
and `name`.

## Endpoints

[apps/api/src/routes/openings.ts](../../apps/api/src/routes/openings.ts) →
[services/openings.ts](../../apps/api/src/services/openings.ts)

| Endpoint | Purpose |
|---|---|
| `GET /openings?q&eco&limit` | Search by name substring and/or ECO code |
| `GET /openings/by-fen/:fenKey` | Exact lookup. Param treated as **already normalized** |
| `GET /openings/continuations/:fenKey` | Known named moves from this position |
| `POST /openings/identify-deepest` | Path-walk lookup in one round trip |

## Deepest-name lookup

**Walk the path from the root and keep the last non-null match** — do not look up only
the current FEN. Positions reachable by transposition may have an unknown immediate FEN
while their ancestors are known. When the current position is off-book but an ancestor
matched, the UI suffixes "…".

Matching logic is shared: `identifyOpening` / `identifyDeepestOpening` in
[packages/shared/src/openings.ts](../../packages/shared/src/openings.ts), used by both
the endpoint and the client hooks.

## Client hooks

[apps/web/src/lib/openings/useOpeningId.ts](../../apps/web/src/lib/openings/useOpeningId.ts):
- `useOpeningId(fen)` — single-position identity.
- `useDeepestOpeningId(fenKeysAlongLine)` — the one to prefer; takes the whole line.
- `formatOpeningId(id)` — display string.

Both use an 80 ms debounce and a **process-wide in-memory cache**.
[useBookContinuations.ts](../../apps/web/src/lib/openings/useBookContinuations.ts)
fetches suggestions for build prompts.

Two non-hook helpers exist for Phase 9a
[line scopes](srs-drilling.md#line-scopes-phase-9a), which need names *synchronously and
offline* and therefore cannot use the hooks:
- [nameCache.ts](../../apps/web/src/lib/openings/nameCache.ts) — bulk-fetches the names
  for a repertoire's positions (`POST /openings/by-fens`) into IndexedDB, and returns
  whatever is cached when the network fails.
- [pathNames.ts](../../apps/web/src/lib/openings/pathNames.ts) — one BFS per tree that
  gives every position its deepest name, replacing per-node lookups. It follows dropped
  edges too: naming answers "where am I in theory", which doesn't change because the user
  declined to prep a branch.

## Auto-naming UI

[components/OpeningHeader.tsx](../../apps/web/src/components/OpeningHeader.tsx) wraps
`useDeepestOpeningId` and is mounted in the opening browser, the repertoire editor, and
the walker. It refines as the user goes deeper ("Caro-Kann Defense" → "Caro-Kann
Defense, Advance Variation").

**Density rule:** show the name only when it *changes* between plies, not on every move.

## Browser & repertoire creation

[pages/BrowseOpenings.tsx](../../apps/web/src/pages/BrowseOpenings.tsx): search box +
ECO letter chips (A–E) + free-form ECO filter, debounced. Results group by base name —
bare line first, then variations alphabetically. Clicking loads the position and replays
`pgn_moves` into a local SAN list; free play extends the line, with breadcrumb / back /
start controls.

**"Add to my repertoire"** picks an existing repertoire or creates a new one (name
prefills with the deepest match, editable), then commits the navigated SAN list via
`POST /repertoires/:id/moves/batch` → the `appendLine` service. That walks the line in a
single transaction, idempotent on `(parent_position, san)` — a re-run reports
`added: 0, reused: N`. New SRS cards are created for newly-inserted user-turn moves.

For new repertoires, `createRepertoire({ seedSans })` auto-inserts the chosen opening's
prefix (a top-level opening like "French Defense" → 2 plies; a deep variation like
"King's Indian, Sämisch" → 9 plies) and the build session opens right after it.
