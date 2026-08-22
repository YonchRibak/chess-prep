# Flow Proposal — from machinery-first to intent-first

A UX investigation of the current app flow, and a proposal for restructuring it around
what the user actually sits down to do. This is a product/flow document, not a build
spec — mechanics are referenced only to show that most of what's proposed already
exists and is a re-surfacing job, not new plumbing.

---

## 1. Diagnosis — the machinery is built, the flow hides it

The core ask — *"let me say 'train against the Caro-Kann', have the app play the
common continuations at me, ask what I want to play with engine eval and suggestions,
then rehearse it"* — is **~85% implemented**. It is the walker's build seed
([walker.md](knowledge/03-domain/walker.md)) plus auto-expansion (9c), explorer-ranked
candidates (9b), and line scopes (9a). The problem is that no path through the UI
*assembles* those pieces into that experience. The user has to know the machinery to
compose the intent.

### The concrete frictions

1. **The navigation is organized by mechanism, not intent.** The home screen offers
   *Repertoires / Daily / Browse* and each repertoire card offers *Drill / Build /
   (overflow: Edit, Classic drill, Health check…)*. Nothing anywhere says "prepare
   against an opening" — the one sentence that describes why the app exists.

2. **"Prepare against the Caro-Kann" takes ~6 knowledgeable steps.**
   Browse → find the line on the board → "Add to my repertoire" → create → name it →
   Start building → *then* remember to flip on auto-expand in the walker header, and
   separately know that a line scope exists if the repertoire covers more than this
   opening. Each step is fine; the *chain* is only discoverable by someone who read
   the spec.

