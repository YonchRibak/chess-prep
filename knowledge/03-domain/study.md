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
| **S3** | Web: Studies home as the default landing, upload/update modal, note-on-miss pause in all three drill implementations | not built |
| **S4** | Web: study browser view (tree + toggleable engine + Rashid) and the background Rashid scan with findings | not built |

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

## Not built yet

S3 and S4: no Studies home, no upload modal, no note-on-miss pause, no study browser,
no Rashid scan. The web client does not call the study endpoints yet.
