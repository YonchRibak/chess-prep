# Rashid — Development Plan

Companion to [rashid-engine-spec.md](rashid-engine-spec.md). Part 1 challenges the spec
and records amendments we should adopt; Part 2 maps Rashid onto this repo's
architecture; Part 3 is the phased build plan. The spec owns the math; this doc owns
the engineering reality.

---

## Part 1 — Spec review

### What holds up

- **Win-probability space for all gap/threshold decisions** (§2–3) is the right call and
  self-regulating: near-mate sentinels clamp to 0/1, so already-won positions stop
  lighting up for free — no special-casing needed.
- **The Reward floor is mathematically a true floor** (§5): at pinch point *i*, the
  second-best opponent move is the *least bad* alternative, so *any* deviation yields
  hero ≥ `miss_eval_i`, and moves below the MultiPV cutoff are even worse for the
  opponent. `min_i miss_eval_i` is therefore a genuine lower bound *conditional on the
  opponent erring anywhere on the tightrope*. Two caveats: (a) it's conditional — the UI
  label must not read as unconditional (see C9); (b) fixed-depth eval noise can violate
  the ordering in practice, which is a display caveat, not a logic bug.
- **The single-function engine abstraction** (§1) is exactly what makes the domain logic
  unit-testable with a scripted fake engine. Keep it sacred.
- **The asymmetric hero/opponent treatment** (§4) — speculative only at the root,
  engine-best inside the line — is the correct product shape.
- **The MVP staging** (§10) is sound in spirit; Part 3 refines it around this codebase.

### Challenges and amendments

#### C1 — The cost model is the project risk, not the math

The spec never adds up the engine calls. Worst case per position at spec defaults
(`MULTIPV=6`, `MAX_PLY=8`): 1 root search + 6 candidates × (4 opponent nodes at
MultiPV-6 + up to 4 hero nodes) ≈ **up to ~50 fixed-depth searches per position**. On
single-threaded stockfish.wasm at depth 18–24, that is minutes-to-tens-of-minutes *per
position*; a few hundred repertoire positions → a precompute measured in days.

Mitigations (all adopted in Part 3):

1. **Early exit dominates the average case.** Most candidates fail the only-move test at
   the *first* opponent node, so a typical position costs ≈ 1 root search + one
   opponent check per surviving candidate (~5–9 searches), not ~50. The walk should be
   strictly lazy — never analyze deeper than the first failed check.
2. **Root prefilter by sacrifice cap.** A candidate whose *root* eval already sits more
   than `HERO_SACRIFICE_CAP` (+ small margin) below the best move can never qualify —
   its root eval ≈ its perfect-defense outcome. Skip the walk entirely.
3. **Right-size MultiPV per node role.** The only-move test needs best + second (+ noise
   margin): `MULTIPV_OPP = 4`, not 6. Interior hero nodes need only the best move:
   MultiPV 1. Only the root wants width (see C3): `MULTIPV_ROOT = 8`.
4. **Node budgets, not depth** (see C2) — makes cost predictable and tunable.
5. **Precompute is an accumulating background cache, never a blocking step** — priority
   ordering + resumability (Phase R5), and honest UI about coverage.

**Phase R0 exists to measure this before anything else is built.** If wasm throughput
makes even the mitigated numbers absurd, the fallback decision (lower budgets vs. a
node-side precompute script using a native Stockfish, following the explorer-snapshot
precedent) happens *then*, not after the pipeline is built.

#### C2 — "Deterministic and cacheable forever" is false as stated

Stockfish at fixed *depth* is not deterministic: threading, hash size, hash state, and
engine build all change results; multi-threaded search is nondeterministic even with
everything pinned. Amendments:

