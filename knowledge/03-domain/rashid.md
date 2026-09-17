# Rashid — trap-finding analysis

**Core:** [rashid.ts](../../packages/shared/src/rashid.ts) ·
**Tests:** [rashid.test.ts](../../packages/shared/src/rashid.test.ts) ·
**Spec:** [rashid-engine-spec.md](../../rashid-engine-spec.md) (the math) ·
**Plan:** [rashid-dev-plan.md](../../rashid-dev-plan.md) (spec critique + phases R0–R6)

Rashid rides on MultiPV engine output and reframes it: instead of "best move under
perfect play", it looks for a hero move that forces the opponent onto a tightrope of
consecutive **only-moves**, and scores the line as **Risk** (outcome under perfect
defense), **Reward** (floor/max punishment when they slip), and **Length** (pinch-point
count). A board arrow encodes all three.

## What is built (plan Phases R1 + R2, R0 harness)

The **pure domain core** in `packages/shared` — engine injected as a single async
`RashidAnalyzeFn(fen, multipv)`, which is why every branch is unit-testable against a
scripted fake:

- `wp()` — cp → win-probability (Elo logistic); **all** gap/threshold decisions happen
  in wp space, so thresholds behave identically in quiet and sharp positions.
- Mate sentinel scheme (`MATE_BASE ± N`) — orders "mate in 3" > "mate in 5" > any cp;
  sentinels clamp to wp 0/1, which is what stops already-won positions lighting up.
- `detectOnlyMove()` — the atomic §3 operation on an opponent node.
- `rashidAnalyze()` — the §4 walk: root candidates → forced-line traversal → ranked
  `RashidResult`, including a per-candidate **"why not" trace**
  (`RashidCandidateDiag`: prefiltered / no-tightrope+end-reason / cap-busted /
  qualified). A silent rejection is indistinguishable from blindness — the trace is
  what R6 tuning and any human asking "why no arrow here?" read.
- `DEFAULT_RASHID_CONFIG` + `rashidConfigKey()` — the config hash destined for the
  derived-result cache key.

Plus `AnalyzeOptions.nodes` on the [engine](engine.md) (`go nodes N`) — node-limited
single-threaded searches are reproducible, which depth-limited ones are not; that
reproducibility is what makes results cacheable (plan §C2).

**R2 — the adapter and cache layer A**
([rashidAdapter.ts](../../apps/web/src/lib/engine/rashidAdapter.ts) +
[rashidAdapter.test.ts](../../apps/web/src/lib/engine/rashidAdapter.test.ts)):
`createRashidAnalyzeFn({nodes})` wraps the real `Engine` behind the domain core's
injected interface, with

