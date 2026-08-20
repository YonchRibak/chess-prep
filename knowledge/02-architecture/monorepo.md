# Monorepo layout

pnpm workspaces (`pnpm-workspace.yaml`: `apps/*`, `packages/*`). Node >= 20, pnpm >= 10.
All packages are ESM (`"type": "module"`) and TypeScript.

```
apps/web        @chess-prep/web      React + Vite PWA (the whole UI)
apps/api        @chess-prep/api      Hono + Drizzle + Postgres
packages/shared @chess-prep/shared   types + pure logic used by BOTH sides
```

## packages/shared — the contract

Consumed as raw TypeScript source (`"main": "./src/index.ts"`), not a build artifact,
so there is no build step to keep in sync. Subpath exports exist for
`./auth`, `./drill`, `./fen`, `./openings`, `./types`, `./pgn`.

| File | Contains |
|---|---|
| [fen.ts](../../packages/shared/src/fen.ts) | `fenKey()`, the branded `FenKey` type, `STARTING_FEN`. **Single source of truth for position identity.** |
| [types.ts](../../packages/shared/src/types.ts) | Wire-shape entities: `Repertoire`, `Position`, `Move`, `SrsCard`, opponent-scouting types (unused, parked). |
| [drill.ts](../../packages/shared/src/drill.ts) | `SrsCardDto`, `Grade`, `FsrsState`, `DrillMode`, `DrillRules` + `mergeDrillRules`, `isUserMove`, `fenTurn`. |
| [openings.ts](../../packages/shared/src/openings.ts) | `identifyOpening` / `identifyDeepestOpening` — one matcher shared by client and server. |
| [pgn.ts](../../packages/shared/src/pgn.ts) | PGN tree parse/serialize with variations, NAGs, comments. |
| [auth.ts](../../packages/shared/src/auth.ts) | `DEFAULT_USER_ID` single-user placeholder. |

**Rule:** anything that must produce identical results on both client and server —
FEN normalization, opening matching, drill-rule defaults, turn/side logic — belongs
here, not duplicated. Divergence in `fenKey()` alone would silently break the entire
position-keyed model.

## Scripts

Root ([package.json](../../package.json)) fans out with `pnpm -r`:

| Command | Effect |
|---|---|
| `pnpm dev` | web + api in parallel |
| `pnpm dev:web` / `pnpm dev:api` | one side only |
| `pnpm build` / `pnpm test` / `pnpm lint` / `pnpm typecheck` | recursive |
| `pnpm db:up` / `db:down` | docker-compose Postgres 16 (`chess:chess@localhost:5432/chess_prep`) |
| `pnpm db:migrate` / `db:generate` / `db:studio` | Drizzle Kit |

API-only: `pnpm --filter @chess-prep/api db:import-openings` loads the ECO TSVs.

Note `lint` is only configured on `apps/web` (ESLint 9 flat-ish config via CLI args);
api and shared echo a placeholder. `apps/api` runs `vitest run --passWithNoTests`
because its tests need a live database.

## Runtime topology

- Web dev server on `5173`, API on `8787` (`PORT`), CORS allow-list via `CORS_ORIGIN`.
  See [env.ts](../../apps/api/src/env.ts).
- Stockfish is served as static assets from [apps/web/public/stockfish/](../../apps/web/public/stockfish/)
  and loaded into a Web Worker — it is not a bundled dependency at runtime.
- The API has no session/auth middleware; `DEFAULT_USER_ID` is applied in routes.
