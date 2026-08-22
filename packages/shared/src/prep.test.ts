/**
 * Flow F2: prep-target validation and color inference for the Prepare wizard.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OPPONENT_REPLY_POLICY,
} from './explorer.js';
import {
  inferPrepColor,
  parsePrepTarget,
  PREP_TARGET_PRESETS,
} from './prep.js';

describe('PREP_TARGET_PRESETS', () => {
  it("default preset reuses the reply policy's existing minShare", () => {
    // The presets parameterize selectOpponentReplies; if the policy default
    // moves, the preset must move with it or "Standard" silently diverges
    // from what un-guided building does.
    expect(PREP_TARGET_PRESETS.default.minShare).toBe(DEFAULT_OPPONENT_REPLY_POLICY.minShare);
  });
});

describe('parsePrepTarget', () => {
  it('passes a valid target through', () => {
    expect(parsePrepTarget({ minShare: 0.05, maxDepthPlies: 12 })).toEqual({
      minShare: 0.05,
      maxDepthPlies: 12,
    });
  });

  it('returns undefined for absent input', () => {
    expect(parsePrepTarget(undefined)).toBeUndefined();
    expect(parsePrepTarget(null)).toBeUndefined();
  });

  it.each([
    ['non-object', 42],
    ['zero minShare', { minShare: 0, maxDepthPlies: 12 }],
    ['minShare above 1', { minShare: 1.5, maxDepthPlies: 12 }],
    ['non-numeric minShare', { minShare: '0.05', maxDepthPlies: 12 }],
    ['fractional depth', { minShare: 0.05, maxDepthPlies: 6.5 }],
    ['zero depth', { minShare: 0.05, maxDepthPlies: 0 }],
    ['absurd depth', { minShare: 0.05, maxDepthPlies: 100 }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parsePrepTarget(raw)).toThrow();
  });
});

describe('inferPrepColor', () => {
  it('an opening ending on a Black move belongs to Black → user prepares as White', () => {
    expect(inferPrepColor('1. e4 c6')).toBe('white'); // Caro-Kann
    expect(inferPrepColor('1. e4 c5')).toBe('white'); // Sicilian
  });

  it('an opening ending on a White move belongs to White → user prepares as Black', () => {
    expect(inferPrepColor('1. e4')).toBe('black'); // King's Pawn Game
    expect(inferPrepColor('1. e4 e6 2. d4 d5 3. e5')).toBe('black'); // French: Advance
  });

  it('ignores move numbers and results in the movetext', () => {
    expect(inferPrepColor('1. e4 e6 2. d4 d5 3. Nc3 Bb4 *')).toBe('white'); // Winawer
  });
});
