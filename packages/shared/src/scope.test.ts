import { describe, expect, it } from 'vitest';
import {
  fullOpeningName,
  inheritLineTags,
  matchesLineScope,
  matchesOpeningName,
  parseLineScope,
} from './scope.js';
import { DEFAULT_DRILL_RULES, mergeDrillRules } from './drill.js';
import type { OpeningId } from './openings.js';

const caro: OpeningId = { eco: 'B12', name: 'Caro-Kann Defense', variation: null };
const caroAdvance: OpeningId = {
  eco: 'B12',
  name: 'Caro-Kann Defense',
  variation: 'Advance Variation',
};
const caroAdvanceShort: OpeningId = {
  eco: 'B12',
  name: 'Caro-Kann Defense',
  variation: 'Advance Variation, Short Variation',
};

describe('fullOpeningName', () => {
  it('rejoins name and variation the way the book spells it', () => {
    expect(fullOpeningName(caroAdvance)).toBe('Caro-Kann Defense: Advance Variation');
    expect(fullOpeningName(caro)).toBe('Caro-Kann Defense');
    expect(fullOpeningName(null)).toBeNull();
  });
});

describe('matchesOpeningName', () => {
  it('matches the scope itself and everything under it', () => {
    expect(matchesOpeningName(caro, 'Caro-Kann Defense')).toBe(true);
    expect(matchesOpeningName(caroAdvance, 'Caro-Kann Defense')).toBe(true);
    expect(matchesOpeningName(caroAdvanceShort, 'Caro-Kann Defense: Advance Variation')).toBe(
      true,
    );
  });

  it('is case- and whitespace-insensitive', () => {
    expect(matchesOpeningName(caroAdvance, '  caro-kann defense  ')).toBe(true);
  });

  it('does not match a sibling line that is narrower than the scope', () => {
    expect(matchesOpeningName(caro, 'Caro-Kann Defense: Advance Variation')).toBe(false);
  });

  it('only breaks at a name boundary, so a word-prefix is not a match', () => {
    const decoy: OpeningId = { eco: 'B00', name: 'Caro-Kann Defense Deferred', variation: null };
    expect(matchesOpeningName(decoy, 'Caro-Kann Defense')).toBe(false);
  });

  it('never matches an unnamed position', () => {
    expect(matchesOpeningName(null, 'Caro-Kann Defense')).toBe(false);
  });
});

describe('matchesLineScope', () => {
  const ctx = { deepestOpening: caroAdvance, lineTags: ['vs-danny'] };

  it("kind 'all' matches everything", () => {
    expect(matchesLineScope({ kind: 'all' }, ctx)).toBe(true);
    expect(matchesLineScope(undefined, { deepestOpening: null, lineTags: [] })).toBe(true);
  });

  it('matches tags case-insensitively', () => {
    expect(matchesLineScope({ kind: 'tag', value: 'VS-Danny' }, ctx)).toBe(true);
    expect(matchesLineScope({ kind: 'tag', value: 'blitz-only' }, ctx)).toBe(false);
  });

  it('a value-less scope matches everything rather than emptying the session', () => {
    // A malformed scope should degrade to "no filter", not to "no cards" —
    // an empty session looks like a finished one.
    expect(matchesLineScope({ kind: 'tag', value: '  ' }, ctx)).toBe(true);
    expect(matchesLineScope({ kind: 'openingName' }, ctx)).toBe(true);
  });
});

describe('inheritLineTags', () => {
  it('copies the parent edge tags when the caller supplies none', () => {
    expect(inheritLineTags(['vs-danny'])).toEqual(['vs-danny']);
  });

  it('replaces (not merges) when the caller supplies tags, re-rooting the subtree', () => {
    expect(inheritLineTags(['vs-danny'], ['blitz-only'])).toEqual(['blitz-only']);
  });

  it('an explicit empty array clears inheritance', () => {
    expect(inheritLineTags(['vs-danny'], [])).toEqual([]);
  });

  it('trims and de-duplicates case-insensitively, keeping first spelling', () => {
    expect(inheritLineTags(null, [' Vs-Danny ', 'vs-danny', ''])).toEqual(['Vs-Danny']);
  });
});

describe('parseLineScope', () => {
  it('passes through a valid scope, trimmed', () => {
    expect(parseLineScope({ kind: 'tag', value: ' blitz ' })).toEqual({
      kind: 'tag',
      value: 'blitz',
    });
    expect(parseLineScope({ kind: 'all' })).toEqual({ kind: 'all' });
  });

  it('returns undefined for absent input', () => {
    expect(parseLineScope(undefined)).toBeUndefined();
    expect(parseLineScope(null)).toBeUndefined();
  });

  it('rejects an unknown kind or a missing value', () => {
    expect(() => parseLineScope({ kind: 'line' })).toThrow();
    expect(() => parseLineScope({ kind: 'openingName' })).toThrow();
    expect(() => parseLineScope('all')).toThrow();
  });
});

describe('mergeDrillRules', () => {
  it("defaults scope to 'all' so existing repertoires drill unfiltered", () => {
    expect(mergeDrillRules(undefined).scope).toEqual({ kind: 'all' });
    expect(DEFAULT_DRILL_RULES.scope).toEqual({ kind: 'all' });
  });

  it('lets a stored partial rule set override just the scope', () => {
    const merged = mergeDrillRules({ scope: { kind: 'tag', value: 'blitz' } });
    expect(merged.scope).toEqual({ kind: 'tag', value: 'blitz' });
    expect(merged.branching).toBe('all');
  });
});
