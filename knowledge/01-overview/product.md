# What this app is

A web-first PWA for chess opening preparation, built by and for a single competitive
player who is also a fullstack dev. It replaces Lotus Chess with something more
customizable and grounded in real opening theory.

Three things it does:
1. **Build a repertoire** on top of a bundled named-opening (ECO) database.
2. **Drill that repertoire** flashcard-style with FSRS spaced repetition, offline.
3. **Analyze** with Stockfish — everywhere *except* inside an unanswered flashcard.

## The core loop — one walker, two seeds

The atomic unit is a **prepared move**: a parent position (normalized FEN) plus the
single move the user intends to play there. The whole app is one **walker** session
over a position-keyed tree. At each node, behavior depends on (a) whose turn it is
and (b) whether prep exists:

| Node state | Panel |
|---|---|
| User turn, no prep | *"What's your move?"* + book suggestions → saves a `Move` + an SRS card |
| User turn, prep exists | Bare position; user plays it; auto-graded (correct = Good, wrong = Again) |
| Opponent turn, no branches | *"Which responses to prepare?"* multi-select → each pick opens a branch |
| Opponent turn, ≥1 branch | Auto-plays one saved branch |

**Build** and **Drill** are not separate UIs — they're two *seeds* into the same walker:
- Drill seeds with FSRS-due cards; hitting an unprepped node slides into build for
  that one node, then resumes ("drill-pauses-for-build").
- Build seeds at the shallowest uncovered position and walks breadth-first.

See [the walker](../03-domain/walker.md) for mechanics.

## Non-negotiable qualities

These are product-level constraints. Don't regress them.

- **Offline drilling.** PWA + IndexedDB. The backend is a sync/backup target, never
  the source of truth for a live drill session. See [local-first](../02-architecture/local-first-sync.md).
- **No lock-in.** PGN import *and* export for every repertoire, round-trip faithful.
- **Deep customizability.** Per-repertoire drill rules (depth limits, branching,
  blindfold, eval-after-answer) plus a daily mixed-side session.
- **The engine never leaks a card's answer.** Enforced at the engine *module*, not by
  hiding a panel. See [engine gating](../03-domain/engine.md).

## Priority order of use cases

1. Building and drilling a personal repertoire on top of the opening database.
2. A daily mixed-side drill that just works.
3. Engine-assisted free analysis.
4. Opponent scouting via move-frequency heatmap — **parked**, see [roadmap](../06-workflows/roadmap.md).

## Auth

There is no auth yet. Single-user mode: every request is attributed to
`DEFAULT_USER_ID` in [auth.ts](../../packages/shared/src/auth.ts), and the migration
seeds a matching `users` row. Any change touching user scoping should keep the
`userId` parameter threaded through services so real auth is a small swap later.
