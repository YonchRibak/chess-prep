# Services layer

Routes are thin. All validation, chess logic, and transactions live in
[apps/api/src/services/](../../apps/api/src/services/). Every exported service takes
`userId` as its first argument and scopes its queries by it, so swapping in real auth
later is a route-level change only.

Validation is hand-rolled (no zod): helpers like `ensureColor`, `ensureNonEmptyName`,
`parseOnConflict` throw `HttpError(400, …)`. `HttpError` is defined in
[repertoires.ts](../../apps/api/src/services/repertoires.ts) and imported by the others.

## repertoires.ts

The largest and most careful file. Key shapes:

- `RepertoireSummary` — id, name, color, tags, drillRules, `rootFenKey`/`rootFullFen`, timestamps.
- `RepertoireFull` — summary plus `positions[]` and `moves[]`. Moves are **denormalized
  with both `parentFenKey` and `childFenKey`** so the client can index the tree by key
  without joining. This is the payload the walker, drill queue, and IndexedDB cache all
  consume.
- `AddedMove` — includes `childPositionCreated`, telling the caller whether a genuinely
  new node appeared or the move linked into an existing one (a transposition).

| Function | Notes |
|---|---|
| `listRepertoires` / `getRepertoire` / `createRepertoire` / `patchRepertoire` / `deleteRepertoire` | CRUD. `createRepertoire` accepts `seedSans` to auto-insert an opening prefix |
| `addMove` | Single move. See the flow below |
| `appendLine` | Batch, idempotent, transactional. See below |
| `patchMove` | comment / annotation / isMainLine / priority / **isDropped** |
| `deleteMove` | Cascades to the move's SRS card |
| `importPgn` / `exportPgn` | Via `pgnToTree` / `treeToPgn` from shared |
| `patchDrillRules` | Merges partial `DrillRules` |
| `enforceOnePrepPerUserPosition` | The invariant guard — see below |

### `addMove` flow

Everything inside one `db.transaction`:

1. Verify repertoire ownership (`404` if not found).
2. Find the parent `Position` by `fenKey` in this repertoire (`400` if absent — you
   cannot add a move from a position that isn't in the tree).
3. Apply the SAN through **chess.js** from `parent.fullFen` to derive the real SAN, UCI,
   and child FEN. Illegal moves → `400`. This is why the API never trusts client-computed
   child positions.
4. Find-or-create the child `Position` (`uniq_repertoire_fen` makes transpositions reuse
   the existing node), tracking `childPositionCreated`.
5. Insert the `Move`, with `line_tags` inherited from the edge into the parent
   (`parentEdgeTags` → `inheritLineTags`) unless the body supplied its own.
6. If `isUserMove(fenTurn(parent.fullFen), rep.color)`, create the SRS card.

A position can have several incoming edges (transpositions collapse to one node), so
`parentEdgeTags` picks deterministically — main line, then priority, then SAN. An
arbitrary pick would make the same build action produce different tags run to run.

### `appendLine`

Walks a SAN sequence from `fromFenKey` in a single transaction, via the internal
`appendLineCore`. **Idempotent:** any `(parent, san)` edge that already exists is reused,
not duplicated — so re-running the Phase 6 "Add to my repertoire" flow reports
`added: 0, reused: N`. New SRS cards are created for newly-inserted user-turn moves.
Bumps `repertoires.updatedAt` only when something was actually added.

Tags are threaded down the walk: each new move inherits from the move above it, and a
**reused** edge contributes *its own* tags to what follows — so appending through an
existing tagged branch keeps that branch's tags rather than the caller's starting point.

### `patchMove` and retagging

Setting `lineTags` cascades the new set over the move's whole subtree (`retagSubtree`,
which walks dropped edges too, since a dropped branch can be restored later). Retagging
re-roots inheritance, and without the cascade tagging a branch point would tag exactly
one move — a tag-scoped session would then drill that single card and look finished.

### The one-prep invariant

When the next SAN would create a *new* user-side move at a parent that already has a
different one:

- `onConflict: 'refuse'` (default) → **409**. Safe for idempotent reuse paths.
- `onConflict: 'swap'` → delete the old user-side move first. The cascade drops its
  `SrsCard`, so **SRS history is not preserved through a swap in v1**. Used only when
  the user explicitly confirms a prep change.

Covered by
[repertoires.invariant.test.ts](../../apps/api/src/services/repertoires.invariant.test.ts) —
this test exists specifically so a refactor cannot silently allow two prep moves per
position. Keep it passing.

## openings.ts

Read-only queries over `opening_book_entries`:
`listOpenings({ q, eco, limit })`, `getOpeningByFenKey`, `getBookContinuations`,
`identifyDeepestOpeningFromPath`, `lookupOpeningsByFenKeys` (Phase 9a bulk map, no path
walk — it feeds the client's offline name cache),
and `validateAndNormalizeFenKey` (the guard that keeps
path params from being re-parsed inconsistently). Matching logic itself is shared with
the client — see [opening-database](../03-domain/opening-database.md).

## explorer.ts

Phase 9b read-through cache over the lichess opening explorer. The rule that shapes the
whole module: **it never throws.** A failed fetch returns the stale row, or `null`; a `429`
arms a 60-second global backoff. Selection policy lives in `packages/shared`, not here, so
both sides rank identically. Details and the local 401 gotcha:
[explorer](../03-domain/explorer.md).

## srs.ts

- `pullCards(userId, since?, repertoireId?)` → `{ cards, serverTime }`. `serverTime`
  comes from the server clock and becomes the client's sync watermark.
- `pushCards(userId, updates)` → `{ accepted, ignored, cards }`. **Last-write-wins by
  `updatedAt`**; a stale update is counted in `ignored` rather than erroring, and the
  canonical rows come back in `cards`.

## userSettings.ts

- `getUserSettings(userId)` — seeds defaults on first read (get-or-create).
- `patchUserSettings(userId, input)`.
- `maybeResetDailyDiet(userId, now = new Date())` — rolls `dailyDietLastResetAt` forward
  when the day boundary has passed. This timestamp is the *only* new-card accounting
  state; "new cards shown today" is counted by `lastReview > dailyDietLastResetAt`.

## Database access

Single Drizzle client, `postgres-js` pool with `max: 10`
([db/client.ts](../../apps/api/src/db/client.ts)). Migrations run via
[db/migrate.ts](../../apps/api/src/db/migrate.ts) (`pnpm db:migrate`), which also seeds
the `DEFAULT_USER_ID` user row.
