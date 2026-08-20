# Local-first & sync

Drilling must work offline. The **client is the source of truth for a live drill
session**; the server is sync/backup storage. FSRS scheduling math runs on the client
([scheduler.ts](../../apps/web/src/lib/srs/scheduler.ts)); the API only persists raw
card fields.

## IndexedDB

[apps/web/src/lib/idb/schema.ts](../../apps/web/src/lib/idb/schema.ts) — database
`chess-prep`, version 2, via `idb`. Five object stores:

| Store | Key | Purpose |
|---|---|---|
| `srsCards` | `moveId` | Every card, so drilling works offline. Indexes on `due` and `state`. |
| `repertoires` | `id` | Full `RepertoireFull` snapshots for offline reads. |
| `meta` | string key | Small KV — notably `srs.lastSyncedAt`. |
| `pushQueue` | `moveId` | Graded cards awaiting upload. |
| `openingNames` | `fenKey` | Phase 9a: book names for the user's own positions, so `openingName` [line scopes](../03-domain/srs-drilling.md#line-scopes-phase-9a) resolve offline. Cache only — safe to clear, refills from `POST /openings/by-fens`. |

Note `srsCards` is keyed by `moveId`, not card `id` — consistent with "one card per
move".

## The sync loop

[apps/web/src/lib/srs/sync.ts](../../apps/web/src/lib/srs/sync.ts):

- **`pullSince(repertoireId?)`** — `GET /srs/cards?since=<lastSyncedAt>`, merge into
  IndexedDB, store the server's `serverTime` as the new watermark (server clock, not
  client clock).
- **`pullAll(repertoireId?)`** — ignores the watermark; bootstrap for a new device or
  first drill on this browser.
- **`gradeAndQueue(card, grade)`** — applies FSRS locally, writes the card, enqueues it,
  then fires a best-effort `flushQueue()`. **Grading never fails because you're offline.**
- **`flushQueue()`** — `POST /srs/cards/push`. On any network/HTTP failure it returns
  early and leaves the queue intact for the next attempt. On success it clears the sent
  entries and merges the server's canonical reply back in.
- **`attachOnlineFlush()`** — flushes on the `online` event; returns an unsubscribe.

## Conflict resolution

**Last-write-wins by `updatedAt`**, implemented in `mergeCardsLocal`
([idb/schema.ts](../../apps/web/src/lib/idb/schema.ts)) and mirrored server-side in
`pushCards` ([services/srs.ts](../../apps/api/src/services/srs.ts)) — which reports
`accepted` vs `ignored` counts for updates it rejected as stale.

One deliberate choice: after a push, queued entries are cleared **regardless** of
whether the server accepted or ignored them. Ignored means the server already holds a
newer state, so retrying would loop forever.

## Offline-derived UI

[lib/repStats.ts](../../apps/web/src/lib/repStats.ts) computes per-repertoire badges
(due / cards / to-build) straight from IndexedDB, so the home screen renders correct
counts with no network.

## What is NOT offline

Repertoire *mutations* (adding moves, creating repertoires, PGN import/export) go
straight to the API — there is no write queue for tree edits, only for card grades.
Build mode therefore needs connectivity; drill mode does not.

The **opening book** is likewise online-only, except for the `openingNames` cache above.
A repertoire whose names were never fetched can still be drilled unscoped; only an
`openingName` scope degrades, and it degrades to an empty queue rather than a silently
unfiltered one.
