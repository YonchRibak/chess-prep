/**
 * Flow F3: import the vendored explorer snapshot into
 * `explorer_snapshot_entries` — drop-and-reload in one transaction, exactly
 * like the ECO book importer. Safe to run any number of times.
 *
 *   pnpm --filter @chess-prep/api db:import-explorer-snapshot
 *
 * Reads apps/api/data/explorer-snapshot/{snapshot.jsonl, meta.json} (produced
 * by `snapshot:build` on a machine where the lichess explorer answers).
 * Every row's fenKey is re-normalized through `fenKey()` — the same parity
 * guard the book importer relies on: a snapshot keyed differently from the
 * rest of the app would silently never be hit.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { fenKey as makeFenKey, type ExplorerMoveStat } from '@chess-prep/shared';
import { db } from '../db/client.js';
import { explorerSnapshotEntries } from '../db/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'explorer-snapshot');

export interface SnapshotRow {
  fenKey: string;
  total: number;
  moves: ExplorerMoveStat[];
}

/**
 * Parse + validate one JSONL line. Exported for tests. Throws with the line
 * number on anything malformed — a bad vendored file should fail the import
 * loudly, not load a partial dataset.
 */
export function parseSnapshotLine(raw: string, lineNo: number): SnapshotRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`snapshot.jsonl:${lineNo}: not valid JSON`);
  }
  const { fenKey, total, moves } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof fenKey !== 'string' || !fenKey.trim()) {
    throw new Error(`snapshot.jsonl:${lineNo}: missing fenKey`);
  }
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
    throw new Error(`snapshot.jsonl:${lineNo}: bad total`);
  }
  if (!Array.isArray(moves)) throw new Error(`snapshot.jsonl:${lineNo}: bad moves`);
  const stats: ExplorerMoveStat[] = [];
  for (const m of moves) {
    const { san, uci, white, draws, black } = (m ?? {}) as Record<string, unknown>;
    if (typeof san !== 'string' || typeof uci !== 'string') {
      throw new Error(`snapshot.jsonl:${lineNo}: bad move row`);
    }
    if (![white, draws, black].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      throw new Error(`snapshot.jsonl:${lineNo}: bad counts`);
    }
    stats.push({ san, uci, white: white as number, draws: draws as number, black: black as number });
  }
  // Parity guard: the stored key must be exactly what fenKey() produces for
  // this position, or lookups from the rest of the app will never hit it.
  let normalized: string;
  try {
    normalized = makeFenKey(fenKey);
  } catch {
    throw new Error(`snapshot.jsonl:${lineNo}: not a fenKey: "${fenKey}"`);
  }
  if (normalized !== fenKey) {
    throw new Error(
      `snapshot.jsonl:${lineNo}: fenKey not normalized ("${fenKey}" → "${normalized}")`,
    );
  }
  try {
    new Chess(`${fenKey} 0 1`);
  } catch {
    throw new Error(`snapshot.jsonl:${lineNo}: not a valid position: "${fenKey}"`);
  }
  return { fenKey, total, moves: stats };
}

async function main() {
  const meta = JSON.parse(await readFile(resolve(DATA_DIR, 'meta.json'), 'utf8')) as {
    generatedAt: string;
    source: string;
  };
  const text = await readFile(resolve(DATA_DIR, 'snapshot.jsonl'), 'utf8');
  const rows: SnapshotRow[] = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    if (!raw.trim()) continue;
    rows.push(parseSnapshotLine(raw, lineNo));
  }
  console.log(`Parsed ${rows.length} snapshot rows (${meta.source})`);

  const generatedAt = new Date(meta.generatedAt);
  await db.transaction(async (tx) => {
    await tx.execute(/* sql */ `TRUNCATE TABLE explorer_snapshot_entries`);
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await tx.insert(explorerSnapshotEntries).values(
        chunk.map((r) => ({
          fenKey: r.fenKey,
          source: meta.source,
          total: r.total,
          moves: r.moves,
          generatedAt,
        })),
      );
    }
  });
  console.log(`Imported ${rows.length} snapshot entries.`);
}

// Only run as a script — tests import `parseSnapshotLine` without a DB.
const invokedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
