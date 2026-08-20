# Rashid — Trap-Finding Analysis Layer

**What this is:** Rashid is *not* a chess engine. It is an analysis layer that rides on top of an existing engine (assume Stockfish or any UCI engine with **MultiPV** support). It reframes engine output around a different objective: instead of "best move assuming perfect play," it finds moves that force the opponent onto a **narrow tightrope** — sequences where the opponent must find consecutive "only moves" or suffer a large swing.

Rashid "lights up" on a position when such a tightrope exists, and surfaces three numbers — **Risk**, **Reward**, **Length** — on a board arrow.

This document specifies the **logic and math only**. How you call the engine, what language you use, where this plugs into the existing project, threading, caching infrastructure, and UI framework are all left to the implementer. The engine interface is abstracted behind a single function described below.

---

## 1. The engine abstraction

Rashid depends on exactly one capability from the underlying engine: **MultiPV evaluation of a position**. Wrap whatever engine you use behind this conceptual interface:

```
analyze(position, depth, multipv) -> List[ {move, eval} ]
```

- `position`: a board state (FEN or equivalent).
- `depth`: fixed search depth (or fixed node count) — must be **constant** across all calls so evals are comparable and cacheable. Pick a single depth for the whole system (e.g. something in the 18–24 range for offline precompute; lower for live fallback).
- `multipv`: number of candidate moves to return (use 5–8).
- Returns the top-`multipv` legal moves, each with an evaluation, **sorted best-first from the side-to-move's perspective**.

### Eval conventions (critical — get this right)

- All evals must be normalized to **the perspective of the player Rashid is advising** (call them the *hero*). Engines typically report from side-to-move's perspective; convert so that **higher = better for hero** at every node, regardless of whose turn it is.
- Mate scores must be representable and orderable. Use a large signed sentinel scheme, e.g. mate-in-N for hero = `+(MATE_BASE - N)`, mate-in-N against hero = `-(MATE_BASE - N)`, with `MATE_BASE` larger than any real centipawn eval (e.g. 100000). This keeps "mate in 3" strictly greater than "mate in 5" and both greater than any material eval.
- Work internally in **centipawns** (integer) but convert to **win-probability** for thresholding (see §3).

---

## 2. Win-probability conversion

Raw centipawns are not linear in practical importance: a 50cp gap near equality is decisive; a 50cp gap at +600 is noise. Convert every eval to an expected-score / win-probability in [0,1] using a logistic function:

```
winprob(cp) = 1 / (1 + 10^(-cp / 400))
```

(The constant 400 is the standard Elo-logistic scaling; it can be tuned but keep it fixed.)

For mate sentinels, clamp: hero-mate → `winprob = 1.0`, hero-gets-mated → `winprob = 0.0`.

**All "how big is the gap / swing" decisions are made in win-probability space, not centipawns.** This is what makes thresholds behave consistently across quiet and sharp positions.

Define a helper:
```
wp(eval) = winprob in [0,1], from hero's perspective
```

---

## 3. Detecting an "only move" (single opponent node)

This is the atomic operation. Given an **opponent-to-move** position:

1. Call `analyze(position, depth, multipv)`.
2. Let `best` = candidate[0], `second` = candidate[1] (both already hero-perspective).
   - Note: at an opponent node, the opponent is *minimizing* hero's eval. The engine returns the opponent's best (= most hero-unfavorable) move first. After perspective-normalization to hero, candidate[0] is the move with the **lowest** hero-eval, candidate[1] the next lowest, etc. Be careful with sort direction here — at opponent nodes "best for opponent" = "worst for hero."
3. Compute the **narrowness gap** in win-probability:
   ```
   gap = wp(second_move_outcome) - wp(best_move_outcome)
   ```
   Because at an opponent node `second` is *more favorable to hero* than `best`, this gap is ≥ 0. It measures how much hero's position improves if the opponent fails to find the single best move and plays the next-best instead.
4. The opponent move is an **only move** iff `gap >= NARROW_THRESHOLD`.

`NARROW_THRESHOLD` is a tunable win-probability delta. Suggested starting value: **0.15** (i.e., missing the only-move swings expected score by ≥15 percentage points). Expose it as a config constant.

**Definition compliance:** This matches the user's definition — an only-move is one where *every alternative is strongly worse*, not necessarily losing. The threshold is on the gap to the **second-best** move, so if even the second-best alternative is nearly as good, it is *not* an only-move (the opponent has a choice and can't really go wrong).

### Per-pinch-point reward

When an only-move is detected, also record the **punishment eval** — what hero gets if the opponent misses:

```
miss_eval = eval of the second-best opponent move (hero perspective, in cp)
```

This is the reward hero collects at *this specific* pinch point. Store it per pinch point; we aggregate later (§5).

---

## 4. Building a Rashid line (the tree walk)

Rashid searches for a **hero move** that initiates a chain of opponent only-moves. Nodes alternate hero / opponent. Treat them asymmetrically.

