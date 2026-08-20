/**
 * Idempotent importer for the ECO opening book.
 *
 * Reads the bundled lichess `chess-openings` TSVs from apps/api/data/openings/,
 * computes a normalized `fenKey` for every line by replaying the PGN through
 * chess.js, and replaces the entire `opening_book_entries` table in one
 * transaction. Safe to run any number of times: it's a drop+reload, not a diff.
 *
 * Usage:
 *   pnpm --filter @chess-prep/api db:import-openings
 *
 * The lichess TSV columns are: `eco<TAB>name<TAB>pgn`. The lichess `name`
 * collapses "Opening: Variation, Sub-variation" into a single string; we split
 * at the first ":" to populate `name` + `variation` (see `splitOpeningName`).
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { fenKey, splitOpeningName } from '@chess-prep/shared';
import { db } from '../db/client.js';
import { openingBookEntries } from '../db/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/ → src/ → api/ → data/openings/
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'openings');
const TSV_FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];

interface Row {
  eco: string;
  name: string;
  variation: string | null;
  fenKey: string;
  fullFen: string;
  pgnMoves: string;
}

function parseTsv(text: string, sourceLabel: string): Array<{ eco: string; name: string; pgn: string }> {
  const lines = text.split(/\r?\n/);
  const out: Array<{ eco: string; name: string; pgn: string }> = [];
  let header = true;
  let lineNo = 0;
  for (const raw of lines) {
    lineNo++;
    if (!raw.trim()) continue;
    if (header) {
      // first non-empty line should be `eco\tname\tpgn`
      header = false;
      if (!/^eco\t/i.test(raw)) {
        throw new Error(`${sourceLabel}:${lineNo} missing header — got "${raw.slice(0, 40)}"`);
      }
      continue;
    }
    const cols = raw.split('\t');
    if (cols.length < 3) {
      throw new Error(`${sourceLabel}:${lineNo} expected 3 tab-separated columns, got ${cols.length}`);
    }
    out.push({ eco: cols[0]!.trim(), name: cols[1]!.trim(), pgn: cols[2]!.trim() });
  }
  return out;
}

function rowFromPgn(eco: string, fullName: string, pgn: string, sourceLabel: string): Row {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch (e) {
    throw new Error(`${sourceLabel}: failed to replay PGN for "${fullName}" (${eco}): ${(e as Error).message}`);
  }
  const fullFen = chess.fen();
  const { name, variation } = splitOpeningName(fullName);
  return {
    eco,
    name,
    variation,
    fenKey: fenKey(fullFen),
    fullFen,
    pgnMoves: pgn,
  };
}

async function main() {
  const allRows: Row[] = [];
  for (const fname of TSV_FILES) {
    const path = resolve(DATA_DIR, fname);
    const text = await readFile(path, 'utf8');
    const parsed = parseTsv(text, fname);
    console.log(`${fname}: ${parsed.length} entries`);
    for (const p of parsed) {
      allRows.push(rowFromPgn(p.eco, p.name, p.pgn, fname));
    }
  }

  // Collapse duplicate fenKeys — the lichess data occasionally lists the same
  // position under multiple names (rare, but it happens because some lines
  // transpose). Keep the LONGEST `name + variation` so the deepest match wins
  // when sorted by specificity.
  const byKey = new Map<string, Row>();
  let collisions = 0;
  for (const r of allRows) {
    const existing = byKey.get(r.fenKey);
    if (!existing) {
      byKey.set(r.fenKey, r);
      continue;
    }
    collisions++;
    const existingLen = existing.name.length + (existing.variation?.length ?? 0);
    const newLen = r.name.length + (r.variation?.length ?? 0);
    if (newLen > existingLen) byKey.set(r.fenKey, r);
  }
  const deduped = [...byKey.values()];
  console.log(
    `Parsed ${allRows.length} rows, ${deduped.length} unique fenKeys (${collisions} collisions resolved by longer name)`,
  );

  await db.transaction(async (tx) => {
    // Drop-and-reload, atomic. TRUNCATE keeps DDL/indexes intact and is faster
    // than DELETE for a wipe.
    await tx.execute(/* sql */ `TRUNCATE TABLE opening_book_entries`);

    // Bulk insert in chunks to stay under the postgres parameter limit
    // (postgres caps at ~65535 bound params; 6 columns/row → 10000 row chunks
    // is comfortable).
    const CHUNK = 1000;
    for (let i = 0; i < deduped.length; i += CHUNK) {
      const chunk = deduped.slice(i, i + CHUNK);
      await tx.insert(openingBookEntries).values(
        chunk.map((r) => ({
          eco: r.eco,
          name: r.name,
          variation: r.variation,
          fenKey: r.fenKey,
          fullFen: r.fullFen,
          pgnMoves: r.pgnMoves,
        })),
      );
    }
  });

  console.log(`Imported ${deduped.length} opening book entries.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
