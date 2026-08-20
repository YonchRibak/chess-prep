/**
 * Integration test: importer + lookup parity.
 *
 * Asserts that for a handful of known PGN sequences, the fenKey computed by
 * `chess.js + fenKey()` on the client side hits a row that the importer
 * already loaded into `opening_book_entries` with the expected name. This
 * catches any whitespace/encoding drift between the two paths.
 *
 * Skips if no DATABASE_URL is set (so plain unit-test runs don't fail).
 */
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { fenKey } from '@chess-prep/shared';

const ENABLED = Boolean(process.env.DATABASE_URL);

function fenKeyAfterPgn(pgn: string): string {
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: false });
  return fenKey(chess.fen());
}

const cases: Array<{ pgn: string; expectName: string; expectVariation?: string | null; expectEco?: string }> = [
  {
    pgn: '1. e4 c6',
    expectName: 'Caro-Kann Defense',
    expectVariation: null,
    expectEco: 'B10',
  },
  {
    pgn: '1. e4 c6 2. d4 d5 3. e5',
    expectName: 'Caro-Kann Defense',
    expectVariation: 'Advance Variation',
    expectEco: 'B12',
  },
  {
    pgn: '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f3',
    // The lichess data labels the Sämisch at this position under various
    // names; the assert is "exists in book under that fenKey", not name-exact.
    expectName: 'King',
  },
];

describe('importer ↔ lookup parity (integration)', () => {
  if (!ENABLED) {
    it.skip('DATABASE_URL not set — skipping integration test', () => {});
    return;
  }

  it('each known PGN normalizes to a fenKey that the importer loaded', async () => {
    // Lazy-import so the unit-test run never touches the DB client.
    const { db } = await import('../db/client.js');
    const { openingBookEntries } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');

    for (const c of cases) {
      const key = fenKeyAfterPgn(c.pgn);
      const row = await db.query.openingBookEntries.findFirst({
        where: eq(openingBookEntries.fenKey, key),
      });
      expect(row, `fenKey ${key} for "${c.pgn}" should be in the book`).toBeTruthy();
      if (c.expectEco && row) expect(row.eco).toBe(c.expectEco);
      if (row) expect(row.name).toContain(c.expectName);
    }
  });
});
