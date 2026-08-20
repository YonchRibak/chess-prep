# Conventions & gotchas

## Stack choices — do not substitute without flagging why

The chess ecosystem lives in JS/TS and the stack follows it deliberately.

| Concern | Choice | Note |
|---|---|---|
| Board | **Chessground** | Smooth drag, premoves, native shape/arrow API. **Do not use chessboard.jsx** |
| Rules | **chess.js** | |
| PGN trees | **@mliebelt/pgn-parser** | Variations, NAGs, comments |
| SRS | **ts-fsrs** | **Do not hand-roll SM-2** |
| State | **Zustand** | No Redux |
| Styling | **Tailwind** | |
| Engine | **stockfish.wasm** in a Worker | Leela out of scope for v1 |
| API | **Hono** + **Drizzle** + Postgres | |

## Code conventions

- **ESM everywhere.** All packages are `"type": "module"`. Note the import-specifier
  style the repo already uses: `.js` extensions in `apps/api` (compiled output) and
  explicit `.ts` extensions in `apps/web` (Vite resolves them). Match the neighbours.
- **Validation is hand-rolled**, not zod — small `ensure*` helpers throwing
  `HttpError(400, msg)`. Keep it consistent rather than introducing a schema library for
  one route.
- **Services take `userId` first** and scope every query by it. Routes supply
  `DEFAULT_USER_ID`. Don't bypass this — it's the seam where real auth lands.
- **Shared logic goes in `packages/shared`** whenever client and server must agree.
- **Comments explain *why*.** The existing code documents rationale (why the gate is at
  module level, why coverage is derived, why queued pushes clear unconditionally). Match
  that density — don't narrate what the code already says.

## Gotchas

**COOP/COEP.** `stockfish.wasm` with threads needs `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Handled in Vite dev;
**production hosting must set them too** or the engine degrades to single-threaded.

**Chessground rendering.** Needs its base CSS, a piece sprite set, and an explicit
container size — it renders 0×0 otherwise.

**FEN parity.** Every path must use `fenKey()` from
[packages/shared/src/fen.ts](../../packages/shared/src/fen.ts). `/openings/by-fen/:fenKey`
treats its param as already normalized and must not re-parse it.

**Deepest-name lookup.** Walk the path from the root and keep the *last* non-null match.
Looking up only the current FEN misses transpositions.

**Engine isolation.** The gate lives at the engine module, not the panel. A future
"enable engine for the editor" feature must not be able to leak eval into a drill running
in another tab or route.

**FSRS persistence.** Store all card fields, not just `due`, or rescheduling breaks.

**New-card accounting.** Count new cards shown today by `lastReview` crossing
`UserSettings.dailyDietLastResetAt` — not with a separate counter. Crash-safe by design.

**`maxDepth: 0` means no upper bound**, not "depth zero". Always read drill rules through
`mergeDrillRules()`.

**Sync conflicts** are last-write-wins by `updatedAt` on SRS cards, in both
`mergeCardsLocal` and the server's `pushCards`.

**Three drill implementations** exist (classic, walker drill seed, daily diet). A
behavior change probably needs to land in all three —
[details](../03-domain/srs-drilling.md#three-drill-implementations-known-debt).

**Parked types are not features.** `OpponentDataset` / `OpponentPosition` /
`OpponentMove` exist in `types.ts` with no tables and no code paths.

## When adding a feature

1. Does logic need to be identical on both sides? → `packages/shared`.
2. Does it touch the tree? → check the [one-prep invariant](../02-architecture/data-model.md#invariants-that-are-not-database-constraints)
   and whether dropped moves must be skipped.
3. Does it show a position during a drill? → confirm the engine is gated.
4. Does it add a view? → update the `View` union, `viewToHash`, `hashToView`, and the
   `App` switch together.
5. Is the new logic pure? → put it in `lib/` with a Vitest suite rather than inside a
   component.
