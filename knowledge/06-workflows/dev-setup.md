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
pnpm --filter @chess-prep/api db:import-explorer-snapshot  # F3: loads the bundled frequency snapshot (if vendored)
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

The lichess opening-explorer host answers **401 to anonymous requests** — from every
network, not just this machine (diagnosed 2026-08; see
[explorer](../03-domain/explorer.md#the-401-properly-diagnosed-2026-08)). Fix: create a
**personal access token** (no scopes) at <https://lichess.org/account/oauth/token> and
set it in `apps/api/.env`:

```
LICHESS_TOKEN=lip_xxxxxxxxxxxxxxxx
```

Both the cache service and `snapshot:build` attach it automatically. Without it, the
explorer tiers degrade to cache → **bundled snapshot** → book
([explorer](../03-domain/explorer.md#the-bundled-snapshot-flow-f3)).

```bash
pnpm --filter @chess-prep/api probe:explorer     # prints the entry + which tier answered, or NULL
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
| `pnpm lint` | Only meaningful for `apps/web` — flat config, `--max-warnings 0`. See [monorepo](../02-architecture/monorepo.md) |
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
