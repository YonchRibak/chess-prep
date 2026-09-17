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
- **Session state is not in the store.** Each drill surface keeps its phase machine in
  local React state; S5's lives in the `useRehearseSession` hook. The store only carries
  the `View` (`rehearse` since S5) and the `active` tree the session reads.

## Actions

| Group | Actions |
|---|---|
| Navigation | `go(view)` — also clears `active` when landing on `studies` or `list`. Initial view is `studies` (Study S3) |
| Loading | `loadList()`, `loadRepertoire(id)` (loads **without** changing the view — for the router / deep links), `openRepertoire(id)` (load + navigate), `reloadActive()` |
| Repertoire CRUD | `createRepertoire({ name, color, tags?, seedSans? })`, `importPgn({ name, color, pgn, tags? })`, `renameRepertoire`, `deleteRepertoire`, `deleteAllRepertoires()`, `exportPgn(id)`, `patchDrillRules(id, rules)`, `setAutoExpand(id, on)` |
| Studies (S3) | `importStudy({ pgn, color, name?, tags? }) → { id, summary }`, `updateStudy(id, pgn) → summary`. Both write the returned `RepertoireFull` straight into IndexedDB (and into `active` if it is loaded) — the response *is* the fresh snapshot, so an offline rehearsal right after an update drills the new tree |

`deleteRepertoire` and `deleteAllRepertoires` both call the server **first** and touch
IndexedDB only after it succeeds — a failed request must leave the offline copy still
matching the server, not ahead of it. See
[local-first-sync](../02-architecture/local-first-sync.md#indexeddb).
| Move edits | `addMove(parentFenKey, san, isMainLine?)`, `setComment`, `setAnnotation`, `setMainLine`, `setPriority`, `setLineTags`, `deleteMove` |

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
- **The Rashid study scan** — deliberately the opposite: it lives in a *second*
  Zustand store, [store/rashidScan.ts](../../apps/web/src/store/rashidScan.ts),
  because it is engine work that must outlive the view that started it (see
  [rashid](../03-domain/rashid.md)). It is not folded into `app.ts` so `app.ts` stays
  a UI/data store with no engine lifecycle in it.
