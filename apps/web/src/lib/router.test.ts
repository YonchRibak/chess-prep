/**
 * Flow F1: view ↔ hash round-trips, including the session-scope suffix.
 *
 * The hash is the deep-link contract: a scoped session must survive refresh
 * and be bookmarkable, and a malformed scope param must degrade to "absent"
 * (stored rules apply) rather than crash routing or invent a scope.
 */
import { describe, it, expect } from 'vitest';
import { hashToView, viewToHash } from './router.ts';
import type { View } from '../store/app.ts';

describe('viewToHash / hashToView round-trip', () => {
  const views: View[] = [
    { kind: 'list' },
    { kind: 'browse' },
    { kind: 'daily' },
    { kind: 'editor', repertoireId: 'abc' },
    { kind: 'drill-setup', repertoireId: 'abc' },
    { kind: 'drill-session', repertoireId: 'abc', mode: 'due' },
    { kind: 'drill-session', repertoireId: 'abc', mode: 'mistakes' },
    {
      kind: 'drill-session',
      repertoireId: 'abc',
      mode: 'due',
      scope: { kind: 'tag', value: 'vs-danny' },
    },
    { kind: 'walker-session', repertoireId: 'abc', seed: 'build' },
    { kind: 'walker-session', repertoireId: 'abc', seed: 'drill' },
    {
      kind: 'walker-session',
      repertoireId: 'abc',
      seed: 'drill',
      // Spaces AND an interior colon — the two characters the encoding must
      // survive, because book names use both.
      scope: { kind: 'openingName', value: 'Caro-Kann Defense: Advance Variation' },
    },
    {
      kind: 'walker-session',
      repertoireId: 'abc',
      seed: 'build',
      scope: { kind: 'openingName', value: 'French Defense' },
    },
    { kind: 'health-check', repertoireId: 'abc' },
    { kind: 'lines', repertoireId: 'abc', intent: 'train' },
    { kind: 'lines', repertoireId: 'abc', intent: 'grow' },
    { kind: 'prepare' },
    { kind: 'rashid-lab' },
    // Flow F2: guided flag, alone and together with a scope.
    { kind: 'walker-session', repertoireId: 'abc', seed: 'build', guided: true },
    {
      kind: 'walker-session',
      repertoireId: 'abc',
      seed: 'build',
      scope: { kind: 'openingName', value: 'Caro-Kann Defense' },
      guided: true,
    },
  ];

  for (const v of views) {
    it(`round-trips ${viewToHash(v)}`, () => {
      expect(hashToView(viewToHash(v))).toEqual(v);
    });
  }

  it("normalizes an 'all' scope to no scope at all", () => {
    const v: View = {
      kind: 'walker-session',
      repertoireId: 'abc',
      seed: 'drill',
      scope: { kind: 'all' },
    };
    const hash = viewToHash(v);
    expect(hash).toBe('#/walker/abc/drill');
    expect(hashToView(hash)).toEqual({
      kind: 'walker-session',
      repertoireId: 'abc',
      seed: 'drill',
    });
  });
});

describe('hashToView — malformed scope params fall back to absent', () => {
  const base = { kind: 'walker-session', repertoireId: 'abc', seed: 'drill' };

  it.each([
    ['unknown kind', '#/walker/abc/drill?scope=bogus:x'],
    ['empty value', '#/walker/abc/drill?scope=openingName:'],
    ['no separator / no value', '#/walker/abc/drill?scope=tag'],
    ['empty param', '#/walker/abc/drill?scope='],
    ['unrelated params only', '#/walker/abc/drill?foo=bar'],
  ])('%s → scope absent, view still resolves', (_label, hash) => {
    expect(hashToView(hash)).toEqual(base);
  });

  it('a malformed scope never turns a valid path into null', () => {
    expect(hashToView('#/walker/abc/drill?scope=%%%')).toEqual(base);
  });
});

describe('hashToView — plain paths unchanged', () => {
  it('rejects unknown walker seeds', () => {
    expect(hashToView('#/walker/abc/nope')).toBeNull();
  });

  it('accepts the mistakes drill mode', () => {
    expect(hashToView('#/drill/abc/mistakes')).toEqual({
      kind: 'drill-session',
      repertoireId: 'abc',
      mode: 'mistakes',
    });
  });

  it('root hash is the list', () => {
    expect(hashToView('#/')).toEqual({ kind: 'list' });
    expect(hashToView('')).toEqual({ kind: 'list' });
  });

  it("guided is only true for guided=1 — anything else parses as un-guided", () => {
    expect(hashToView('#/walker/abc/build?guided=1')).toEqual({
      kind: 'walker-session',
      repertoireId: 'abc',
      seed: 'build',
      guided: true,
    });
    expect(hashToView('#/walker/abc/build?guided=0')).toEqual({
      kind: 'walker-session',
      repertoireId: 'abc',
      seed: 'build',
    });
    expect(hashToView('#/walker/abc/build?guided=yes')).toEqual({
      kind: 'walker-session',
      repertoireId: 'abc',
      seed: 'build',
    });
  });
});
