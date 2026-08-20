# Separation of concerns

This is the single most load-bearing architectural rule in the project. Most chess
apps tangle these four and become unmaintainable.

| Concern | Owner | Must NOT |
|---|---|---|
| Draw the board & shapes | **Chessground** | know chess rules |
| Validate moves, generate legal moves, FEN/PGN | **chess.js** | draw anything |
| Evaluate positions | **Stockfish** | do anything else |
| Identify named positions | **Opening DB** | score, draw, or own user data |

Each is wrapped in its own module/hook:

- [`useBoard`](../../apps/web/src/lib/chess/useBoard.ts) — Chessground lifecycle, orientation, shapes.
- [`useChessRules`](../../apps/web/src/lib/chess/useChessRules.ts) — chess.js wrapper: legality, `playSan()`, history, undo/redo, check/mate state.
- [`useEngine`](../../apps/web/src/lib/engine/useEngine.ts) — over the [`Engine`](../../apps/web/src/lib/engine/engine.ts) singleton.
- [`useOpeningId`](../../apps/web/src/lib/openings/useOpeningId.ts) / `useDeepestOpeningId` — book lookup with debounce + cache.

Components compose these; they don't reach past them. If you find yourself calling
Chessground's API from a page component or parsing a FEN by hand outside
[fen.ts](../../packages/shared/src/fen.ts), that's the smell.

## Engine isolation is stronger than the others

The engine layer accepts a **gated** flag. When gated, `analyze()` is a no-op *and*
in-flight analysis is stopped. This is deliberately at the module singleton level, not
in a panel component — so a future "enable engine in the editor" change cannot leak
eval into a drill running in another route or tab. Details in
[engine.md](../03-domain/engine.md).

## Client/server symmetry

Logic that both sides must agree on lives in `packages/shared` — see
[monorepo.md](monorepo.md#packagesshared--the-contract). The two highest-risk cases:

- **`fenKey()`** — the opening importer, the API lookup, and the client tree must all
  normalize byte-identically. Guarded by parity tests
  ([openings.test.ts](../../packages/shared/src/openings.test.ts),
  [import-openings.parity.test.ts](../../apps/api/src/scripts/import-openings.parity.test.ts)).
- **Opening matching** — `identifyOpening` / `identifyDeepestOpening` are used by both
  `POST /openings/identify-deepest` and the client hooks.

## Where scheduling math lives

FSRS runs **on the client** ([scheduler.ts](../../apps/web/src/lib/srs/scheduler.ts)).
The server stores raw card fields and does not compute schedules. This is what makes
offline drilling work — see [local-first](local-first-sync.md).
