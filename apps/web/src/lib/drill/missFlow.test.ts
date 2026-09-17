import { describe, expect, it } from 'vitest';
import { nextMissStage, runMissReveal } from './missFlow.ts';

describe('missFlow', () => {
  it('pauses on a note only when the correct move carries one', () => {
    expect(nextMissStage({ comment: ' Keep the tension. ' })).toBe('note');
    expect(nextMissStage({ comment: '   ' })).toBe('retry');
    expect(nextMissStage({ comment: null })).toBe('retry');
  });

  it('plays the correct move, waits, then takes it back', async () => {
    const calls: string[] = [];
    const rules = {
      playSan: (san: string) => (calls.push(`play:${san}`), san),
      undo: () => calls.push('undo'),
    };
    await runMissReveal({ rules, correctSan: 'Nf3', revealMs: 1, signal: new AbortController().signal });
    expect(calls).toEqual(['play:Nf3', 'undo']);
  });

  it('does not take back a move it could not play', async () => {
    const calls: string[] = [];
    const rules = { playSan: () => null, undo: () => calls.push('undo') };
    await runMissReveal({ rules, correctSan: 'Zz9', revealMs: 1, signal: new AbortController().signal });
    expect(calls).toEqual([]);
  });

  it('stops when aborted mid-reveal, leaving the board untouched', async () => {
    const calls: string[] = [];
    const rules = { playSan: (san: string) => (calls.push(`play:${san}`), san), undo: () => calls.push('undo') };
    const ctl = new AbortController();
    const p = runMissReveal({ rules, correctSan: 'Nf3', revealMs: 1000, signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['play:Nf3']);
  });
});
