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
5. Insert the `Move`.
6. If `isUserMove(fenTurn(parent.fullFen), rep.color)`, create the SRS card.

### `appendLine`

Walks a SAN sequence from `fromFenKey` in a single transaction, via the internal
`appendLineCore`. **Idempotent:** any `(parent, san)` edge that already exists is reused,
not duplicated — so re-running the Phase 6 "Add to my repertoire" flow reports
`added: 0, reused: N`. New SRS cards are created for newly-inserted user-turn moves.
Bumps `repertoires.updatedAt` only when something was actually added.

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
`identifyDeepestOpeningFromPath`, and `validateAndNormalizeFenKey` (the guard that keeps
path params from being re-parsed inconsistently). Matching logic itself is shared with
the client — see [opening-database](../03-domain/opening-database.md).

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