3. **Scope is a stored setting, not a session choice.** The walker resolves its scope
   from the repertoire's persisted `drillRules.scope`
   ([WalkerSession.tsx:324](apps/web/src/pages/WalkerSession.tsx#L324)). So "drill
   only the Winawer tonight" means: open classic drill-setup (a different page, for a
   different drill implementation), change a dropdown, run the session — and the
   setting *stays changed*. Worse, because `buildDailyDietQueue` honors the same
   stored scope ([srs-drilling.md](knowledge/03-domain/srs-drilling.md#line-scopes-phase-9a)),
   tonight's narrowing **silently shrinks tomorrow's daily diet** until the user
   remembers to widen it back. This is exactly the Lotus pain — "I can't rehearse
   specifically against the Winawer" — except the capability exists and is buried
   behind a footgun.

4. **Auto-expand — the "app plays the common continuations at me" half of the ask —
   is off by default and lives in a header toggle** inside an already-running build
   session. The one feature that turns hand-authoring into a conversation is opt-in
   at the wrong moment: you discover it *after* you've started doing the thing it
   would have saved you from.

5. **Build asks, but never rehearses.** The user said it directly: *"ask me what I
   want to play, **and then rehearse**."* Today a move added during build becomes an
   FSRS card and is next seen whenever the due queue surfaces it. There is no
   "lock it in" moment — no immediate replay of the line just decided. Deciding and
   memorizing are separated by hours or days, which is why building feels like data
   entry instead of training.

6. **BFS round-robin is the wrong shape for focused prep.** The build seed's
   breadth-first walk is a deliberate, good default for *balanced* repertoire growth
   ("never deep against one defense, zero against another"). But in a "prepare
   against X" session it makes the board jump between unrelated branches every
   question, which reads as disorientation, not balance. Focused prep wants
   line-at-a-time: follow one continuation to target depth, *rehearse it*, then take
   the next branch.

7. **No sense of progress or "done".** `computeCoverage` exists and the header shows
   "Branch 3 of 5 at ply 5", but nothing answers the question that actually ends a
   prep session: *"how much of what opponents actually play am I ready for?"*
   Without a target, building has no finish line, so every session ends by fatigue.

8. **The frequency data the whole flow leans on is fragile in practice.** Candidates
   degrade to the book's *alphabetical* order whenever the explorer cache is cold —
   and on the primary dev machine the lichess explorer host answers 401 for
   everything ([explorer.md](knowledge/03-domain/explorer.md#local-gotcha)), so cold
   is the norm. The flagship flow can't depend on a network host that the app's own
   docs describe as unreachable.

---

## 2. What other apps get right (and wrong)

| App | Worth taking | Worth rejecting |
|---|---|---|
| **Lotus Chess** | The core rehearsal loop feels like *playing*, not flashcards — opponent moves just come at you. | No sub-line targeting (the Winawer problem); fixed rehearsal diet; no say in what gets asked when. |
| **Chessbook** (ex-chessmadra) | The single best build flow in the genre: pick what you're preparing against, set a **coverage target** ("cover every response seen in >1 of 50 games"), and it walks you frontier-question by frontier-question — each with eval, popularity, and win-rate — until the meter reads 100%. Building has a finish line. | Repertoire is theirs, not yours (weak export); no real SRS depth. |
| **Chessable** | The learn-then-review cadence: a new move is immediately replayed 1–2 times ("lock it in") before entering the long-term queue. Decision and first memorization are one moment. | Course-shaped: you memorize someone else's lines; drilling *your* choices is an afterthought. |
| **Listudy** | Dead-simple "the board plays the opponent, you play your prep" spaced repetition over your own studies. | Line entry is fully manual (the exact pain this app already solved). |

The synthesis this app is uniquely positioned for: **Chessbook's guided build with a
coverage target, Chessable's lock-in cadence, Lotus's play-like rehearsal — over a
repertoire that is genuinely yours (PGN round-trip), fully offline, with per-line
targeting none of them have.**

---

## 3. Proposed flow

### 3.1 Home: three intents, not three mechanisms

Replace the *Repertoires / Daily / Browse* frame with three verbs:

```
┌────────────────────────────────────────────────┐
│  Today            32 due · ~12 min   [Train]   │   ← the daily diet, unchanged
├────────────────────────────────────────────────┤
│  Prepare against…                    [Start]   │   ← NEW: the guided flow (§3.2)
├────────────────────────────────────────────────┤
│  My repertoires                                │
│   ♔ White vs e4-e5   92% ready   [Train][Grow] │
│   ♚ Caro-Kann        61% ready   [Train][Grow] │
│      └ overflow: Edit · Analyze · Export · …   │
└────────────────────────────────────────────────┘
```

- **Train** = drill this repertoire (walker drill seed, smart default queue — §3.5).
- **Grow** = continue building it (walker build seed).
- "Browse openings" stops being a top-level destination; it becomes the *search step*
  inside "Prepare against…" and stays reachable from the overflow for free
  exploration. Analysis is a mode you enter from anywhere via the board, not a place.

### 3.2 "Prepare against…" — the guided session (the headline change)

One flow that assembles the already-built pieces end to end. Walking through the
user's own example — *training against the Caro-Kann*:

1. **Name the target.** Type-ahead search over the ECO book: "Caro-Kann" — or
   deeper: "Winawer". Picking a named line implies the color automatically (you're
   preparing *against* the Caro-Kann ⇒ you're White; the app states it, one tap to
   flip). Alternatively "start from a position": play moves on a board or paste a
   FEN/PGN — this is where manual entry lives, first-class, not the default.

2. **Pick where it goes.** If an existing repertoire of that color already contains
   the stem position (fenKey lookup), default to *extend it*; otherwise offer *new
   repertoire*. The user never has to understand that repertoires are trees and
   openings are subtrees — the fenKey match decides.

3. **Set the finish line.** A coverage target, Chessbook-style, expressed in the
   explorer's own terms: **"prepare every reply played in ≥ 1 in 20 games"**
   (default), with "broader (1 in 50)" and "main lines only (1 in 5)" presets, plus
   a depth cap (default ~10–12 plies). This maps directly onto the existing
   selection-policy thresholds in
   [packages/shared/src/explorer.ts](packages/shared/src/explorer.ts) — the presets
   are just parameterizations of `selectOpponentReplies`.

4. **The session loop** — the part that must *feel* like Lotus-plus:

   - Opponent replies within the target **auto-expand silently** (existing 9c
     machinery; in this flow it is ON by definition, not a header toggle — the user
     opted in by choosing a guided prepare session).
   - The walker traverses **line-at-a-time within the scope** (depth-first to the
     target depth/coverage, then next branch) instead of tree-wide BFS — a second
     seed strategy next to `findNextBuildNode`, selected by session type. BFS
     remains the right default for un-scoped "Grow".
   - At each user-turn frontier: the existing candidate prompt — engine eval,
     top engine moves re-ranked by popularity, opening names, share-of-games. One
     click, or play any move on the board (manual entry again, inline, zero
     ceremony).
   - **Lock-in micro-rehearsal (new, small, the highest-feel-per-effort item):**
     after each line reaches target depth — or every ~4–5 new moves — the walker
     flips to drill mode *for exactly those moves*: replay the line from the stem,
     user plays their prep, opponent replies auto-play. One clean pass, graded
     normally (it seeds honest FSRS state), then back to building. This closes the
     "and then rehearse" gap and is a walker seed change, not a new page.
   - **Coverage meter, always visible:** "vs Caro-Kann: 67% of games covered ·
     3 lines to target". Session ends at 100%-to-target with a summary — lines
     added, cards created, weakest first-pass line — and a "drill these now" button.

5. **Next session, same entry point** resumes where coverage is thinnest.

### 3.3 Scope becomes navigation, not settings (the Winawer fix)

Kill the scope dropdown as the *primary* interface. Instead, **Train** on a
repertoire opens a **line navigator** — the tree of named variations actually present
in the repertoire (derived from the existing deepest-ECO-name machinery, aggregated
per subtree), each with live badges:

```
Train: Caro-Kann repertoire
  ▸ All                    32 due · 92% coverage      [Start]
  ▸ Advance Variation      11 due · 100%              [Start]
  ▸ Classical               6 due · 88%               [Start]
  ▸ Exchange                0 due · 61%  ⚠ 3 recent misses   [Start]
  ▸ tag: vs-danny           4 due                     [Start]
```

- Tapping a line starts a session scoped to it — **session-scoped, in memory,
  never written to `drillRules`**. The stored scope remains as an editor-level
  default for people who want a permanently narrowed repertoire, but the daily-diet
  footgun (§1.3) dies: a one-night focus can no longer silently reshape tomorrow's
  diet.
- The same navigator, reached from **Grow**, scopes building — "keep building, only
  in the Exchange" becomes two taps.
- This is the direct answer to Lotus: *rehearsing specifically against the Winawer
  is one tap on a line that shows you its own due count.*

### 3.4 Manual entry stays first-class — it just stops being the toll gate

Nothing above removes a manual path; it removes manual as the *only* path:

- In any build prompt, playing a move on the board is and remains prep entry.
- PGN import is unchanged (no-lock-in is non-negotiable).
- The editor remains the surgical tool for comments, tags, drops, priorities.
- "Start from a position" in the Prepare wizard covers "I read a book chapter and
  want to enter its line" — enter it manually, *then* let the guided loop fill in
  the opponent's alternatives around it. Manual entry and guided growth compose
  instead of competing.

### 3.5 One Train button, one smart queue

Five drill modes on a setup page is a mechanism menu. Default **Train** should build
one queue: **due first (FSRS order) → recent mistakes (the 9d ranking) → new-card
lock-ins**, capped by the existing `newCardsPerDay`. The current modes survive under
an "advanced" disclosure on the session screen, and classic `DrillSession` continues
its planned death by consolidation
([known debt](knowledge/06-workflows/roadmap.md#known-debt-deliberately-deferred)).
This also shrinks the surface over which the three-implementations debt has to stay
in sync — flow pressure and tech-debt pressure point the same direction here.

### 3.6 Make the frequency floor solid: bundle a snapshot

The entire guided flow stands on frequency data, and (§1.8) the live explorer is
unreachable exactly where the app is developed. Ship a **bundled frequency
snapshot** — a precomputed table from the lichess open database (top ~10–12 plies,
per-move counts and W/D/L), imported like the ECO book, acting as the
lowest-priority explorer source: live cache → stale cache → **snapshot** → book
(display-only, never written from — unchanged).

This respects both standing invariants: explorer-shaped features must work cold, and
silent writes require *real* frequency data — a snapshot **is** real frequency data,
merely old, and opening statistics move over months
([explorer.md](knowledge/03-domain/explorer.md#the-cache)). With it, "Prepare
against the Caro-Kann" works on a plane, behind a corporate proxy, and on the dev
machine.

---

## 4. What this actually requires

Ordered by feel-per-effort; nothing here touches the four non-negotiables, and the
engine-gating boundary is unchanged (build phases are already ungated).

| # | Change | New machinery? |
|---|---|---|
| 1 | Session-scoped scope override (walker + queue builders take scope as a session param, stored rules become default only) | None — plumbing a parameter that already exists as an option |
| 2 | Line navigator with per-line due/coverage badges | Aggregation over existing indices + `repStats`-style rollup; UI |
| 3 | "Prepare against…" wizard (search → target → session) | UI composition; presets over existing selection policy. Note: scoped building can't start a line that doesn't exist ([walker.md](knowledge/03-domain/walker.md#scoped-building)) — the wizard must `appendLine` the stem first, which also resolves that documented gotcha |
| 4 | Lock-in micro-rehearsal in the build loop | New walker seed behavior; reuses the drill panel and grading path wholesale |
| 5 | Line-at-a-time traversal for guided sessions | A sibling of `findNextBuildNode`; pure, testable |
| 6 | Coverage-vs-target meter (game-weighted, from explorer/snapshot data) | New pure function beside `computeCoverage`; falls back to structural coverage when cold |
| 7 | Smart default Train queue | Composition of existing modes in the queue builder |
| 8 | Bundled frequency snapshot | New importer + a source tier in the explorer service |
| 9 | Home re-org around Train / Prepare / Grow | UI only |

Suggested phasing: **(1)+(2)** first — they fix the Winawer problem and the
daily-diet footgun in days, using zero new domain logic. Then **(3)+(4)+(5)** as the
guided-prepare phase (this is the Lotus-replacement moment). Then **(6)+(8)**
to give it a floor and a finish line. **(7)+(9)** ride along whenever adjacent code
is open.

---

## 5. What deliberately does *not* change

- **Offline drilling, PGN round-trip, engine gating, per-repertoire customizability**
  — untouched; every proposal above is a client-side flow over existing data.
- **The walker as the single core** — every new session type is a seed/strategy over
  the same traversal, which is the architecture bet paying off, not a workaround.
- **BFS balanced growth** — still the right default for un-scoped Grow; guided
  line-at-a-time is an addition, not a replacement.
- **The one-prep invariant, drop semantics, refutation shadows** — all orthogonal.
