# Components & hooks

Styling is Tailwind ([tailwind.config.js](../../apps/web/tailwind.config.js),
[index.css](../../apps/web/src/index.css)). React 18, function components only.

## Hooks — the four wrapped concerns

Per the [separation-of-concerns rule](../02-architecture/separation-of-concerns.md), each
external library is reached only through its hook.

### `useChessRules(initialFen?)`
[lib/chess/useChessRules.ts](../../apps/web/src/lib/chess/useChessRules.ts) ·
[tests](../../apps/web/src/lib/chess/useChessRules.test.ts)

The chess.js wrapper: legality, legal-move generation, `playSan()`, `history`, undo/redo,
FEN load, and check/checkmate/stalemate flags. `playSan()` is what auto-plays opponent
replies in walkthrough and walker drill. **`history` is the true current line** once the
board is loaded by path replay — it drives `MoveLine` and the deepest-opening lookup.

### `useBoard(opts)` → `BoardHandle`
[lib/chess/useBoard.ts](../../apps/web/src/lib/chess/useBoard.ts)

Chessground lifecycle: mount, orientation/flip, legal-move dests, drag/premoves, and
custom shapes (arrows). It knows nothing about rules. Chessground needs its own CSS, a
piece sprite set, and an **explicit container size or it renders 0×0** — already handled;
don't regress it.

### `useEngine(..., { gated })`
[lib/engine/useEngine.ts](../../apps/web/src/lib/engine/useEngine.ts)

Over the `Engine` singleton. Exposes `EngineHookState` plus `whiteCp()` / `formatEval()`.
See [engine](../03-domain/engine.md) for gating semantics — the `gated` prop is a real
guarantee, not a display toggle.

### `useOpeningId` / `useDeepestOpeningId` / `useBookContinuations`
[lib/openings/](../../apps/web/src/lib/openings/)

80 ms debounce, process-wide in-memory cache. **Prefer `useDeepestOpeningId(pathFens)`** —
single-FEN lookup misses transposed positions whose ancestors are named.

These are for *display*. Anything that must resolve names synchronously or offline —
i.e. [line scopes](../03-domain/opening-database.md#client-hooks) — uses `nameCache.ts` +
`pathNames.ts` instead.

## Components

[apps/web/src/components/](../../apps/web/src/components/)

| Component | Role |
|---|---|
| [Board.tsx](../../apps/web/src/components/Board.tsx) | The board surface; composes `useBoard` |
| [MoveLine.tsx](../../apps/web/src/components/MoveLine.tsx) | SAN move list above the board, from `rules.history` |
| [OpeningHeader.tsx](../../apps/web/src/components/OpeningHeader.tsx) | Auto-identified opening name from `pathFens`; mounted in the browser, editor, and walker. Shows the name only when it *changes* between plies |
| [BuilderPrompt.tsx](../../apps/web/src/components/BuilderPrompt.tsx) | The walker's build panel. A union of `UserTurnProps` ("What's your move?") and `OpponentTurnProps` ("Which responses?") — the two build states of the walker |
| [EnginePanel.tsx](../../apps/web/src/components/EnginePanel.tsx) | Eval bar + MultiPV lines |
| [RepertoireModals.tsx](../../apps/web/src/components/RepertoireModals.tsx) | `Modal`, `BlankRepertoireModal`, `ImportPgnModal` |
| [ui.tsx](../../apps/web/src/components/ui.tsx) | Primitives: `Btn` (variants `default`/`primary`/`ghost`), `Card`, `OverflowMenu`, `ErrorBanner` |

There is no component library — `ui.tsx` is the whole design system. Add primitives there
rather than one-off Tailwind blobs in pages.

## Board interaction rules

Two gestures must stay visually distinct (see [walker](../03-domain/walker.md#two-gestures--keep-them-visually-distinct)):

- **Navigate** — clicking the saved-tree sidebar or a step button. Changes nothing in the
  database.
- **Set as prep** — playing a move on the board or confirming a book continuation. Saves
  a `Move`, and on the user's turn creates a card.

Book continuations are *suggestions*. Browsing them never creates a card; only the
explicit gesture does.

## PWA

`vite-plugin-pwa` is configured in [vite.config.ts](../../apps/web/vite.config.ts), which
also sets the COOP/COEP headers Stockfish threading requires. A full offline pass and
install prompts are Phase 10 work — see [roadmap](../06-workflows/roadmap.md).
