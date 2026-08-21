import { describe, expect, it } from 'vitest';
import type { RankedReply } from '@chess-prep/shared';
import { selectAutoExpandSans } from './autoExpand.ts';
import type { RepertoireMove } from '../../api/client.ts';

function reply(san: string, share = 0.3): RankedReply {
  return { san, uci: `uci-${san}`, share, games: 100, score: 0.5 };
}

function move(san: string, isDropped = false): RepertoireMove {
  return {
    id: `m-${san}`,
    parentPositionId: 'p0',
    childPositionId: `c-${san}`,
    parentFenKey: '',
    childFenKey: '',
    san,
    uci: '',
    comment: null,
    annotation: null,
    isMainLine: false,
    priority: 0,
    isDropped,
    lineTags: [],
    isRefutation: false,
  };
}

describe('selectAutoExpandSans', () => {
  it('adds the ranked replies at an untouched position', () => {
    const out = selectAutoExpandSans([reply('c5'), reply('e5'), reply('e6')], [], { source: 'explorer' });
    expect(out.sans).toEqual(['c5', 'e5', 'e6']);
    expect(out.skipped).toBe('none');
  });

  it('NEVER re-adds a dropped branch', () => {
    // The load-bearing test. A position whose only reply was dropped is
    // indistinguishable from an untouched one by the walker's "no live
    // children" rule, so without this filter auto-expansion would re-add
    // exactly what the user rejected — every session, silently.
    const out = selectAutoExpandSans([reply('c5'), reply('e5')], [move('c5', true)], {
      source: 'explorer',
    });
    expect(out.sans).toEqual(['e5']);
  });

  it('reports all-dropped rather than adding anything, when every candidate was rejected', () => {
    const out = selectAutoExpandSans(
      [reply('c5'), reply('e5')],
      [move('c5', true), move('e5', true)],
      { source: 'explorer' },
    );
    expect(out.sans).toEqual([]);
    expect(out.skipped).toBe('all-dropped');
  });

  it('skips moves already saved, and says so distinctly from a drop', () => {
    const out = selectAutoExpandSans([reply('c5')], [move('c5')], { source: 'explorer' });
    expect(out.sans).toEqual([]);
    expect(out.skipped).toBe('all-known');
  });

  it('caps how many replies one position may gain', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((s) => reply(s));
    expect(selectAutoExpandSans(many, [], { source: 'explorer' }).sans).toHaveLength(3);
    expect(selectAutoExpandSans(many, [], { source: 'explorer', max: 1 }).sans).toEqual(['a']);
  });

  it('refuses to write from book-ordered candidates, which are alphabetical not popular', () => {
    // After 1.e4 the book's first three continuations are a5, a6, b6. Showing
    // that list is fine; silently prepping it is not.
    const out = selectAutoExpandSans([reply('a5'), reply('a6'), reply('b6')], [], {
      source: 'book',
    });
    expect(out.sans).toEqual([]);
    expect(out.skipped).toBe('no-frequency-data');
  });

  it('reports no-candidates when the explorer is cold and the book is dry', () => {
    const out = selectAutoExpandSans([], [], { source: 'explorer' });
    expect(out.sans).toEqual([]);
    expect(out.skipped).toBe('no-candidates');
  });

  it('keeps candidate order — the caller already ranked by frequency', () => {
    const out = selectAutoExpandSans([reply('e5', 0.6), reply('c5', 0.3)], [], { source: 'explorer' });
    expect(out.sans).toEqual(['e5', 'c5']);
  });
});
