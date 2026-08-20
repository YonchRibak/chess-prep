# Dev setup

Requires Node >= 20 and pnpm >= 10 (pinned `packageManager: pnpm@10.23.0`), plus Docker
for Postgres.

## First run

```bash
pnpm install
pnpm db:up                                          # Postgres 16 on :5432
cp apps/api/.env.example apps/api/.env              # then check DATABASE_URL
pnpm db:migrate                                     # applies drizzle/ + seeds the default user
pnpm --filter @chess-prep/api db:import-openings    # loads the ECO book (~3,733 rows)
pnpm dev                                            # web :5173 + api :8787
```

Docker credentials from [docker-compose.yml](../../docker-compose.yml):
`chess:chess@localhost:5432/chess_prep`, volume `chess_prep_pgdata`, with a `pg_isready`
healthcheck.

## Environment

[apps/api/src/env.ts](../../apps/api/src/env.ts) — `DATABASE_URL` is **required** and the
process throws on startup without it. `PORT` defaults to `8787`; `CORS_ORIGIN` is
comma-separated, defaulting to `http://localhost:5173`.

Web side: `VITE_API_URL`, defaulting to `http://localhost:8787`.

## TLS interception on this machine

Avast performs TLS MITM here, so Node rejects registry/fetch certs by default. The repo
vendors `.corp-ca.pem`; point Node at it when installing or fetching:

```bash
export NODE_EXTRA_CA_CERTS=/c/code/chess-prep/.corp-ca.pem   # bash
$env:NODE_EXTRA_CA_CERTS = "C:\code\chess-prep\.corp-ca.pem" # PowerShell
```

## Opening explorer reachability (Phase 9b)

`explorer.lichess.ovh` returns **401 from an nginx** on this machine for every request,
regardless of headers, while `lichess.org` itself answers normally — so the explorer cache
never fills here. That is a *supported* degraded state (candidate selection falls back to
the ECO book), but it is worth knowing before debugging empty candidate lists.

```bash
pnpm --filter @chess-prep/api probe:explorer     # prints the entry, or NULL
```

The service never throws and logs only a warning, so the probe is how you tell "no data"
from "broken". See [explorer](../03-domain/explorer.md).

## Everyday commands

| Command | Effect |
|---|---|
| `pnpm dev` | Both apps, parallel, streamed |
| `pnpm dev:web` / `pnpm dev:api` | One side (api via `tsx watch`) |
| `pnpm typecheck` | All packages |
| `pnpm test` | All packages — see [testing](testing.md) |
| `pnpm lint` | Only meaningful for `apps/web` |
| `pnpm build` | `tsc -b && vite build` (web), `tsc` (api) |
| `pnpm db:generate` | Generate a migration after editing `schema.ts` |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm db:down` | Stop Postgres (volume persists) |

## Changing the schema

1. Edit [apps/api/src/db/schema.ts](../../apps/api/src/db/schema.ts).
2. `pnpm db:generate` — writes a new SQL file plus a snapshot under
   [apps/api/drizzle/](../../apps/api/drizzle/).
3. `pnpm db:migrate`.
4. Update the mirrored types in [packages/shared/src/types.ts](../../packages/shared/src/types.ts)
   and the service DTOs if the wire shape changed.

Commit the generated SQL and `meta/` snapshots — Drizzle's journal depends on them.

## Reloading the opening book

The importer drops and reloads the whole table, so it's safe to re-run at any time. It
touches nothing user-owned.
