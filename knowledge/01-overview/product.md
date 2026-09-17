# What this app is

A web-first PWA for **rehearsing the opening preparation you keep in lichess studies**,
built by and for a single competitive player who is also a fullstack dev.

The split is deliberate: lichess studies are a better place to *prepare* (analysis
board, engine, sharing, annotations) than anything this app would build; what lichess
lacks is *rehearsal* — spaced repetition, a daily diet, drilling one chapter, being
stopped by your own note when you go wrong. So:

1. **Upload a study** — one chapter or the whole export — and it becomes one
   repertoire with a chapter per scope ([study](../03-domain/study.md)).
2. **Rehearse it** — click a chapter and the flashcards start (`#/rehearse`, Study S5):
   shuffled, animated, graded silently with FSRS, fully offline; a miss on a commented
   move pauses to show the note. "Expand variations" fills the gaps a study leaves —
   opponent replies it doesn't cover — and what you record there survives re-upload.
3. **Re-upload** whenever the study changes; the sync is a diff, so scheduling history
   on unchanged moves is kept.
4. **Browse and analyze** it: engine eval and Rashid trap-finding on demand, per
   position or across the whole study — everywhere *except* inside an unanswered card.

The older way of working — building a repertoire by hand on the bundled ECO opening
database, the guided "Prepare against…" wizard, the tree editor — is still here and
still reachable from the nav. It is the supporting machinery, not the product: a study
import fills the same position-keyed tree those tools operate on.

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

## The flow — intents, not mechanisms (Flow F1–F4)

The UI is organized around what the user sits down to *do*, not around the machinery
(see [FLOW_PROPOSAL.md](../../FLOW_PROPOSAL.md)). The nav is *Studies · Repertoires ·
Today · Prepare*, and **Studies is the landing** (Study S3): preparation happens in a
lichess study, this app rehearses it — upload the export, rehearse it (whole study or
one chapter), re-upload when it changes, and read your own notes when you miss. See
[study](../03-domain/study.md). The hand-built repertoire home below moved to
`#/repertoires` and offers three verbs:

- **Today** — the daily mixed diet, unchanged.
- **Prepare against…** — the guided flow: name an opening, the app plays the common
  replies at you (auto-expansion + explorer/snapshot frequency), you pick with
  eval+popularity candidates, and every finished line is immediately rehearsed
  ([walker — guided prepare](../03-domain/walker.md#guided-prepare-flow-f2)).
- **Train / Grow** per repertoire — the walker's drill/build seeds, entered through
  the [line navigator](../05-web/views-and-routing.md) so a per-line session is two
  taps. In user-facing copy the seeds are called **Train** and **Grow**; code and
  docs keep the `drill`/`build` identifiers.

"Browse openings" is not a top-level destination: it is the Prepare wizard's search
step and the "New repertoire" path, and remains a routable view (`#/browse`).

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

1. Rehearsing lichess studies: upload, drill (whole study or one chapter), re-upload.
2. A daily mixed-side drill that just works.
3. Browsing a study with engine eval and Rashid, on demand.
4. Building and drilling a hand-built repertoire on the opening database (legacy path).
5. Opponent scouting via move-frequency heatmap — **parked**, see [roadmap](../06-workflows/roadmap.md).

## Auth

There is no auth yet. Single-user mode: every request is attributed to
`DEFAULT_USER_ID` in [auth.ts](../../packages/shared/src/auth.ts), and the migration
seeds a matching `users` row. Any change touching user scoping should keep the
`userId` parameter threaded through services so real auth is a small swap later.
