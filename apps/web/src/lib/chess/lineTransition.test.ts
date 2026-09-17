import { describe, expect, it } from 'vitest';
import { planLineTransition } from './lineTransition.ts';

describe('planLineTransition', () => {
  it('is a no-op for identical lines', () => {
    expect(planLineTransition(['e4', 'e5'], ['e4', 'e5'])).toEqual({ kind: 'none', undo: 0, play: [] });
  });

  it('extends when the target continues the current line', () => {
    expect(planLineTransition(['e4', 'e5'], ['e4', 'e5', 'Nf3', 'Nc6'])).toEqual({
      kind: 'extend',
      undo: 0,
      play: ['Nf3', 'Nc6'],
    });
  });

  it('extends from an empty board (session start)', () => {
    expect(planLineTransition([], ['e4', 'c5'])).toMatchObject({ kind: 'extend', play: ['e4', 'c5'] });
  });

  it('rewinds to the common ancestor for a sibling variation', () => {
    expect(planLineTransition(['e4', 'e5', 'Nf3', 'Nc6'], ['e4', 'e5', 'Nf3', 'Nf6'])).toEqual({
      kind: 'rewind',
      undo: 1,
      play: ['Nf6'],
    });
  });

  it('treats a line sharing only the root as a new line', () => {
    expect(planLineTransition(['e4', 'c5'], ['d4', 'd5'])).toEqual({
      kind: 'new-line',
      undo: 2,
      play: ['d4', 'd5'],
    });
  });

  it('turns a long rewind into a new line even with a shared prefix', () => {
    const cur = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];
    const tgt = ['e4', 'c5', 'Nc3', 'Nc6', 'g3', 'g6', 'Bg2', 'Bg7', 'd3', 'd6'];
    expect(planLineTransition(cur, tgt).kind).toBe('new-line');
    expect(planLineTransition(cur, tgt, { maxRewind: 20 }).kind).toBe('rewind');
  });

  it('rewinds to the root when the target is the root itself', () => {
    expect(planLineTransition(['e4'], [])).toEqual({ kind: 'rewind', undo: 1, play: [] });
  });
});
