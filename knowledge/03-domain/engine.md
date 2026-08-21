# Engine & gating

**Module:** [apps/web/src/lib/engine/engine.ts](../../apps/web/src/lib/engine/engine.ts)
(class `Engine` + `getEngine()` singleton) ·
**Hook:** [useEngine.ts](../../apps/web/src/lib/engine/useEngine.ts) ·
**Tests:** [engine.test.ts](../../apps/web/src/lib/engine/engine.test.ts)

Stockfish WASM in a Web Worker, spoken to over UCI, so analysis never blocks the UI.
Leela is out of scope. The engine **evaluates and does nothing else**.

## Startup

Assets are static under [apps/web/public/stockfish/](../../apps/web/public/stockfish/)
(`bootstrap.js`, `stockfish.js`, `stockfish.wasm`, `stockfish.worker.js`), not a bundled
import.

`init(timeoutMs = 15000)` spawns `new Worker('/stockfish/bootstrap.js')`, posts
`__init__`, waits for `__ready__`, then does the UCI handshake (`uci` → wait for
`uciok`, then `isready`, `ucinewgame`). Bootstrap diagnostics arrive as
`__bootstrap__:`-prefixed messages and are collected so a timeout reports *why*. A
failed `readyPromise` is reset to `null` so a retry is possible.

`AnalyzeOptions`: `depth` (default 18) *or* `movetime`, plus `multipv` (default 1).
`parseInfo(line)` turns a UCI `info` line into an `EngineLine`; subscribe with
`onProgress(fn)`.

Helpers: `whiteCp(line, turn)` normalizes scores to White's perspective — engine scores
are from the side to move, so this matters for the eval bar — and `formatEval(line)`
renders cp/mate for display.

## Cross-origin isolation

`stockfish.wasm` with threads needs `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Configured in
[vite.config.ts](../../apps/web/vite.config.ts) for dev; **production hosting must set
the same headers** or the engine falls back to single-threaded.

## Gating — the hard guarantee

The product promise is that the engine never leaks a card's answer. This is enforced at
the **module singleton**, not by hiding a panel:

```ts
getEngine().setGated(true)
```

While gated:
- `analyze()` is a **no-op**;
- any in-flight analysis is immediately `stop`-ed;
- the worker is **not** torn down, so re-enabling is cheap.

There is therefore no DOM panel to peek at and no worker chatter to inspect. The flag
lives at module level specifically so a future "enable engine for the editor" feature
cannot leak eval into a drill running in another route or tab. `useEngine` takes a
`gated` prop that flows into the same mechanism.

`engine.test.ts` asserts that a gated `analyze()` emits **only** `stop` and never `go`.
Do not weaken that test.

**One named exemption (Phase 9d):** `AnalyzeOptions.bypassGate` runs a single analysis
while the gate stays closed for everyone else. It exists for refutation shadow lines,
which need an eval *during* a drill — but of the position the user reached by playing the
**wrong** move, which is not the card's position and holds no answer to leak. It is an
exemption rather than a `setGated(false)` / `setGated(true)` sandwich precisely because
the gate is process-wide: toggling it would open a real window for every other consumer.
Its only caller is
[RefutationPrompt](../../apps/web/src/components/RefutationPrompt.tsx). Do not add a
second one without the same argument.

### Who gates what

| Surface | Engine |
|---|---|
| [DrillSession](../../apps/web/src/pages/DrillSession.tsx) | Gated for the whole mount |
| [DailyDiet](../../apps/web/src/pages/DailyDiet.tsx) | Gated for the whole mount |
| [WalkerSession](../../apps/web/src/pages/WalkerSession.tsx) | Gated **per phase** — build phases (`attention`, `drill-paused-for-build`) run the engine, since there's no card answer to leak while authoring prep; every drill phase re-gates |
| Repertoire editor, opening browser | Ungated |

After a card is graded, revealing eval is allowed only if the per-repertoire
`evalAfterAnswer` drill rule is on; if off, it stays hidden for the whole session.

Both drill and daily sessions un-gate on unmount.

## Analysis surfaces

- [EnginePanel.tsx](../../apps/web/src/components/EnginePanel.tsx) — eval bar + MultiPV lines.
- [arrows.ts](../../apps/web/src/lib/engine/arrows.ts) — top-3 moves as Chessground shapes,
  best = green then blue / yellow (`BRUSH_HEX`, `brushForRank`, `colorForRank`).
  Tested in [arrows.test.ts](../../apps/web/src/lib/engine/arrows.test.ts).
- [healthCheck.ts](../../apps/web/src/lib/engine/healthCheck.ts) — batch-evaluates every
  move in a repertoire and flags any that is N centipawns worse than the top move
  (`MoveAssessment`, `HealthCheckProgress`, `DEFAULT_HEALTH_OPTIONS`). UI:
  [pages/HealthCheck.tsx](../../apps/web/src/pages/HealthCheck.tsx).
