import { describe, expect, it } from 'vitest';
import { emptyCardFor } from '../srs/scheduler.ts';
import { computeChapterStats } from './chapterStats.ts';
import { makeTestRepertoire, moveBySan } from './testTree.ts';

const NOW = new Date('2026-09-17T12:00:00Z');

describe('computeChapterStats', () => {
  it('counts hero moves per tag, with due/new and mastered', () => {
    const rep = makeTestRepertoire('white', [
      { sans: ['e4', 'c5', 'Nf3'], tags: ['Sicilian'] },
      { sans: ['e4', 'e5', 'Nf3'], tags: ['Open'] },
    ]);
    const e4 = moveBySan(rep, 'e4');
    const nf3Open = moveBySan(rep, 'Nf3', ['e4', 'e5']);
    const cards = [
      // e4: review state, due next week → mastered.
      { ...emptyCardFor(e4.id, NOW), state: 2 as const, due: '2026-09-24T00:00:00Z' },
      // Nf3 (Open): review state but overdue → due, not mastered.
      { ...emptyCardFor(nf3Open.id, NOW), state: 2 as const, due: '2026-09-10T00:00:00Z' },
      // Nf3 (Sicilian): no card → due (new).
    ];
    const stats = computeChapterStats(rep, cards, NOW);
    expect(stats.get('Sicilian')).toEqual({ cards: 2, due: 1, mastered: 1 });
    expect(stats.get('Open')).toEqual({ cards: 2, due: 1, mastered: 1 });
  });

  it('ignores dropped moves and opponent moves', () => {
    const rep = makeTestRepertoire('black', [{ sans: ['e4', 'c5', 'Nf3', 'd6'], tags: ['Sic'] }]);
    moveBySan(rep, 'd6', ['e4', 'c5', 'Nf3']).isDropped = true;
    expect(computeChapterStats(rep, [], NOW).get('Sic')).toEqual({ cards: 1, due: 1, mastered: 0 });
  });
});