- Precompute searches use **`go nodes N`** (add a `nodes` option to
  [engine.ts](apps/web/src/lib/engine/engine.ts)'s `AnalyzeOptions`), single-threaded,
  which *is* reproducible for a given engine build.
- Cache keys include **engine build id + search budget + multipv + a
  `RASHID_CACHE_VERSION`**. Treat cached results as versioned artifacts, not eternal
  truths; a version bump invalidates cleanly.

#### C3 — MultiPV 6 at the root can miss the trap move entirely

`HERO_SACRIFICE_CAP = 0.10` wp ≈ 70–100 cp near equality. Genuinely speculative
gambits often rank #7–#12 by raw eval — outside the returned set, so Rashid would never
see its own best material. Amendment: `MULTIPV_ROOT = 8` (tunable, revisit after R0
timing data), combined with the C1.2 prefilter so extra width doesn't multiply walk
cost.

#### C4 — The gap metric has no notion of human findability

This is the biggest *product-quality* risk: a queen recapture is an "only move" by any
gap threshold, so every trade sequence becomes a fake tightrope and Length inflates
with steps nobody could miss. Amendments:

- **Forced moves (exactly one legal reply) extend the line but are not pinch points**:
  no Length increment, no entry in the reward vector. The spec is silent here and the
  gap is literally undefined (no second move).
- **Triviality filter (Phase R6, behind a flag):** a pinch point whose only-move is the
  sole recapture on the square just captured on, or the only sane check evasion, is
  counted like a forced move. Heuristics will misfire; ship behind
  `TRIVIALITY_FILTER` and tune against the fixture suite.
- Until the filter exists, default `MIN_LENGTH_TO_DISPLAY = 2` (the spec's own "reduce
  noise" option) rather than 1.

#### C5 — Walk termination edge cases the spec doesn't cover

- **Repetition:** a "tightrope" can be a perpetual-check loop; the walk must keep a
  seen-set of position keys and terminate on revisit (eval there is the draw eval —
  wp 0.5 — which the Risk number then reports honestly).
- **Terminal nodes:** checkmate/stalemate mid-walk ends the line; a mate *for hero* on
  the perfect-defense path means the move is simply winning (Risk wp = 1.0) and will
  usually be the engine's top move anyway — no special casing, but the code must not
  call `analyze` on a terminal position.
- **Fewer legal moves than MultiPV:** handle short candidate lists without assuming
  `candidates[1]` exists (ties into C4's forced-move rule).

#### C6 — Live fallback as specced is still too slow

"Shallower depth" doesn't fix live mode — the call *count* is the problem (~30 calls of
even 1s each is 30s while the user sits in the editor). Amendments:

- Live mode is a **bounded probe**: root at `MULTIPV_ROOT` with a movetime budget, walk
  only the top few surviving candidates to `MAX_PLY_LIVE = 4`, every call
  movetime-boxed, cancelled the moment the user navigates away.
- Live results are marked **provisional** in the UI and are *not* written into the
  precompute cache tier (different budget ⇒ different cache key — C2 makes this
  automatic). Deep results come only from precompute.
- Both modes share the raw-analysis cache (C7), so a live probe of a position the
  precompute already visited is free.

#### C7 — Cache the raw MultiPV output, not just the final `RashidResult`

The spec's cache (§7) stores only the derived result, which welds the expensive engine
work to the current tuning constants — retune `NARROW_THRESHOLD` and the entire
precompute is garbage. Amendment — **two cache layers**:

- **Layer A (expensive, engine-truth):** raw MultiPV lines per position, side-to-move
  perspective (hero-independent, so both repertoire colors share it), keyed by
  `(fenKey, engineBuild, nodes, multipv)`.
- **Layer B (cheap, derived):** `RashidResult` keyed by
  `(fenKey, heroColor, configHash)`. Deriving B from A is pure, synchronous, and
  instant — changing a threshold re-derives the whole repertoire with **zero** engine
  time.

This single amendment converts "tuning" from a week of recompute into a hot-reload.

#### C8 — Result instability across budgets

A gap of 0.149 at one budget is 0.151 at another: arrows will appear/disappear between
a live probe and the later precompute pass, which reads as flakiness. Precompute
results simply replace provisional ones (C6); within a budget, C2's determinism means
no flicker. Accept the one-time live→precompute transition; don't engineer hysteresis
until it's actually annoying.

#### C9 — UI honesty and rendering constraints

- **Reward floor label** must read as conditional: "if they slip: ≥ +1.5", not a bare
  "≥ +1.5" (see Part 1 "floor" caveat).
- **Chessground brushes are a named, pre-registered set** (see the existing
  [arrows.ts](apps/web/src/lib/engine/arrows.ts) `brushForRank` pattern) — the spec's
  smooth hue gradient and continuous thickness are not free. Amendment: **quantize** to
  the spec's own four risk bands × ~3 thickness tiers as registered brushes (dashed
  strokes on the amber/red bands doubles as the spec's accessibility requirement).
  Check whether the installed chessground supports per-shape `modifiers.lineWidth`
  before building the brush matrix. Length badge + reward label render via the shape
  `customSvg` escape hatch.
- Rashid arrows and the existing top-3 engine arrows would be soup together — the
  editor gets an explicit arrow-mode toggle (engine / rashid / off).

#### C10 — Integration constraints the spec can't know (this repo's invariants)

- **The engine gate is load-bearing.** Rashid is an analysis surface like any other: it
  must never render during an unanswered card, and — subtler — a *precompute* engine
  instance is a second worker whose UCI chatter is not covered by the singleton's gate
  (`gated` is per-instance). The no-leak guarantee is about worker chatter, not just
  panels, so **precompute pauses whenever the app gates the main engine** (drill /
  daily-diet mounts, walker drill phases). One shared "drilling now" signal, two
  consumers.
- A related adapter gotcha: `Engine.analyzeOnce()` **hangs forever while gated**
  (`analyze` no-ops, `done` never fires). The Rashid adapter must check `isGated()` and
  fail fast rather than await.
- **Position identity is `fenKey()`** ([fen.ts](packages/shared/src/fen.ts)) — both
  cache layers key on it; no hand-rolled FEN normalization anywhere in Rashid.
- **Hero = repertoire color**, resolved by the caller; everything in shared stays
  color-parameterized.
- **Offline-first:** all analysis and both cache layers live client-side (IndexedDB via
  [idb/schema.ts](apps/web/src/lib/idb/schema.ts)). The caches are derivable artifacts —
  they do **not** sync to the API. Nothing Rashid does may depend on the network.
- **Deep customizability is a product pillar:** constants ship as global defaults now,
  but the config object is threaded through from day one so per-repertoire overrides
  (à la drill rules) are a column, not a refactor. `configHash` in cache layer B
  already accounts for it.

#### C11 — Minor notes (no action now)

- The fixed logistic (`WP_SCALE = 400`) is fine for MVP; Stockfish's native WDL model
  is a plausible future refinement — a contained change inside `wp()`.
- wp treats every 0.00 as a coin flip; a dead-drawn 0.00 and a chaotic 0.00 read the
  same. Known limitation; the Risk number inherits it.
- Ranking (§4) and Length-as-difficulty-proxy are fine for MVP. A gap-weighted "expected
  slip probability" score is future work, listed in R6's parking lot.

---

## Part 2 — Where Rashid lives

| Piece | Home | Notes |
|---|---|---|
| Domain core: `wp()`, mate sentinels, only-move detector, walk, ranking, `RashidResult` | `packages/shared/src/rashid.ts` (+ `rashid.test.ts`) | Pure logic over an injected `analyze` interface; chess.js (already a shared dep) for move application; zero engine/UI knowledge |
| Engine adapter: `AnalyzeFn` over `Engine.analyzeOnce`, perspective normalization, sentinel mapping, sequential queue, gate fail-fast | `apps/web/src/lib/engine/rashidAdapter.ts` | The only place UCI meets Rashid; adds `nodes` support to `engine.ts` |
| Cache layers A + B | new stores in [idb/schema.ts](apps/web/src/lib/idb/schema.ts) | Keys per C2/C7; never synced |
| Precompute service | `apps/web/src/lib/engine/rashidPrecompute.ts` | Follows the [healthCheck.ts](apps/web/src/lib/engine/healthCheck.ts) batch pattern (sequential, progress callback, cancellable); own low-priority `Engine` instance; pauses on the drill signal (C10) |
| Arrows + badge + hover line | `apps/web/src/lib/engine/rashidArrows.ts` + editor components | Follows `arrows.ts` precedent; quantized brush matrix (C9) |
| Surfaces | Repertoire editor; WalkerSession **build phases only** | Never in drill phases, DrillSession, or DailyDiet (MVP) |

---

## Part 3 — Phases

Each phase ends green (`pnpm typecheck && pnpm lint && pnpm test`) and updates the
knowledge base in the same commit. A new
`knowledge/03-domain/rashid.md` is justified (distinct subsystem, no existing owner) —
created in R1 when there's real behavior to document, indexed in the README map, with
updates to `engine.md`, `components-and-hooks.md`, `testing.md`, and `roadmap.md` as
each phase touches them.

### R0 — Feasibility spike (timeboxed, throwaway code allowed)

Add `nodes` to `AnalyzeOptions`; measure wasm throughput on ~10 representative
middlegame/opening positions across candidate budgets (e.g. 200k / 500k / 1M / 2M
nodes, MultiPV 1/4/8), threaded vs. single-threaded.

**Exit gate:** chosen `NODES_PRECOMPUTE` / `NODES_LIVE` budgets and a measured
estimate of minutes-per-position and hours-per-repertoire — or a decision to move
precompute to a node-side script (explorer-snapshot precedent) if in-browser numbers
are untenable. Numbers recorded in the plan/knowledge, not in a chat scrollback.

**Results (measured 2026-08-24, dev machine, `Stockfish SF_classical 64 POPCNT` wasm,
via the `#/rashid-lab` harness):**

| Search | ms |
|---|---|
| 100k nodes, pv4 | ~145–150 (overhead-dominated — all three positions identical) |
| 300k nodes, pv4 | ~330–370 |
| 1M nodes, pv4 | ~1,080–1,165 |
| 300k nodes, pv1 / pv8 (middlegame) | 304 / 309 |

- Cost is ~linear in nodes and **flat in MultiPV width** — a `go nodes N` budget is
  shared across lines, so widening the root to pv8 is free in *time* but splits the
  same nodes across more lines. Width therefore wants a **higher** node budget, not a
  lower one; the C1.3 "narrow the interior MultiPV to save time" lever is worthless
  and the lever that matters is nodes.
- Projected per-position cost at 300k (1×pv8 + 6×pv4 + 2×pv1): **~3.1s** → ~0.3h per
  300-position repertoire.

**Decision:** in-browser precompute wins outright — no node-side script needed.
Budgets: `NODES_PRECOMPUTE = 1_000_000` (~10s/position, ~0.8h per 300 positions;
time is cheap, eval quality is the scarce resource), `NODES_LIVE = 300_000`.

**Quality caveat discovered:** the bundled wasm engine is **classical eval, not
NNUE**. Classical eval systematically misjudges the compensation in speculative
sacrifices — exactly the moves Rashid exists to find (confirmed on Botvinnik–Tal
1960 game 6: Tal's 21…Nf4!? is prefiltered as simply losing material). Nodes are the
available lever; swapping in an NNUE wasm build is the larger, product-wide upgrade
to reach for if detection quality disappoints in R6.

### R1 — Domain core in shared (no real engine)

`rashid.ts`: sentinel scheme, `wp()`, only-move detector (§3 + C4 forced-move rule +
C5 short-list handling), lazy walk (§4 + C1 early-exit + C2 seen-set + root
prefilter), ranking, config object + `configHash`. All against an injected async
`AnalyzeFn`; tests use a **scripted fake engine** (fixture: position → canned MultiPV),
covering: Length-1 tactic, multi-step tightrope, forced-move non-pinch, repetition
termination, sacrifice-cap rejection, root-prefilter skip, mate sentinels in
floor/max ordering.

**Exit gate:** the walk provably never issues an engine call past a failed only-move
check (assert on fake-engine call log).

### R2 — Engine adapter + cache layer A

`rashidAdapter.ts` (normalization, queue, gate fail-fast per C10), `nodes` search
support, IndexedDB layer A with the full C2 key. Integration check: run the real
engine on 3–5 known trap positions (e.g. Lasker trap, a Stafford line) and eyeball
that detections match chess reality — this is calibration, not CI (unit tests stay on
the fake).

### R3 — Live Rashid in the editor

Bounded live probe (C6) for the currently viewed position; cache layer B; pending /
provisional UI states; cancellation on navigation. Gate test in the style of
[engine.test.ts](apps/web/src/lib/engine/engine.test.ts): while gated, Rashid issues
no `go` and fails fast. Result surfaced as data (a panel row) — arrows come next.

### R4 — Arrow rendering

`rashidArrows.ts`: quantized brush matrix + dashed risk bands, `customSvg` Length
badge and conditional reward label (C9), hover popover with the full line and
per-pinch rewards, arrow-mode toggle. Unit-test the mapping functions
(risk→brush, reward→thickness tier) like `arrows.test.ts`.

### R5 — Precompute pipeline

`rashidPrecompute.ts` over the repertoire's hero-to-move positions plus frequent
opponent deviations (candidate replies already surfaced by the F3 explorer snapshot),
**priority-ordered by game-weighted coverage** so common positions light up first.
Idle-time scheduling on a dedicated low-priority engine instance; pauses on the drill
signal (C10); resumable (layer A makes re-runs cheap); invalidation hooks on
repertoire edits (only affected subtrees); progress UI with honest coverage stats.

### R6 — Tuning pass + triviality filter

Curated trap-suite fixture set (real games/lines where Rashid *should* and *should
not* light up); tune `NARROW_THRESHOLD`, `HERO_SACRIFICE_CAP`, `MIN_LENGTH_TO_DISPLAY`
against it — cheap thanks to layer A/B split (C7). Implement `TRIVIALITY_FILTER`
(C4) behind its flag. Parking lot (explicitly not built, recorded in rashid.md):
per-repertoire config overrides, slip-probability scoring, SF WDL conversion, Rashid
inside drills ("find the trap" cards), reverse-Rashid warnings on hero's own prepared
moves.

---

## Part 4 — Test strategy

- **Unit (CI):** all domain logic on the scripted fake engine — deterministic, fast,
  no wasm. The fake's call log is an assertion surface (laziness, prefilter, gating).
- **Integration (manual/dev page):** real-engine calibration set from R2/R6, run like
  the existing HealthCheck page — real Stockfish output is too slow and too
  version-sensitive for CI.
- **Invariant tests:** gate behavior (no `go` while gated, fail-fast adapter), cache
  key completeness (changing any C2 component misses the cache), floor ordering with
  mate sentinels.
- Every new test's purpose recorded in `knowledge/06-workflows/testing.md`, per repo
  convention.

## Part 5 — Top risks

| Risk | Mitigation |
|---|---|
| wasm throughput makes precompute impractical | R0 gate before any pipeline code; node-side script fallback |
| Trivial-recapture noise makes arrows feel dumb | C4 defaults now, R6 filter + fixture suite |
| Tuning constants wrong on first guess | C7 two-layer cache makes retuning free |
| Second engine worker leaks chatter during drills | C10 shared drill signal pauses precompute |
| Arrow UI clutter | Mode toggle, `MIN_LENGTH_TO_DISPLAY = 2`, cap at top 2 arrows |