```
Inputs:
  root_position        (hero to move)
  depth, multipv       (engine params, fixed)
  NARROW_THRESHOLD     (only-move gap, win-prob)
  MAX_PLY              (max forcing depth to explore, e.g. 8 half-moves)
  HERO_SACRIFICE_CAP   (how dubious a hero move may be; see below)

For each candidate hero move m at the root (from analyze on root):
    simulate m -> reach opponent node
    walk the forced line:
        loop at opponent node:
            run only-move detection (§3)
            if NOT an only move:
                tightrope ends here
            else:
                record pinch point: { ply, miss_eval }
                advance opponent's BEST move (the tightrope continues
                  on the line where they navigate correctly)
                reach hero node:
                    advance hero's best response (engine best is fine here),
                    reach next opponent node
            stop if ply >= MAX_PLY or game terminal
    collect the line: {hero_move m, list_of_pinch_points, final_position}
```

### Hero-node move selection — the one place Rashid diverges from the engine

At the **root hero node**, Rashid may deliberately propose a move that is *objectively not the engine's top choice* — a dubious or speculative move — because it forces the opponent onto a longer/narrower tightrope. This is the whole point.

Constrain this so Rashid doesn't suggest outright blunders:

- Let `best_root_wp` = `wp` of the engine's #1 move at the root (perfect-play baseline).
- For a candidate hero move `m`, let `tightrope_wp` = hero's win-prob at the **end** of the forced line assuming the opponent navigates every only-move correctly (this is Risk, see §5).
- Allow `m` as a Rashid suggestion only if:
  ```
  best_root_wp - tightrope_wp <= HERO_SACRIFICE_CAP
  ```
  i.e., the price you pay (versus just playing the best move) for offering the trap is bounded. Suggested `HERO_SACRIFICE_CAP = 0.10` (you'll give up at most ~10 percentage points of expected score against perfect defense). Tune to taste; a higher cap = more aggressive/speculative traps.

At **interior hero nodes** inside the tightrope (after the trap has been entered), just play the engine's best move — there's no reason to weaken hero's own play mid-sequence; the asymmetry only matters at the decision to *enter* the trap.

### Choosing which line to surface

A root may yield several candidate tightropes. Rank them and surface the best one (or top few). Ranking key, in order:
1. **Length** (more only-moves = harder for opponent), then
2. **Reward floor** (higher guaranteed punishment), then
3. **Risk** (less downside against perfect play).

A position "lights up" (Rashid shows an arrow) iff at least one candidate line has `Length >= 1` and passes the `HERO_SACRIFICE_CAP`. Optionally require `Length >= 2` to reduce noise — make this a config flag `MIN_LENGTH_TO_DISPLAY`.

---

## 5. The three output numbers

For a chosen Rashid line:

### Length
```
Length = number of pinch points (consecutive opponent only-moves) in the line
```
Plain integer. This is also a rough proxy for the probability the opponent navigates the whole thing: harder as Length grows.

### Risk
The downside if the opponent finds **every** only-move. Evaluate the final position at the end of the tightrope (opponent played perfectly throughout), from hero's perspective:
```
Risk_cp = hero-perspective eval at end of forced line (perfect opponent defense)
Risk_wp = wp(Risk_cp)
```
Report Risk as the hero eval (e.g. `-0.4`, `0.0`, `+0.3`). Interpretation:
- `Risk ≈ 0` → a near-free trap; nothing lost if it's declined correctly.
- `Risk < 0` → a genuine gambit; you're worse if they defend perfectly (still allowed, within the sacrifice cap).

### Reward
Each pinch point `i` has a `miss_eval_i` (§3) — what hero gets if the opponent misses *that* move. You have a vector of rewards, one per pinch point.

**Surface the LOWEST reward as the headline number** (the floor), with the maximum as a secondary "jackpot":
```
Reward_floor = min over pinch points of miss_eval_i
Reward_max   = max over pinch points of miss_eval_i
```

Rationale for floor-as-headline: the smallest-punishment slip is (a) the most *tempting* mistake and therefore the most likely to actually occur, and (b) a guaranteed lower bound — "even the least-punished slip still gives you at least `Reward_floor`." The jackpot is shown small/secondary so the user knows the upside without being misled into over-valuing the trap.

Mate rewards: if a `miss_eval` is a mate sentinel, display it as `M{N}` (e.g. `M3`) rather than a centipawn number, but still order it correctly via the sentinel scheme when computing floor/max.

---

## 6. Output object (what the layer returns per position)

```
RashidResult {
    lights_up: bool,
    arrow: {
        from_square, to_square,         // the hero move to display
        risk_cp:      int,              // signed, hero perspective
        risk_display: string,           // e.g. "-0.4", "0.0", "+0.3"
        reward_floor: int | mate,       // headline reward
        reward_floor_display: string,   // e.g. "+1.5" or "M3"
        reward_max:   int | mate,       // secondary / jackpot
        reward_max_display: string,
        length:       int               // number of only-moves
    },
    line: [ moves... ],                 // the full forced sequence, for hover/preview
    pinch_points: [ {ply, miss_eval}... ]
}
```
Return `lights_up: false` (no arrow) when no qualifying line exists.

---

## 7. Hybrid precompute / live execution

Rashid analysis for a fixed position at fixed depth is **deterministic and cacheable forever**. Use a precompute-first hybrid:

- **Precompute (offline, primary):** For every position in the prep/repertoire tree (hero lines plus opponent deviations a few ply deep), run the full Rashid analysis at the high fixed depth and store the `RashidResult` keyed by position (e.g. by FEN, normalized — strip or canonicalize the move-clock fields so transpositions hit the same cache entry). At runtime, reaching a known position is an instant lookup.
- **Live fallback (secondary):** When the user reaches a position outside the precomputed set, run a **time-boxed, shallower** Rashid pass on demand. Show a pending state until it resolves, or simply withhold the arrow until ready. Cache the live result back into the store so it's instant next time.

The implementer owns: the cache/store technology, the position-key normalization details, how the prep tree enumerates positions, and how live jobs are scheduled. The **analysis logic is identical** in both modes — only `depth` and time budget differ.

---

## 8. Tunable constants (collect in one config block)

| Constant | Meaning | Suggested start |
|---|---|---|
| `DEPTH_OFFLINE` | fixed engine depth for precompute | 18–24 |
| `DEPTH_LIVE` | fixed engine depth for live fallback | 12–16 |
| `MULTIPV` | candidate moves per position | 6 |
| `NARROW_THRESHOLD` | win-prob gap defining an only-move | 0.15 |
| `HERO_SACRIFICE_CAP` | max win-prob hero may concede vs perfect defense to offer a trap | 0.10 |
| `MAX_PLY` | max forcing depth explored | 8 |
| `MIN_LENGTH_TO_DISPLAY` | min only-moves to light up | 1 (try 2 to reduce noise) |
| `WP_SCALE` | logistic scaling constant | 400 |
| `MATE_BASE` | mate sentinel base | 100000 |

---

## 9. Arrow visual design

The arrow encodes **all three numbers at once**. Mapping:

**Color = Risk** (the safety of offering the trap). Risk is the emotionally primary axis — "can this backfire on me?" — so it owns the most pre-attentive channel, hue:
- Risk ≥ +0.3 → **green** (free/winning even if declined correctly).
- Risk roughly 0 (−0.2 … +0.3) → **blue/teal** (safe trap, nothing real lost).
- Risk −0.5 … −0.2 → **amber** (a real gambit, you concede something).
- Risk < −0.5 → **red** (speculative/dubious; only shown because within sacrifice cap).

Use a smooth gradient across these stops rather than hard bands, so the hue reads as a continuous "how safe is this" signal.

**Thickness = Reward floor** (the guaranteed payoff magnitude). Thicker arrow = bigger guaranteed punishment when they slip. Map `Reward_floor` magnitude → stroke width on a clamped scale (e.g. +0.5 → thin, +3.0 → thick, mate → max thickness). Reward is "how much do I win" — magnitude maps naturally to visual weight.

**Number badge on the arrow = Length** (a small circular badge at the arrow's midpoint showing the integer — the count of only-moves). Length is a discrete count, so it reads best as a literal digit, not a visual gradient. Consider rendering it as `N` pips or a number inside a small disc.

**Reward value as a label** at the arrowhead: show `Reward_floor_display` prominently and `Reward_max_display` smaller/secondary, e.g.:
```
≥ +1.5  (↑ M3)
```
The `≥` communicates that it's a floor. The parenthetical jackpot is de-emphasized (smaller, lower opacity).

**Putting it together** — a single arrow reads as:
- *Hue* → can this hurt me? (Risk)
- *Thickness* → how hard do they get punished? (Reward floor)
- *Badge digit* → how many tightrope steps? (Length)
- *Arrowhead label* → exact floor reward, with jackpot in parentheses.

**Hover / expand:** on hover or tap, reveal the full forced line move-by-move, and annotate each pinch point with its individual miss-reward (so the user sees *which* slip yields what). This turns the single arrow into a teaching tool.

**Multiple traps in one position:** if several lines qualify, draw the top-ranked arrow at full opacity and any secondary ones at reduced opacity, so the board doesn't clutter. Cap at, say, the top 2–3.

### Accessibility note
Because hue carries Risk, do not rely on hue *alone* — the amber/red end should also get a subtle dashed or warning-textured stroke so risk is legible to color-blind users and the green↔red axis isn't the only cue.

---

## 10. Build order (suggested MVP staging)

1. **Single-node only-move detector** (§3) — given one opponent-to-move position, return `{is_only_move, gap, miss_eval}`. Independently useful and easy to verify by hand.
2. **Tree walk** (§4) — chain detection into full lines; produce `RashidResult` with Risk/Reward/Length.
3. **Precompute pipeline + cache** (§7) over the prep tree.
4. **Arrow rendering** (§9).
5. **Live fallback** (§7) for off-book positions.

Each stage is independently testable. Verify §1–§3 against positions with known forced sequences (any tactic with a unique solution is a Length-1 case) before trusting the tree walk.
