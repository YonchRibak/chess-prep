# HTTP endpoints

Hono app: [apps/api/src/index.ts](../../apps/api/src/index.ts). Middleware is just
`logger()` and `cors({ origin: env.CORS_ORIGIN, credentials: true })` — **no auth
middleware**; every route calls a local `userId()` returning `DEFAULT_USER_ID`.

Default port `8787` ([env.ts](../../apps/api/src/env.ts): `DATABASE_URL` required,
`PORT`, `CORS_ORIGIN` comma-separated, default `http://localhost:5173`).

## Error convention

Services throw `HttpError` (exported from
[services/repertoires.ts](../../apps/api/src/services/repertoires.ts) and reused by the
other route files). Routes funnel through a small wrapper — `safeJson` in repertoires,
`safe` in openings, inline try/catch in srs — that maps `HttpError` → `{ error }` with
its status, and anything else → `500 { error: 'Internal error' }` after logging.

Bodies are read with `c.req.json().catch(() => ({}))`, so malformed JSON becomes a
validation error from the service rather than a crash.

## Health

`GET /health` → `{ ok: true, startingFenKey }`. The echoed key doubles as a cheap
`fenKey()` parity check against the client.

## `/repertoires`

[routes/repertoires.ts](../../apps/api/src/routes/repertoires.ts)

| Method & path | Body / params | Returns |
|---|---|---|
| `GET /repertoires` | — | `RepertoireSummary[]` |
| `POST /repertoires` | `{ name, color, tags?, seedSans? }` | `201` summary. `seedSans` auto-inserts an opening prefix |
| `GET /repertoires/:id` | — | `RepertoireFull` (summary + positions + moves) |
| `PATCH /repertoires/:id` | `{ name?, tags?, autoExpand? }` | summary |
| `DELETE /repertoires/:id` | — | `204` |
| `DELETE /repertoires` | — | `200 { deleted }`. **Wipes every repertoire of the user**, atomically. Its own path, not a flag on the single delete |
| `POST /repertoires/:id/moves` | `{ parentFenKey, san, isMainLine?, onConflict?, lineTags? }` | `201 AddedMove` |
| `POST /repertoires/:id/moves/batch` | `{ fromFenKey, sans[], onConflict?, lineTags? }` | `201 { added, reused, ... }` |
| `POST /repertoires/:id/refutations` | `{ fromFenKey, sans[] }` | `201 { added, reused, ... }`. Phase 9d shadow line — stored, never carded, never prep |
| `PATCH /repertoires/:id/moves/:moveId` | `{ comment?, annotation?, isMainLine?, priority?, isDropped?, lineTags? }` | `204` |
| `DELETE /repertoires/:id/moves/:moveId` | — | `204` |
| `POST /repertoires/import` | `{ name, color, pgn, tags? }` | `201` |
| `PATCH /repertoires/:id/drill-rules` | partial `DrillRules` | updated rules |
| `GET /repertoires/:id/export` | — | PGN text, `Content-Type: application/x-chess-pgn; charset=utf-8` |

`onConflict: 'refuse' | 'swap'` controls the
[one-prep-per-user-position invariant](../02-architecture/data-model.md#invariants-that-are-not-database-constraints).
`'refuse'` (the default path) yields **409**, which the walker UI turns into an inline
swap confirmation.

`lineTags` (Phase 9a) is optional on every write path. **Omitting it means "inherit from
the parent edge"; sending `[]` means "clear inheritance here"** — the two are not the
same. On `PATCH`, the tags cascade down the move's subtree, because retagging re-roots
inheritance. `PATCH /drill-rules` validates `scope` via `parseLineScope` and `400`s on a
malformed one; the rest of the rules body stays opaque jsonb.

## `/openings`

[routes/openings.ts](../../apps/api/src/routes/openings.ts) — all read-only.

| Endpoint | Notes |
|---|---|
| `GET /openings?q&eco&limit` | Name/ECO search |
| `GET /openings/by-fen/:fenKey` | `404` when unknown. Encode slashes as `%2F`; the key contains spaces and slashes, both of which round-trip cleanly. Validated by `validateAndNormalizeFenKey` |
| `GET /openings/continuations/:fenKey` | Known named moves from this position |
| `POST /openings/identify-deepest` | `{ fenKeys: string[] }` — path-walk in one round trip; rejects non-array or non-string entries with `400` |
| `POST /openings/by-fens` | `{ fenKeys: string[] }` → `{ openings: Record<fenKey, OpeningId> }`. Bulk lookup with **no** path walk — unknown keys are simply absent. Feeds the client's offline name cache for [line scopes](../03-domain/srs-drilling.md#line-scopes-phase-9a) |

## `/explorer`

[routes/explorer.ts](../../apps/api/src/routes/explorer.ts) — Phase 9b, read-through cache.

| Endpoint | Notes |
|---|---|
| `GET /explorer/:fenKey` | → `{ entry, source, backoffMs }`. `?cachedOnly=1` skips the network entirely |

**A cold miss with no network is `200` with `entry: null`, not an error.** Callers fall
back to book continuations; a 5xx would turn a degraded-but-fine state into a broken build
prompt. `backoffMs > 0` means a lichess `429` armed the global backoff and fetches are
paused (cache reads continue). See [explorer](../03-domain/explorer.md).

## `/srs`

[routes/srs.ts](../../apps/api/src/routes/srs.ts)

| Endpoint | Notes |
|---|---|
| `GET /srs/cards?since&repertoireId` | → `{ cards, serverTime }`. Omit `since` for a full bootstrap pull. `serverTime` becomes the client's next watermark — **server clock, not client clock** |
| `POST /srs/cards/push` | `{ updates: SrsCardDto[] }` → `{ accepted, ignored, cards }`. Last-write-wins by `updatedAt`; `ignored` are stale updates the server already superseded |
| `GET /srs/attempts?since&repertoireId&limit` | Phase 9d → `{ attempts, serverTime }`, newest first, capped at 5000. |
| `POST /srs/attempts` | Phase 9d `{ attempts: DrillAttemptDto[] }` → `{ accepted, ignored }`. **Append-only, not an upsert** — no conflict resolution; `ignored` counts attempts whose `moveId` doesn't exist. `repertoireId` in the body is ignored and taken from the move. |

## `/settings`

[routes/userSettings.ts](../../apps/api/src/routes/userSettings.ts)

| Endpoint | Notes |
|---|---|
| `GET /settings` | Get-on-first-read seeds defaults (`newCardsPerDay: 20`) |
| `PATCH /settings` | `{ newCardsPerDay? }` |

## Client wrapper

[apps/web/src/api/client.ts](../../apps/web/src/api/client.ts) — the `api` object mirrors
these one-to-one over a shared `request()` helper that sets JSON headers when a body is
present, unwraps `{ error }` into an `ApiError(status, message)`, and handles `204` /
non-JSON responses via `expectNoContent`. Base URL from `VITE_API_URL`, default
`http://localhost:8787`.
