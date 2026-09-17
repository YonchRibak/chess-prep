# Study flow — lichess study PGN → rehearsal

The study flow moves *preparation* to lichess and keeps this app for *rehearsal*.
A lichess study export (one chapter, or the whole study as a multi-game PGN)
becomes **one repertoire**, re-imported whenever the study changes. The user
prepares in lichess; here they drill it, read their own notes when they miss,
browse it with the engine, and run Rashid over it.

Status by phase:

| Phase | What | Status |
|---|---|---|
| **S1** | Shared parsing + prep policy ([study.ts](../../packages/shared/src/study.ts)) | ✅ built |
| **S2** | API: `repertoires.source` provenance + upsert sync endpoints ([studies.ts](../../apps/api/src/services/studies.ts)) | ✅ built |
| **S3** | Web: Studies home as the default landing, upload/update modal, note-on-miss pause in all three drill implementations | ✅ built |
| **S4** | Web: study browser view (tree + toggleable engine + Rashid) and the background Rashid scan with findings | ✅ built |
| **S5** | Web + API: one-click chapter rehearsal (`#/rehearse`), animated line transitions, Expand variations, and `moves.origin` so app-recorded extensions survive re-import | ✅ built |

## Parsing — [study.ts](../../packages/shared/src/study.ts)

`studyPgnToTree(pgn, color)` is the entry point; it composes four pure steps so
each is testable on its own and the API and the web client cannot disagree:

1. **`parseStudyChapters`** — `parseGames` from `@mliebelt/pgn-parser` splits the
   export; each game becomes a `StudyChapter` with its own tree via the shared walk
   `parsedMovesToTree` in [pgn.ts](../../packages/shared/src/pgn.ts) (the same walk
   the legacy `pgnToTree` uses, so legality, SAN canonicalization and edge dedupe are
   identical). Chapter name: `ChapterName` tag → the part after `": "` in `Event`
   (lichess writes `"Study: Chapter"`) → a bare `Event` → `Chapter N`. A `[FEN]` tag
   sets the chapter's start position. Non-standard `Variant` tags are rejected.
   Comments are **trimmed** on this path only — lichess pads them with spaces and the
   legacy import keeps them verbatim for round-trip fidelity.
2. **`mergeChapterTrees`** — unions positions by fenKey and edges by
   `parentFenKey::san`. Each edge's `lineTags` is the list of chapters that contain it
   (a shared prefix like `1.e4` belongs to every chapter); comment/annotation come
   from the first chapter that has one; `isMainLine` is true if any chapter has it on
   the line. **A chapter whose start position is unreachable from the first chapter's
   root is rejected** with the chapter's name: the walker starts at the root, so a
   detached chapter would be silently un-rehearsable.
3. **`applyStudyPrepPolicy`** — enforces one-prep-per-hero-position *structurally*
   rather than by refusing the import. At each parent where the hero is to move, the
   hero's edges rank by (earliest chapter where it is main-line, earliest chapter,
   encounter order). The winner is forced onto the main line; every other hero edge
   becomes a **demoted alternate**: `isDropped: true`, `isMainLine: false`, and a
   `StudyDemotion` record (`reason: 'cross-chapter'` if it was main-line in its own
   chapter, `'variation'` otherwise) so the UI can show what the policy decided.
   Opponent-turn parents are untouched — several replies is the normal shape of prep.
   Consequence worth knowing: **chapter order in the PGN is semantically meaningful**.
4. **`liveReachablePositions`** — BFS from the root over non-demoted edges. This is
   the card-eligibility set for the API: a hero move below a demoted alternate is never
   played in rehearsal and must not be carded, *unless* a live path transposes into the
   same position (then it is live, and so is everything under it).

`studyHeader` reads the study name/url from the first chapter's tags for the
provenance record and the modal's name prefill.

### Why `isDropped` for alternates

Reusing the "won't cover" flag means every existing consumer already does the right
thing with zero changes: the walker ignores the edge and its subtree, queue builders
skip it, auto-expansion never re-adds it, the editor renders it struck-through, and
Rashid precompute excludes it. The cost is a double meaning (user drop vs. study
demotion) on study-sourced repertoires; S2 documents the rule "the PGN is the source
of truth for user-side `is_dropped` on study repertoires" and hardens `patchMove`'s
undrop path with the one-prep invariant check. A dedicated `prep_role` column is the
clean v2 if the overlap chafes — the policy is isolated in one function to keep that
door open.

## Shared DTOs

