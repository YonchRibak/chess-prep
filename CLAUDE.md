# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Start here

Read [knowledge/README.md](knowledge/README.md) before non-trivial work — it indexes
20 short docs covering the product, architecture, domain model, API, web app, and
workflows. Don't read the whole tree to orient yourself; the knowledge base exists to
make that unnecessary.

Authority order when sources disagree:
1. **The code** — always wins.
2. **[PROJECT_SPEC.md](PROJECT_SPEC.md)** — the phase-by-phase build brief. Describes
   *intent*, including parked and future work that isn't built.
3. **`knowledge/`** — describes *current state*.

Before touching anything, know these four (all detailed in the knowledge base):
- The one-prep-per-user-turn-position invariant is **application-level, not a DB
  constraint**.
- `fenKey()` in `packages/shared` is the **single** source of position identity.
- Engine gating lives at the engine **module**, not in a panel component.
- Types existing in `packages/shared/src/types.ts` does **not** mean a feature is wired
  (see the parked opponent-scouting types).

## Maintaining the knowledge base

`knowledge/` is a deliverable, not documentation debt. A stale knowledge base is worse
than none, because agents trust it. **When a change makes a knowledge doc wrong, fix the
doc in the same change as the code** — not in a follow-up.

### Decide: update an existing file, or create a new one?

Default to **updating an existing file**. The base is organized by *concern*, and almost
every change belongs to a concern that already has a home. Creating a new file
fragments the topic and leaves two half-truths where there was one.

**Update an existing doc when** — the change fits a concern already covered. Find its
owner in [knowledge/README.md](knowledge/README.md):

| Change touches | Doc to update |
|---|---|
| Schema, migrations, constraints, invariants | `02-architecture/data-model.md` |
| Endpoints, request/response shapes | `04-api/endpoints.md` |
| Service logic, validation, transactions | `04-api/services.md` |
| Walker traversal, seeds, skip/drop | `03-domain/walker.md` |
| Drill queues, FSRS, drill rules, daily diet | `03-domain/srs-drilling.md` |
| Stockfish, gating, eval surfaces | `03-domain/engine.md` |
| ECO book, import, opening naming | `03-domain/opening-database.md` |
| FEN normalization | `03-domain/fen-keying.md` |
| Views, hash routes, `View` union | `05-web/views-and-routing.md` |
| Zustand store shape or actions | `05-web/state-store.md` |
| Components, hooks, board interaction | `05-web/components-and-hooks.md` |
| IndexedDB, sync, offline behavior | `02-architecture/local-first-sync.md` |
| Packages, scripts, workspace layout | `02-architecture/monorepo.md` |
| New test, or a test's purpose changing | `06-workflows/testing.md` |
| Setup, env vars, migration workflow | `06-workflows/dev-setup.md` |
| A new stack choice, pitfall, or rule | `06-workflows/conventions.md` |
| Phase completed, debt added or paid | `06-workflows/roadmap.md` |
| A new domain term | `01-overview/glossary.md` |

**Create a new doc only when** all of these hold:
- The subject is a **distinct concern** with no existing owner above — typically a new
  subsystem (e.g. unparking opponent scouting, adding auth, adding a stats dashboard).
- It needs **more than a few paragraphs**; anything shorter belongs as a section in the
  nearest existing doc.
- Adding it to an existing file would make that file cover two unrelated things.

A new file is not justified by "the existing doc is getting long" — split only along a
real conceptual seam.

When you do create one:
1. Put it in the section folder that fits (`01-overview` … `06-workflows`); add a new
   numbered folder only for a genuinely new *category*.
2. Add a one-line entry to [knowledge/README.md](knowledge/README.md)'s map — an
   unindexed doc will not be found.
3. Link it from the related docs, and link back out from it.

### Writing standard

Match the existing docs:
- **Reference real files** with relative markdown links (`[schema.ts](../../apps/api/src/db/schema.ts)`).
  Verify paths resolve; a broken link is a bug.
- **Explain *why*, not just *what*.** The code already says what it does. The docs earn
  their place by capturing rationale, invariants, and the failure mode a rule prevents —
  especially where a violation fails *silently*.
- **State what is NOT built.** Parked features, known debt, and "types exist but nothing
  is wired" are the highest-value entries, because they're what an agent would otherwise
  assume wrong.
- Keep each doc scoped to one concern and cross-link rather than repeating. If the same
  fact appears in three files, it will diverge in three files — pick an owner and link.
- Be concise. These are read before every task; length is a real cost.

### Correcting the base

If you find a doc that contradicts the code, **the doc is wrong until proven otherwise** —
fix it, and say so in your response. Don't work around a stale doc silently, and don't
leave a correction for later: the next agent will trust the version that's on disk.

When a fix reveals the doc was wrong about an *invariant* (not just a detail), check
whether the code is actually upholding it — a doc/code mismatch on an invariant is often
a real bug, not a documentation lapse.
