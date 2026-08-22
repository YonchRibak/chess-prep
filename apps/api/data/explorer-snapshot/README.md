# Explorer snapshot (Flow F3)

Vendored frequency data for the common opening positions, generated from the
[lichess opening explorer](https://lichess.org/api#tag/Opening-Explorer)
(`explorer.lichess.ovh/lichess`, speeds blitz/rapid/classical, ratings ≥1600).
Lichess game data is published under generous terms (their open database is
CC0); this mirrors the precedent of the vendored ECO TSVs in
[../openings/](../openings/) — note the source when redistributing.

- `snapshot.jsonl` — one JSON object per position: `{ fenKey, total, moves }`.
- `meta.json` — `generatedAt`, `source`, the depth/floor used, row count.

Generate on a machine where the explorer host answers (the primary dev box
cannot — that's the point of the snapshot):

```
pnpm --filter @chess-prep/api snapshot:build -- --depth 12 --min-share 0.02
```

Import (drop-and-reload of `explorer_snapshot_entries`):

```
pnpm --filter @chess-prep/api db:import-explorer-snapshot
```

Regenerate ~yearly, like the book. The files are not yet committed if this
directory contains only this README — the guided flow then falls back to the
live explorer / book exactly as before F3.