- `RepertoireSource` — the provenance stored on a study repertoire (study name/url,
  chapter list, SHA-256 of the imported PGN text, `importedAt`). `null` on hand-built
  repertoires; the update endpoint refuses those.
- `StudySyncSummary` — what both study endpoints return: counts of positions/moves
  added/updated/removed, cards created vs kept (SRS history preserved), the demotion
  list, and how many user-authored refutation shadow lines the sync left alone.

## API (S2)

`POST /repertoires/import-study` and `POST /repertoires/:id/import-study` — see
[endpoints](../04-api/endpoints.md) and the diff algorithm in
[services](../04-api/services.md#studiests). The column is `repertoires.source`
([data-model](../02-architecture/data-model.md#repertoires)).

## Web (S3)

- **Landing**: `#/` is [StudiesHome](../../apps/web/src/pages/StudiesHome.tsx); the
  hand-built list moved to `#/repertoires`
  ([views](../05-web/views-and-routing.md)). Cards show due/cards/chapters, and each
  chapter chip starts a walker drill session scoped to that chapter's tag.
- **Upload / Update**: `ImportStudyModal`
  ([components](../05-web/components-and-hooks.md)) parses the PGN client-side for a
  preview, then calls the store's `importStudy` / `updateStudy`
  ([state-store](../05-web/state-store.md)). The sync summary is shown after submit —
  it is the one place the user learns which alternates were demoted and why.
- **Note on a miss**: a `note` stage in the wrong-answer flow of all three drill
  implementations ([srs-drilling](srs-drilling.md#flow-mode)).
- "Browse" on a study card opens the study browser (S4).

## Browser + Rashid scan (S4)

- **Browser** — `#/study/:id` ([views](../05-web/views-and-routing.md)): the study's
  variation tree and breadcrumb (shared with the editor via
  [TreeView](../05-web/components-and-hooks.md)), the note on the current move with its
  chapter chips, keyboard stepping, and a board that navigates when a played move is
  in the study and snaps back otherwise. The engine eval panel and the Rashid probe
  are both **off until toggled** — it is an ungated surface
  ([engine](engine.md#who-gates-what)) that stays quiet by default.
- **Scan** — "Scan whole study" (browser) or "Scan with Rashid" (home card) runs the
  R5 precompute over every hero position, **alternates included by default**, in
  [store/rashidScan.ts](../../apps/web/src/store/rashidScan.ts); it survives
  navigation, pauses while drilling, and reports positions where Rashid lights up as
  a clickable findings list with each position's path and chapter. "Load from cache"
  rebuilds the list from cache layer B after a reload. Details and rules in
  [rashid](rashid.md).

## Rehearsal session (S5) — the main loop's front door

[RehearseSession.tsx](../../apps/web/src/pages/RehearseSession.tsx) (layout) ·
[useRehearseSession.ts](../../apps/web/src/lib/rehearse/useRehearseSession.ts) (state
machine + every side effect) · view `rehearse`, hash `#/rehearse/:id[/:chapterTag]`
([views](../05-web/views-and-routing.md)).

**Why a fourth drill implementation.** The walker's drill seed carried build, guided,
lock-in and drill-pauses-for-build concerns into a screen whose only job is "click a
chapter, play moves". Rather than thread a simpler mode through that phase machine, S5
is a focused page over the same tree, queue builder, FSRS and board — and the pieces
that *are* shared with the older surfaces were extracted (`missFlow.ts`,
`useLineTransition`) so they can adopt them later. Recorded as debt in
[srs-drilling](srs-drilling.md#four-drill-implementations-known-debt).

**One click.** A chapter row on the Studies home (mastery ring, due count, Start/Resume —
the last rehearsed chapter per study is remembered in the IndexedDB `meta` KV) starts
the session directly. No mode, no rules, no "cards due" gate.

**Queue** — [rehearse/queue.ts](../../apps/web/src/lib/rehearse/queue.ts): *every* live
hero move in scope, **shuffled** (the user's choice), via `buildDrillQueue({ mode:
'random' })` under the chapter's tag scope. Stored drill rules are deliberately ignored.
A hero move whose card the local store has not pulled yet gets a **stub card**
(`emptyCardFor`); grading a stub pushes by `moveId` onto the real card, so nothing is
invented server-side. **Stubs and items are restricted to live-reachable parents**
([rehearse/reachable.ts](../../apps/web/src/lib/rehearse/reachable.ts)): the queue
builder only skips a dropped move *itself*, so a hero move below a demoted alternate is
not dropped, is never carded by the API, and has no path from the root — stubbing it
put cards on the board that could only render as the starting position (the S5 launch
bug). No idle timer anywhere: a card waits as long as the user likes; the hint is on
demand only. Each item carries `pathSans` from `findPathToPosition` with the
S5 `prefer` option, so a transposition is replayed through the chapter's own line.

**Grading is silent**: correct = Good, wrong = Again, correct-after-hint = Hard.
Every answer goes through `gradeAndQueue` + `logAttempt`, so the daily session and
mistakes mode see exactly what happened here. `N` skips without grading; skipped
cards return once at the end of the session.

**Transitions** — [lineTransition.ts](../../apps/web/src/lib/chess/lineTransition.ts)
(pure planner, tested) + [useLineTransition.ts](../../apps/web/src/lib/chess/useLineTransition.ts):
by default (`'last-ply'`) the board is set to the position *before* the next card's
final ply with no animation and only that ply — the opponent's move the card asks
about — glides in and stays as the last-move highlight, like stepping to a position
on lichess; a one-ply continuation simply animates. "▶ Replay line" under the board
replays the whole line from the start to the current position on demand (board locked
meanwhile) — a button, deliberately not a mode. "Show moves" toggles the SAN list, off
by default (`rehearse.showLine`). The hook's `'full'` mode (ply-by-ply between cards)
exists but nothing selects it. `useBoard` gained `animationMs` for this; chessground reads `animation.duration` per
`set`, so it must travel with the fen. Timings live in
[rehearse/timings.ts](../../apps/web/src/lib/rehearse/timings.ts). Every sequence
runs under one `AbortController`; an interrupted transition stops where it is and the
next one re-plans from the board's real history.

**Miss flow** — reveal → note (if the correct move has a comment; the S3 `StudyNote`)
→ retry (only the correct move advances, no re-grade). Interference and the
refutation prompt are the Phase 9d ones. Feedback is deliberately quiet — the panel
text and an optional sound (off by default, `meta` key `rehearse.sound`); no flashes
or shakes on the board, and no idle timer of any kind.

**Engine gating per phase** ([engine](engine.md#who-gates-what)): gated in every
card phase including the transition (its end position *is* the next card). Ungated
only in Expand, and — when the session's *eval after answer* toggle is on — for a
short pause after a correct answer showing the **eval bar only**: the PV's second ply
is the hero's next move and may be a later card.

**Expand variations** — [rehearse/expand.ts](../../apps/web/src/lib/rehearse/expand.ts)
(pure, tested): walks the scope's opponent-turn positions shallow-first and offers
replies the study does *not* cover (`uncoveredReplies` excludes live, dropped **and**
shadow SANs — the auto-expansion rule). Source order: explorer → engine MultiPV →
ECO book → nothing; a cold explorer never blocks (offline works). The user picks a
deviation, the board plays it, and their answer on the board is saved through the
existing batch endpoint (opponent ply uncarded, hero ply carded, `lineTags` inherited
so the new card is in the chapter's scope next time). Eval bar always visible;
PV lines and board arrows behind "Show suggestions", off by default. Unlike 9c
auto-expansion nothing is written silently, so book/engine sources are acceptable.

**Extensions survive re-import** — `moves.origin`
([data-model](../02-architecture/data-model.md#moves)): everything the study sync
writes is `'study'`; everything the app writes is `'user'`. The sync keeps `'user'`
edges while their parent is still connected to the root, **adopts** them if a later
study version contains the same edge (row, card and attempts survive), **parks** them
(dropped, card kept) if the study now plays a different hero move at that parent — the
study owns the prep slot — and deletes them only when the line above them is gone.
Rules and counts in [services](../04-api/services.md#syncrepertoirefromtree--a-diff-not-a-reload);
the browser colours extensions apart (`TreeView markOrigin`) and the update modal
reports kept / adopted / removed / demoted.

## Not built

- Demoted extensions are not restorable from the session UI (undrop in the browser
  runs the one-prep check, as for any dropped move).
- The three older drill implementations have not adopted `missFlow.ts` /
  `useLineTransition`; they still snap-load positions.
- Export of a whole study is still a single game (`exportPgn` unchanged) — debt
  against the "no lock-in" quality.
- Detached `[FEN]` chapters are rejected rather than imported as separate studies.
- The browser does not write its position back to the hash while stepping (deep-link
  in only); a tab refresh returns to the root.
