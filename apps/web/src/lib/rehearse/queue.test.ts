import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { emptyCardFor } from '../srs/scheduler.ts';
import { buildRehearseQueue, withStubCards } from './queue.ts';
import { makeTestRepertoire, moveBySan } from './testTree.ts';

const NOW = new Date('2026-09-17T12:00:00Z');

function rep() {
  return makeTestRepertoire('white', [
    { sans: ['e4', 'c5', 'Nf3', 'd6', 'd4'], tags: ['Sicilian'], mainLine: true },
    { sans: ['e4', 'c5', 'Nc3', 'Nc6'], tags: ['Sicilian'] },
    { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], tags: ['Open'], mainLine: true },
  ]);
}

describe('buildRehearseQueue', () => {
  it('scopes to a chapter tag and contains only hero moves', () => {
    const q = buildRehearseQueue({ repertoire: rep(), cards: [], chapterTag: 'Open', rng: () => 0.5, now: NOW });
    expect(q.map((i) => i.move.san).sort()).toEqual(['Bb5', 'Nf3', 'e4']);
  });

  it('includes every hero move of the study when unscoped, dropped and shadow excluded', () => {
    const r = rep();
    moveBySan(r, 'Nc3', ['e4', 'c5']).isDropped = true;
    const q = buildRehearseQueue({ repertoire: r, cards: [], rng: () => 0.5, now: NOW });
    expect(q.map((i) => i.move.san).sort()).toEqual(['Bb5', 'Nf3', 'Nf3', 'd4', 'e4']);
  });

  it('never queues a hero move below a demoted alternate — no stub, no path, even with a stale card', () => {
    // 2.Nc3 is a demoted alternate; the study still contains 2...Nc6 3.d4
    // below it, and d4 is a hero move that is NOT itself dropped.
    const r = makeTestRepertoire('white', [
      { sans: ['e4', 'c5', 'Nf3', 'd6'], tags: ['Sic'], mainLine: true },
      { sans: ['e4', 'c5', 'Nc3', 'Nc6', 'd4'], tags: ['Sic'] },
    ]);
    moveBySan(r, 'Nc3', ['e4', 'c5']).isDropped = true;
    const d4 = moveBySan(r, 'd4', ['e4', 'c5', 'Nc3', 'Nc6']);
    expect(withStubCards(r, [], NOW).some((c) => c.moveId === d4.id)).toBe(false);
    const stale = emptyCardFor(d4.id, NOW);
    const q = buildRehearseQueue({ repertoire: r, cards: [stale], rng: () => 0.5, now: NOW });
    expect(q.map((i) => i.move.san).sort()).toEqual(['Nf3', 'e4']);
    for (const it of q) expect(it.pathSans.length).toBe(it.depth);
  });

  it('shuffles deterministically with the injected rng', () => {
    let seed = 1;
    const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const a = buildRehearseQueue({ repertoire: rep(), cards: [], rng, now: NOW }).map((i) => i.move.id);
    seed = 1;
    const b = buildRehearseQueue({ repertoire: rep(), cards: [], rng, now: NOW }).map((i) => i.move.id);
    expect(a).toEqual(b);
    expect(a.length).toBe(6);
  });

  it('gives an uncarded hero move a stub new card and keeps existing cards as they are', () => {
    const r = rep();
    const e4 = moveBySan(r, 'e4');
    const existing = { ...emptyCardFor(e4.id, NOW), reps: 3, state: 2 as const };
    const cards = withStubCards(r, [existing], NOW);
    expect(cards.find((c) => c.moveId === e4.id)).toBe(existing);
    const d4 = moveBySan(r, 'd4', ['e4', 'c5', 'Nf3', 'd6']);
    const stub = cards.find((c) => c.moveId === d4.id)!;
    expect(stub.state).toBe(0);
    expect(cards.some((c) => c.moveId === moveBySan(r, 'c5', ['e4']).id)).toBe(false);
  });

  it('replays each item’s path to its parent position', () => {
    const q = buildRehearseQueue({ repertoire: rep(), cards: [], rng: () => 0.1, now: NOW });
    for (const it of q) {
      const chess = new Chess();
      for (const san of it.pathSans) expect(chess.move(san)).toBeTruthy();
      expect(chess.fen()).toBe(it.parentFullFen);
    }
  });

  it('prefers the chapter’s own line into a transposition', () => {
    // Two chapters reach the same position by different move orders.
    const r = makeTestRepertoire('white', [
      { sans: ['Nf3', 'd5', 'd4', 'Nf6', 'c4'], tags: ['Reti'] },
      { sans: ['d4', 'd5', 'Nf3', 'Nf6', 'c4'], tags: ['QG'] },
    ]);
    const q = buildRehearseQueue({ repertoire: r, cards: [], chapterTag: 'QG', rng: () => 0.5, now: NOW });
    const c4 = q.find((i) => i.move.san === 'c4')!;
    expect(c4.pathSans).toEqual(['d4', 'd5', 'Nf3', 'Nf6']);
  });
});
