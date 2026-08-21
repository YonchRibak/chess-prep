# Chess Prep — Knowledge Base

Orientation docs for code agents working on this repo. Each file is scoped to one
concern and links to the real source files, so start here rather than reading the
whole tree.

**Authoritative sources, in priority order:**
1. The code itself.
2. [PROJECT_SPEC.md](../PROJECT_SPEC.md) — the phase-by-phase build brief. Long, and
   describes intent (including parked/future work). These docs summarize what is
   *actually built*; the spec explains *why*.
3. These knowledge docs.

If a doc and the code disagree, the code wins — and the doc should be fixed.

## Map

### 01 — Overview
- [What this app is](01-overview/product.md) — product goals, the core loop, users.
- [Glossary](01-overview/glossary.md) — prep move, walker, seed, fenKey, card, book.

### 02 — Architecture
- [Monorepo layout](02-architecture/monorepo.md) — workspaces, package boundaries, scripts.
- [Separation of concerns](02-architecture/separation-of-concerns.md) — the four-layer rule that keeps this maintainable.
- [Data model](02-architecture/data-model.md) — tables, constraints, and the invariants that are *not* constraints.
- [Local-first & sync](02-architecture/local-first-sync.md) — IndexedDB, push queue, conflict rules.

### 03 — Domain
- [FEN keying](03-domain/fen-keying.md) — position identity and transposition collapse.
- [The walker](03-domain/walker.md) — build/drill as one traversal.
- [SRS & drilling](03-domain/srs-drilling.md) — FSRS, queues, drill modes, daily diet.
- [Opening database](03-domain/opening-database.md) — ECO book, import, lookup, auto-naming.
- [Engine & gating](03-domain/engine.md) — Stockfish worker, the hard no-leak guarantee.
- [Repertoire growth & line scopes](03-domain/repertoire-growth.md) — Phase 9, **all four sub-phases built** (line scopes, explorer cache, the growth loop, mistake rehearsal). Only weakness-steered growth remains design.
- [Opening explorer](03-domain/explorer.md) — frequency/result statistics, the cache, the candidate-selection policy, and how the build prompt consumes them.

### 04 — API (`apps/api`)
- [HTTP endpoints](04-api/endpoints.md)
- [Services layer](04-api/services.md)

### 05 — Web (`apps/web`)
- [Views & routing](05-web/views-and-routing.md)
- [State store](05-web/state-store.md)
- [Components & hooks](05-web/components-and-hooks.md)

### 06 — Working in this repo
- [Dev setup](06-workflows/dev-setup.md)
- [Testing](06-workflows/testing.md)
- [Conventions & gotchas](06-workflows/conventions.md)
- [Roadmap & status](06-workflows/roadmap.md)
