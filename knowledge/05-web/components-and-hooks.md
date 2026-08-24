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
| [BuilderPrompt.tsx](../../apps/web/src/components/BuilderPrompt.tsx) | The walker's build panel. A union of `UserTurnProps` ("What's your move?") and `OpponentTurnProps` ("Which responses?") — the two build states of the walker. Phase 9c: renders engine+explorer candidates when the caller supplies them, falling back to the plain book list. It never starts analysis itself — engine lines arrive as a prop, because the engine is only ungated during build phases ([engine](../03-domain/engine.md)) |
| [EnginePanel.tsx](../../apps/web/src/components/EnginePanel.tsx) | Eval bar + MultiPV lines |
| [RashidPanel.tsx](../../apps/web/src/components/RashidPanel.tsx) | [Rashid](../03-domain/rashid.md) probe panel in the editor — presentational; the *editor* owns `useRashid` ([lib/engine/useRashid.ts](../../apps/web/src/lib/engine/useRashid.ts)) so the panel and the R4 board arrows read one result. Off by default (a probe costs seconds until R5 precompute); the probe runs on Rashid's dedicated engine, never the eval panel's singleton. While on, board arrows switch to Rashid mode (`rashidShapes`, custom brushes via `Board`'s `extraBrushes`) |
| [RefutationPrompt.tsx](../../apps/web/src/components/RefutationPrompt.tsx) | Phase 9d "Why is *X* bad?" in the wrong-answer card of all three drill surfaces. Analyzes the position the **wrong move** reached — never the card's own — via the engine's one named gate exemption ([engine](../03-domain/engine.md#engine-gating)), and on confirmation stores the PV as a shadow line. Writes nothing until the user clicks save |
| [RepertoireModals.tsx](../../apps/web/src/components/RepertoireModals.tsx) | `Modal`, `BlankRepertoireModal`, `ImportPgnModal`, `DeleteAllRepertoiresModal` — the last requires typing `DELETE`, because it is the only action that destroys **SRS history**, which no PGN re-import restores (a re-imported move returns as a new card) |
| [ui.tsx](../../apps/web/src/components/ui.tsx) | Primitives: `Btn` (variants `default`/`primary`/`ghost`), `Card`, `OverflowMenu`, `ErrorBanner` |

There is no component library — `ui.tsx` is the whole design system. Add primitives there
rather than one-off Tailwind blobs in pages.

## Line navigator (Flow F1)

[pages/LineNavigator.tsx](../../apps/web/src/pages/LineNavigator.tsx) renders the
per-line rows for a repertoire; the aggregation is pure, in
[lib/lines/lineIndex.ts](../../apps/web/src/lib/lines/lineIndex.ts)
([tests](../../apps/web/src/lib/lines/lineIndex.test.ts)).

`buildLineIndex(...)` → `LineNavEntry[]`: "All lines" first, then opening-name entries
nested by boundary prefix, then tag entries. Each entry carries `dueCount` /
`cardCount` / `toBuild` / `recentMisses` and the `LineScope` its Start button launches
with. The counts are built **from `collectDrillCandidates`** (the queue builder's own
candidate pass) and mirror `findNextBuildNode`'s attention/scope rules, so a badge can
never promise a different session than the one it starts. The page warms the name cache
on load; a cold cache shows a "names not cached — go online once" hint instead of
silently listing no named lines (the fail-closed rule in
[srs-drilling](../03-domain/srs-drilling.md#line-scopes-phase-9a)).

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
