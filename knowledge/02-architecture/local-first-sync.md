# Local-first & sync

Drilling must work offline. The **client is the source of truth for a live drill
session**; the server is sync/backup storage. FSRS scheduling math runs on the client
([scheduler.ts](../../apps/web/src/lib/srs/scheduler.ts)); the API only persists raw
card fields.

## IndexedDB

[apps/web/src/lib/idb/schema.ts](../../apps/web/src/lib/idb/schema.ts) — database
`chess-prep`, version 3, via `idb`. Seven object stores:

| Store | Key | Purpose |
|---|---|---|
| `srsCards` | `moveId` | Every card, so drilling works offline. Indexes on `due` and `state`. |
| `repertoires` | `id` | Full `RepertoireFull` snapshots for offline reads. |
| `meta` | string key | Small KV — notably `srs.lastSyncedAt`. |
| `pushQueue` | `moveId` | Graded cards awaiting upload. |
| `openingNames` | `fenKey` | Phase 9a: book names for the user's own positions, so `openingName` [line scopes](../03-domain/srs-drilling.md#line-scopes-phase-9a) resolve offline. Cache only — safe to clear, refills from `POST /openings/by-fens`. |
| `drillAttempts` | attempt `id` | Phase 9d: the drill-attempt log. Indexes on `at` and `moveId`. **Not a cache** — the `mistakes` mode builds its queue from this, so it must be local. |
| `attemptQueue` | attempt `id` | Attempts awaiting upload. |

Note `srsCards` is keyed by `moveId`, not card `id` — consistent with "one card per
move".

**Deleting has to reach IndexedDB too.** `deleteRepertoire` clears that repertoire's
snapshot, and `clearAllRepertoireDataLocal()` (behind the store's `deleteAllRepertoires`)
clears `repertoires`, `srsCards`, `drillAttempts` and **both queues** in one transaction.
The queues are the part that is easy to miss: a pending push for a deleted move retries
against a 404 on every reconnect for the rest of the session, because offline-first means
the queue outlives the thing it refers to unless something clears it. `openingNames` and
`meta` survive — the ECO cache is not user data, and dropping it would cost a cold session
its offline scopes.

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
- **`attachOnlineFlush()`** — flushes both queues on the `online` event; returns an
  unsubscribe.

Phase 9d adds a parallel, simpler loop for the attempt log:

- **`logAttempt({ moveId, repertoireId, playedSan, wasCorrect })`** — writes locally and
  queues, then fires a best-effort `flushAttempts()`. Fire-and-forget by design: an
  attempt is input to the mistakes mode, and failing a drill because a log write failed
  would trade a real feature for a bookkeeping one.
- **`flushAttempts()`** — `POST /srs/attempts`; leaves the queue intact on failure.
- **`pullAttempts(repertoireId?, since?)`** — merges the server's log in. Only ever
  *adds*, and callers treat a failure as non-fatal, because the local log is what the
  mistakes queue reads. There is **no watermark** for attempts (no `meta` key): the
  append-only log has no update-in-place to miss, and ids are stable so re-merging is a
  no-op.

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
