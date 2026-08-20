# State store

**Zustand, one store, no Redux.**
[apps/web/src/store/app.ts](../../apps/web/src/store/app.ts).

```ts
interface AppStore {
  view: View
  repertoires: RepertoireSummary[]   // list summaries
  active: RepertoireFull | null      // the loaded tree
  loading: boolean
  error: string | null
  // …actions
}
```

## Shape rules

- **One active repertoire at a time.** `active` holds the full tree (positions + moves);
  everything tree-shaped — the walker, drill queues, the editor — reads from it. The
  daily diet is the exception: it pulls snapshots for *several* repertoires itself rather
  than going through `active`.
- **`error` is a string, not an Error.** `asError()` normalizes: `ApiError` → `"404: …"`,
  `Error` → its message, anything else → `"Unknown error"`. Rendered by the shell's
  `ErrorBanner`; cleared with `clearError()`.
- Subscribe with selectors (`useAppStore(s => s.view)`), not the whole store.

## Actions

| Group | Actions |
|---|---|
| Navigation | `go(view)` — also clears `active` when landing on `list` |
| Loading | `loadList()`, `loadRepertoire(id)` (loads **without** changing the view — for the router / deep links), `openRepertoire(id)` (load + navigate), `reloadActive()` |
| Repertoire CRUD | `createRepertoire({ name, color, tags?, seedSans? })`, `importPgn({ name, color, pgn, tags? })`, `renameRepertoire`, `deleteRepertoire`, `exportPgn(id)`, `patchDrillRules(id, rules)` |
| Move edits | `addMove(parentFenKey, san, isMainLine?)`, `setComment`, `setAnnotation`, `setMainLine`, `setPriority`, `deleteMove` |

Note the deliberate split between `loadRepertoire` and `openRepertoire` — mixing them up
is how deep links break. See [views-and-routing](views-and-routing.md#hash-routing).

## Write path

Mutations call the API ([api/client.ts](../../apps/web/src/api/client.ts)) and then
refresh from the server rather than patching local state optimistically — the server
computes SAN/UCI/child FEN through chess.js, so its response is authoritative. After a
load, `putRepertoireLocal(rep)` writes the snapshot into IndexedDB for offline reads.

Repertoire mutations are **online-only**; only SRS grades are queued for offline sync.
See [local-first](../02-architecture/local-first-sync.md).

## What is NOT in the store

- **SRS cards.** They live in IndexedDB and are read directly by drill/daily/walker
  sessions via [idb/schema.ts](../../apps/web/src/lib/idb/schema.ts).
- **Engine state.** Owned by the `Engine` singleton and surfaced through `useEngine`.
- **Session state** (current card, queue position, grading, skip set). Local to each
  session component so a session cannot outlive its own view.
