/**
 * Flow F3: snapshot importer parsing — the fenKey parity guard, pure half.
 * A snapshot row keyed differently from what `fenKey()` produces would simply
 * never be hit by lookups, which is a silent failure; the importer must refuse
 * it loudly instead.
 */
import { describe, expect, it } from 'vitest';
import { parseSnapshotLine } from './import-explorer-snapshot.js';

const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

describe('parseSnapshotLine', () => {
  it('accepts a well-formed, normalized row', () => {
    const row = parseSnapshotLine(
      JSON.stringify({
        fenKey: START_KEY,
        total: 1000,
        moves: [{ san: 'e4', uci: 'e2e4', white: 300, draws: 100, black: 150 }],
      }),
      1,
    );
    expect(row.fenKey).toBe(START_KEY);
    expect(row.total).toBe(1000);
    expect(row.moves).toHaveLength(1);
  });

  it('rejects a full FEN stored where a 4-field fenKey belongs', () => {
    // fenKey() truncates to 4 fields; a row keyed by the 6-field FEN would
    // never match a lookup keyed by fenKey().
    const fullFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(() =>
      parseSnapshotLine(JSON.stringify({ fenKey: fullFen, total: 10, moves: [] }), 3),
    ).toThrow(/not normalized/);
  });

  it.each([
    ['broken JSON', '{nope'],
    ['missing fenKey', JSON.stringify({ total: 10, moves: [] })],
    ['negative total', JSON.stringify({ fenKey: START_KEY, total: -1, moves: [] })],
    [
      'negative counts',
      JSON.stringify({
        fenKey: START_KEY,
        total: 10,
        moves: [{ san: 'e4', uci: 'e2e4', white: -1, draws: 0, black: 0 }],
      }),
    ],
    ['not a position', JSON.stringify({ fenKey: 'garbage', total: 10, moves: [] })],
  ])('rejects %s with the line number', (_label, raw) => {
    expect(() => parseSnapshotLine(raw, 7)).toThrow(/snapshot\.jsonl:7/);
  });
});
