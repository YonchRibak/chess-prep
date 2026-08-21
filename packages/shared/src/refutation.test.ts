/**
 * Phase 9d — the pure half of refutation shadow lines.
 *
 * What is worth testing here is the truncation behavior: an engine PV is long
 * and can go stale, and both failure modes (storing 30 plies of "punishment",
 * or throwing mid-line and storing nothing) would be silent from the UI's side.
 */
import { describe, expect, it } from 'vitest';
import { STARTING_FEN } from './fen.js';
import { fenAfterSan, pvToRefutationSans, MAX_REFUTATION_PLIES } from './refutation.js';

describe('fenAfterSan', () => {
  it('returns the position the move reaches', () => {
    const after = fenAfterSan(STARTING_FEN, 'e4');
    expect(after).not.toBeNull();
    expect(after!.split(' ')[1]).toBe('b'); // black to move
  });

  it('returns null for an illegal move rather than throwing', () => {
    expect(fenAfterSan(STARTING_FEN, 'e5')).toBeNull();
    expect(fenAfterSan('not a fen', 'e4')).toBeNull();
  });
});

describe('pvToRefutationSans', () => {
  it('converts UCI to SAN in order', () => {
    expect(pvToRefutationSans(STARTING_FEN, ['e2e4', 'e7e5', 'g1f3'])).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('stops at the ply cap', () => {
    const pv = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4'];
    expect(pvToRefutationSans(STARTING_FEN, pv, 3)).toEqual(['e4', 'e5', 'Nf3']);
    expect(pvToRefutationSans(STARTING_FEN, pv).length).toBe(
      Math.min(pv.length, MAX_REFUTATION_PLIES),
    );
  });

  it('truncates at the first unplayable move instead of throwing', () => {
    // A stale PV: the third move is illegal in the position it lands in.
    expect(pvToRefutationSans(STARTING_FEN, ['e2e4', 'e7e5', 'e4e5'])).toEqual(['e4', 'e5']);
  });

  it('returns [] when nothing is playable, so callers can treat it as "no refutation"', () => {
    expect(pvToRefutationSans(STARTING_FEN, ['a1a8'])).toEqual([]);
    expect(pvToRefutationSans('garbage', ['e2e4'])).toEqual([]);
  });

  it('handles promotions', () => {
    const fen = '8/P6k/8/8/8/8/8/K7 w - - 0 1';
    expect(pvToRefutationSans(fen, ['a7a8q'])).toEqual(['a8=Q']);
  });
});
