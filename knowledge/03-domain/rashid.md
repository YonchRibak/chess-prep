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

## What is built (plan Phase R1 + R0 groundwork)

The **pure domain core** in `packages/shared` — engine injected as a single async
`RashidAnalyzeFn(fen, multipv)`, which is why every branch is unit-testable against a
scripted fake:

- `wp()` — cp → win-probability (Elo logistic); **all** gap/threshold decisions happen
  in wp space, so thresholds behave identically in quiet and sharp positions.
- Mate sentinel scheme (`MATE_BASE ± N`) — orders "mate in 3" > "mate in 5" > any cp;
  sentinels clamp to wp 0/1, which is what stops already-won positions lighting up.
- `detectOnlyMove()` — the atomic §3 operation on an opponent node.
- `rashidAnalyze()` — the §4 walk: root candidates → forced-line traversal → ranked
  `RashidResult`.
- `DEFAULT_RASHID_CONFIG` + `rashidConfigKey()` — the config hash destined for the
  derived-result cache key.

Plus `AnalyzeOptions.nodes` on the [engine](engine.md) (`go nodes N`) — node-limited
single-threaded searches are reproducible, which depth-limited ones are not; that
reproducibility is what will make results cacheable (plan §C2).

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

## What is NOT built

Everything else — an agent should assume no wiring exists outside `packages/shared`:

- **R2** — web adapter (perspective mapping at the UCI boundary, sequential queue,
  gate fail-fast) and the raw-analysis IndexedDB cache layer.
- **R3** — live probe in the editor.
- **R4** — arrows/badges (quantized brush matrix; see plan §C9).
- **R5** — background precompute over the repertoire tree.
- **R6** — tuning pass + triviality filter.
- **R0's measurement half** — wasm throughput numbers to pick node budgets. The
  `nodes` option exists; nothing has been measured yet.

## Rules for future phases

- **Gating:** Rashid surfaces are engine surfaces — never rendered during an
  unanswered card. Subtler: the singleton's gate is **per-instance**, so a dedicated
  precompute `Engine` would bypass it; precompute must pause on the same "drilling
  now" signal that gates the main engine, because the no-leak guarantee is about
  worker chatter, not panels ([engine.md](engine.md), plan §C10).
- **Adapter must not `await` a gated engine** — `analyzeOnce()` hangs forever while
  gated (`analyze` no-ops, `done` never fires); check `isGated()` and fail fast.
- **Two-layer cache** (plan §C7): raw MultiPV output keyed by
  `(fenKey, engineBuild, nodes, multipv)`; derived `RashidResult` keyed by
  `(fenKey, heroColor, rashidConfigKey)`. Never weld engine work to tuning constants.
- Caches are derivable artifacts: **client-side only, never synced** to the API.
