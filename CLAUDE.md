# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Vision

A web-first PWA for chess opening preparation, built by and for a single competitive
player who is also a fullstack dev — a more customizable replacement for Lotus Chess,
grounded in real opening theory. It does three things:

1. **Build a repertoire** on top of a bundled named-opening (ECO) database.
2. **Drill it** flashcard-style with FSRS spaced repetition, fully offline.
3. **Analyze** with Stockfish — everywhere *except* inside an unanswered flashcard.

The atomic unit is a **prepared move**: a parent position (normalized FEN) plus the
single move the user intends to play there. Build and Drill are not separate UIs — they
are two *seeds* into one **walker** over a position-keyed tree. See
[product.md](knowledge/01-overview/product.md) and [walker.md](knowledge/03-domain/walker.md).

**Non-negotiable qualities** — don't regress these:
- **Offline drilling.** The backend is a sync/backup target, never the source of truth
  for a live drill session.
- **No lock-in.** Round-trip-faithful PGN import *and* export.
- **Deep customizability.** Per-repertoire drill rules; a daily mixed-side session.
- **The engine never leaks a card's answer.**

## Technical stack

Monorepo: **pnpm workspaces** + TypeScript project references, Node ≥ 20, pnpm ≥ 10.

| Area | Choice |
|---|---|
| Web (`apps/web`) | React 18, Vite 6, Zustand, Tailwind, `vite-plugin-pwa` |
| Board / rules / engine | Chessground (render), chess.js (rules), stockfish.wasm (eval) |
| Scheduling | `ts-fsrs`, run **client-side** |
| Offline store | IndexedDB via `idb` |
| API (`apps/api`) | Hono on `@hono/node-server`, Drizzle ORM, Postgres (docker-compose) |
| Shared (`packages/shared`) | Types, `fenKey()`, opening ID, drill + PGN logic — the client/server contract |
| Tooling | Vitest, ESLint 9 + typescript-eslint (web), `tsx`, drizzle-kit |

Root scripts: `pnpm dev` / `dev:web` / `dev:api`, `build`, `test`, `lint`, `typecheck`,
`db:up`, `db:migrate`, `db:generate`, `db:studio`. Details in
[dev-setup.md](knowledge/06-workflows/dev-setup.md) and
[monorepo.md](knowledge/02-architecture/monorepo.md).

## Git guidelines

- **Always branch out.** Never commit work directly to `main` — create a
  descriptive branch (`feat/…`, `fix/…`, `docs/…`) before making changes.
- **Never merge or push to `main` without explicit permission.** Ask first, every time.
  This includes fast-forwards, rebases onto `main`, and force-pushes.
- Commit in coherent units, with a message saying *why*, not just what.
- A change and the knowledge-base update it requires belong in the **same commit**.
- Don't skip hooks (`--no-verify`) or bypass signing unless asked.

## Code conventions

- **Separation of concerns is the load-bearing rule.** Chessground draws and knows no
  rules; chess.js validates and draws nothing; Stockfish only evaluates; the opening DB
  only identifies. Each is wrapped in its own module/hook (`useBoard`, `useChessRules`,
  `useEngine`, `useOpeningId`) — components compose those wrappers and never reach past
  them. Full table in
  [separation-of-concerns.md](knowledge/02-architecture/separation-of-concerns.md).
- **Layer discipline:** shared logic that both sides must agree on lives in
  `packages/shared`; HTTP handlers stay thin and delegate to the services layer;
  React components stay presentational, with state in the Zustand store and side effects
  in hooks.
- **Never parse or normalize a FEN by hand** outside
  [fen.ts](packages/shared/src/fen.ts).
- **Types are a contract, not a feature flag.** A type in
  `packages/shared/src/types.ts` may describe something not wired up — verify before
  assuming.
- **Comments explain *why*.** Match the surrounding density; document invariants and the
  failure mode a rule prevents, especially where a violation fails *silently*. Skip
  comments that restate the code.
- **Tests:** Vitest everywhere. Cover domain logic (walker, FSRS, fen keying, PGN
  round-trip) and any invariant that isn't enforced by the type system or the DB. Record
  a new test's purpose in [testing.md](knowledge/06-workflows/testing.md).
- **Before finishing:** `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass. Report
  failures honestly rather than working around them.
- Prefer small, focused modules and explicit names over cleverness. Follow the existing
  idiom of the file you're in; see
  [conventions.md](knowledge/06-workflows/conventions.md) for stack-specific gotchas.

## Start here

Read [knowledge/README.md](knowledge/README.md) before non-trivial work — it indexes
22 short docs covering the product, architecture, domain model, API, web app, and
workflows. Don't read the whole tree to orient yourself; the knowledge base exists to
make that unnecessary.

Authority order when sources disagree:
1. **The code** — always wins.
2. **[PROJECT_SPEC.md](PROJECT_SPEC.md)** — the phase-by-phase build brief. Describes
   *intent*, including parked and future work that isn't built.
3. **`knowledge/`** — describes *current state*.

Before touching anything, know these five (all detailed in the knowledge base):
- The one-prep-per-user-turn-position invariant is **application-level, not a DB
  constraint**.
- `fenKey()` in `packages/shared` is the **single** source of position identity.
- Engine gating lives at the engine **module**, not in a panel component.
- Types existing in `packages/shared/src/types.ts` does **not** mean a feature is wired
  (see the parked opponent-scouting types). That file mirrors the *schema*; the actual
  wire contract is the service DTO / `apps/web/src/api/client.ts`.
- Anything explorer-shaped must work with its cache **cold** — offline, and on networks
  where lichess's explorer host is blocked. Silent writes (auto-expansion) require real
  frequency data and must never re-add a dropped branch.

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
| Explorer stats, its cache, candidate ranking, auto-expansion | `03-domain/explorer.md` |
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
- **Reference real files** with relative markdown links (e.g. `[schema.ts](../../apps/api/src/db/schema.ts)` from a `knowledge/<section>/` file — link targets are relative to the linking doc).
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