- a **sequential queue** (`Engine.analyze` cancels in-flight work, so interleaved
  callers would eat each other's searches);
- **gate fail-fast**: a gated engine is refused with a thrown error *before* init —
  `analyzeOnce` on a gated engine would hang forever, and the check runs again after
  every await in case the gate closed mid-call;
- **cache layer A** — the `rashidRaw` IndexedDB store
  ([idb/schema.ts](../../apps/web/src/lib/idb/schema.ts), db v4), keyed by
  `rashidRawKey(fenKey, engineId, nodes, multipv)`. The engine id comes from the UCI
  `id name` line (`Engine.getEngineId()`). A cache hit with a supplied `engineId`
  resolves **without touching the engine at all** — cached positions keep working even
  if wasm fails to boot offline. Side-to-move POV, hero- and config-independent.

**R0 harness + decision** — [RashidLab.tsx](../../apps/web/src/pages/RashidLab.tsx) at
`#/rashid-lab` (no nav entry; type the hash): times real searches across node budgets
and MultiPV widths (cache off), projects per-position cost via the plan-C1 arithmetic
(1×pv8 + 6×pv4 + 2×pv1), and runs live `rashidAnalyze` on any FEN through the real
adapter. **Measured and decided** (numbers in the plan's R0 section): ~3s/position at
300k nodes → in-browser precompute confirmed; budgets 1M (precompute) / 300k (live).
Two findings that shape later phases: MultiPV width is time-free at fixed nodes (the
budget is split across lines — width wants *more* nodes, not fewer), and the bundled
wasm engine is **classical eval, not NNUE**, which undervalues speculative sacrifices
— the quality risk logged for R6.

### Invariants the tests pin down

- **Laziness** — engine calls are Rashid's entire cost (plan §C1). The walk never
  issues a call past a failed only-move check, never analyzes a prefiltered root
  candidate's subtree, and never pays a search for a **forced** (single-legal) reply.
  Asserted via the fake engine's call log; don't weaken those assertions.
- **Forced replies are not pinch points** — they extend the line but add no Length and
  no reward entry. Without this, every check sequence inflates into a fake tightrope
  (plan §C4).
- **Repetition terminates the walk** — keyed by `fenKey()` so clock-only differences
  still match; a cycling "tightrope" (perpetual) scores as the draw it is.
- **A qualifying line must survive the sacrifice cap twice** — a cheap root prefilter
  (skip the walk) and the real post-walk check on the perfect-defense outcome.

**R3 — live probe + cache layer B**
([rashidLive.ts](../../apps/web/src/lib/engine/rashidLive.ts) ·
[useRashid.ts](../../apps/web/src/lib/engine/useRashid.ts) ·
[RashidPanel.tsx](../../apps/web/src/components/RashidPanel.tsx) ·
tests [rashidLive.test.ts](../../apps/web/src/lib/engine/rashidLive.test.ts)):
`requestRashid(fen, heroColor)` is a layer-B read-through probe on a **dedicated
engine instance** — the editor's eval panel keeps the singleton busy, and sharing one
engine would make the panel and the walk cancel each other's searches (a superseded
`analyzeOnce` never resolves). The `rashidResults` store (db v5) keys derived results
by `(fenKey, heroColor, engineId, nodes, rashidConfigKey)` — retuning any constant
changes the key, so a stale derivation can never be served. Probes are serialized,
cancellable (`RashidCancelled` is control flow, not an error), and **tiered**: a live
request first looks for a `PRECOMPUTE_TIER` entry (1M nodes, full walk — strictly
better), then `LIVE_TIER` (300k, `maxPly: 4`), and only computes at the live tier on
a double miss. A custom cfg/nodes override checks only its own exact tier — a tuned
request must never be answered from a differently-tuned entry. **Cross-instance gate rule, tested:** every
probe checks the *singleton's* gate before starting and before every search — while
a drill is in progress, Rashid answers nothing, even from cache, even on its own
worker. The `RashidPanel` in the repertoire editor (below the engine panel) surfaces
the result as data — off by default until R5 precompute makes hits instant.

**R4 — board arrows**
([rashidArrows.ts](../../apps/web/src/lib/engine/rashidArrows.ts) +
[rashidArrows.test.ts](../../apps/web/src/lib/engine/rashidArrows.test.ts)):
spec §9 adapted to chessground 9.2 — **hue = risk band** (four quantized custom
brushes; a smooth gradient is impossible, brushes are a named set), **thickness =
reward floor** (per-shape `modifiers.lineWidth`), **badge digit = length** (shape
`label`). Secondary lines render as pale brush variants, capped at 2. Chessground
brushes cannot dash, so the spec's color-blind-safe stroke is replaced by a different
rule: the hue is never the only channel — the `RashidPanel` always shows the exact
numbers next to the board. Custom brushes register through `Board`'s `extraBrushes`
prop (init-time, merged over chessground's defaults). **Arrow-mode precedence:**
while the probe toggle is on, the board's shapes belong to Rashid (a no-trap answer
is an *empty* board); the engine's top-3 arrows return when it is off — the two arrow
languages never mix.

**R5 — background precompute**
([rashidPrecompute.ts](../../apps/web/src/lib/engine/rashidPrecompute.ts) +
[rashidPrecompute.test.ts](../../apps/web/src/lib/engine/rashidPrecompute.test.ts)):
`runRashidPrecompute(repertoire)` walks the hero-to-move positions **BFS-shallowest
first** (transpositions once; dropped and refutation subtrees excluded — the user
never plays toward those) and runs the precompute tier on each, filling both cache
layers so editor probes become instant. Sequential healthCheck-style loop with
progress, cancellation, and a third engine instance (live probes stay snappy).
Two deliberate deviations from the plan, both recorded there:

- **Depth order, not game-weighted explorer order** — explorer data must never be a
  dependency of something that has to work fully offline; depth is the offline-safe
  "common first" proxy.
- **No invalidation hooks** — both cache layers are keyed by *position*, so a
  repertoire edit cannot make an entry stale; it only changes which positions are
  worth computing. Re-running is the invalidation: old work hits layer B instantly.

**Pause, not abort, while drilling:** the loop waits on the singleton's gate and
resumes when the drill ends — the third worker is outside the gate's reach, so the
loop enforces the no-leak rule itself. Progress UI (run/resume/stop, counts, pause
indicator) lives in the `RashidPanel`'s precompute section.

**Study scan (S4)** — the same runner, lifted into its own store with a *findings*
list: [store/rashidScan.ts](../../apps/web/src/store/rashidScan.ts) +
[rashidScan.test.ts](../../apps/web/src/store/rashidScan.test.ts).

- **Outlives the view.** The editor's precompute died on unmount; a scan started
  from the Studies home or the browser keeps running while the user goes to Today
  (it still pauses while drilling). A small indicator in the app header shows
  progress from anywhere and opens the study. Only `cancel()` or a `start()` on
  another study stops it; a run token makes a superseded run's callbacks inert.
- **Findings, not counts.** `runRashidPrecompute` gained `onResult(pos, result,
  fromCache)`; the store keeps the lit ones as `RashidFinding { pathSans, lineTags
  (chapter), viaMoveId, best }` so the browser can list and jump to them. A rerun on
  the same study keeps its findings (layer-B hits are the "invalidation"); another
  study resets them.
- **Alternates included, for studies.** `heroPositionsInPriorityOrder(rep, {
  includeDropped })` — off elsewhere (a dropped branch is one the user rejected),
  **on by default for study repertoires**: a demoted alternate is a line the user
  wrote down and may want to know is a trap. Shadow lines stay excluded.
- **Reproducible from cache.** `loadFromCache` rebuilds the list from layer B
  without engine time, precompute tier before live tier, using
  `resultKeyForTier` — the exact key the writer uses, exported so reader and writer
  cannot drift. It needs the engine build id (`rashidEngineId()`), so a wasm boot
  failure offline leaves the list empty while the cache stays intact.

## What is NOT built

- **R6** — tuning pass + triviality filter.
- The study browser's probe toggle, like the editor's, defaults to **off**; the scan
  runs on the precompute engine, the probe on the live one.
- The editor probe toggle still defaults to **off** even after a precompute run
  (flipping it needs a persisted per-user/per-repertoire setting — a cheap follow-up,
  not built).
- Off-tree opponent deviations are not precomputed — the live probe covers them on
  demand.

## Rules for future phases

- **Gating:** Rashid surfaces are engine surfaces — never rendered during an
  unanswered card. Subtler: the singleton's gate is **per-instance**, so a dedicated
  precompute `Engine` would bypass it; precompute must pause on the same "drilling
  now" signal that gates the main engine, because the no-leak guarantee is about
  worker chatter, not panels ([engine.md](engine.md), plan §C10).
- **Cache layer B** (R3) keys by `(fenKey, heroColor, rashidConfigKey)` — never weld
  derived results to anything less than the full config, and never store them in
  layer A.
- Caches are derivable artifacts: **client-side only, never synced** to the API.
