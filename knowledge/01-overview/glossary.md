# Glossary

Terms used consistently across code, spec, and these docs.

| Term | Meaning |
|---|---|
| **fenKey** | A FEN truncated to its first 4 fields (pieces, side, castling, en passant). The universal position identity. See [fen-keying](../03-domain/fen-keying.md). |
| **Position** | A node in a repertoire tree, keyed by `fenKey` and scoped to one repertoire. Transpositions collapse to one row. |
| **Move** | A directed edge `parentPosition → childPosition` carrying SAN/UCI plus metadata. This is the unit of prep. |
| **Prep move** | A `Move` on the *user's* turn — the move they intend to play there. Gets an SRS card. |
| **Response** | A `Move` on the *opponent's* turn — a line the user chose to prepare against. Gets no card; opens a branch. |
| **Walker** | The traversal that finds the next node needing attention. [walker.ts](../../apps/web/src/lib/walker/walker.ts) |
| **Seed** | How a walker session is queued: `build` (BFS from shallowest uncovered) or `drill` (FSRS-due cards). |
| **Attention node** | A position with no live outgoing move of the relevant kind — needs a prompt. |
| **Coverage** | Derived, never stored. A position is uncovered iff it has no live outgoing moves. |
| **Card** | An FSRS SRS card, one per prep `Move`. DB constraint `uniq_user_move` on `(user_id, move_id)`. |
| **Skip** | Ephemeral, session-local "not now". The node resurfaces next session. |
| **Drop** | Persistent "won't cover" — `moves.is_dropped`. The walker skips the move *and its subtree*, forever, until undropped. |
| **Book** / **opening book** | The read-only ECO reference table `opening_book_entries`. Never mutated by user actions. |
| **Book continuation** | A known named move from the current position, offered as a one-click suggestion. Browsing one does *not* create a card. |
| **Gated** | Engine state where `analyze()` is a no-op and in-flight analysis is stopped. Set during drilling. |
| **Daily diet** | A cross-repertoire due-card session for a chosen side (White/Black/Mixed), interleaved round-robin by repertoire. |
| **Classic drill** | The pre-walker Phase 3 drill UI ([DrillSession.tsx](../../apps/web/src/pages/DrillSession.tsx)). Still reachable; slated for merge into the walker. |
| **Ply** | A single half-move. Depths throughout the code are in plies from the repertoire root. |

## Phase 9a/9b terms — built

| Term | Meaning |
|---|---|
| **Explorer** | Lichess opening-explorer statistics — how often a move is played and how it scores. Cached in `explorer_entries`; answers *which opponent replies matter*, never *which move the user should play*. [explorer](../03-domain/explorer.md) |
| **Share** | A move's fraction of the games played at a position, 0..1. The ranking key for opponent replies. |
| **Scope** | A predicate selecting a subset of a repertoire for a session — *derived* from the ECO deepest name, or *explicit* via `line_tags`. A line is a scope, never a copied tree. `DrillRules.scope`; see [srs-drilling](../03-domain/srs-drilling.md#line-scopes-phase-9a). |
| **Line tag** | A label on a `Move`, inherited from the parent edge at insert time, for what the book can't express (`vs-danny`, `blitz-only`). Column `moves.line_tags`. |

## Phase 9c–9d terms — designed, not built

These appear in [repertoire-growth](../03-domain/repertoire-growth.md) only. No code uses
them yet; don't assume a symbol exists because a term does.

| Term | Meaning |
|---|---|
| **Frontier** | Positions one ply past current coverage — what the prefetcher warms so candidates are instant. |
| **Interference** | Playing the SAN that is your correct prep at a *different* position. The common transposition confusion, worth naming explicitly to the user. |
| **Shadow line** | A stored refutation of a mistake. Never prep, never carded, never walked by the build seed. |
