# FEN keying

**Single source of truth:** [packages/shared/src/fen.ts](../../packages/shared/src/fen.ts).
Never normalize a FEN by hand anywhere else.

## What it does

A full FEN has six fields:

```
<pieces> <side-to-move> <castling> <en-passant> <halfmove-clock> <fullmove-number>
```

`fenKey(fen)` keeps the **first four** and drops the last two:

```ts
fenKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
// → 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
```

Rationale: the halfmove clock and fullmove number are *session state*, not position
identity. Dropping them makes **transpositions collapse to a single node** — the whole
point of a position-keyed tree. Side-to-move, castling rights, and en passant stay in
the key because they genuinely change the position.

`FenKey` is a branded string type (`string & { __brand: 'FenKey' }`) so a raw FEN can't
be passed where a key is expected without going through `fenKey()`. `isFenKey()` is the
runtime guard (4 fields). `fenKey()` throws on fewer than 4 fields.

## Who depends on parity

Three independent code paths must produce byte-identical keys:

1. The ECO importer ([import-openings.ts](../../apps/api/src/scripts/import-openings.ts))
   — every TSV row goes through `fenKey()` before persisting.
2. The API lookup — `GET /openings/by-fen/:fenKey` treats the path param as
   **already normalized** and does not re-parse it. See `validateAndNormalizeFenKey`
   in [services/openings.ts](../../apps/api/src/services/openings.ts).
3. The client repertoire tree and walker.

Drift here (whitespace, encoding, an extra field) silently breaks opening
identification and transposition collapse with no error. Guarded by:
- [packages/shared/src/fen.test.ts](../../packages/shared/src/fen.test.ts)
- [packages/shared/src/openings.test.ts](../../packages/shared/src/openings.test.ts) — pure-logic parity
- [apps/api/src/scripts/import-openings.parity.test.ts](../../apps/api/src/scripts/import-openings.parity.test.ts) — DB-touching integration

## Related helpers

`fenTurn(fen)` in [drill.ts](../../packages/shared/src/drill.ts) reads the side-to-move
field from either a full FEN or a key. `isUserMove(parentTurn, repertoireColor)` decides
whether a move from a given parent is the user's or the opponent's — this is what
determines whether a `Move` gets an SRS card.

## Storage note

Positions store **both** `fen_key` (identity, uniqueness) and `full_fen` (so the board
can be loaded with a plausible clock). Uniqueness is on the key only:
`uniq_repertoire_fen (repertoire_id, fen_key)`.
