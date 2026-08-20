import { describe, it, expect } from 'vitest';
import { applyGrade, emptyCardFor, previewGrades } from './scheduler.ts';
import { Grade } from '@chess-prep/shared';

describe('FSRS scheduler wrapper', () => {
  it('an empty card is immediately due', () => {
    const card = emptyCardFor('move-1');
    expect(new Date(card.due).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(card.state).toBe(0); // new
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
  });

  it('grading "Good" pushes due into the future and increments reps', () => {
    const card = emptyCardFor('move-1');
    const now = new Date();
    const next = applyGrade(card, Grade.Good, now);
    expect(new Date(next.due).getTime()).toBeGreaterThan(now.getTime());
    expect(next.reps).toBe(1);
    expect(next.lastReview).not.toBeNull();
  });

  it('grading "Again" keeps the card near-due', () => {
    const card = emptyCardFor('move-1');
    const now = new Date();
    const next = applyGrade(card, Grade.Again, now);
    // "Again" on a new card → very short re-prompt (within an hour at most).
    const intervalMs = new Date(next.due).getTime() - now.getTime();
    expect(intervalMs).toBeLessThan(60 * 60 * 1000);
  });

  it('previewGrades returns 4 labels with increasing future-ness', () => {
    const card = emptyCardFor('move-1');
    const p = previewGrades(card);
    expect(p.again.label).toBeTruthy();
    expect(p.hard.label).toBeTruthy();
    expect(p.good.label).toBeTruthy();
    expect(p.easy.label).toBeTruthy();
    // Easy >= Good >= Hard >= Again (in terms of next due)
    const eo = new Date(p.easy.dueIso).getTime();
    const go = new Date(p.good.dueIso).getTime();
    const ho = new Date(p.hard.dueIso).getTime();
    const ao = new Date(p.again.dueIso).getTime();
    expect(eo).toBeGreaterThanOrEqual(go);
    expect(go).toBeGreaterThanOrEqual(ho);
    expect(ho).toBeGreaterThanOrEqual(ao);
  });

  it('grading bumps updatedAt to `now`', () => {
    const card = emptyCardFor('move-1');
    const now = new Date('2026-01-01T00:00:00Z');
    const next = applyGrade(card, Grade.Good, now);
    expect(next.updatedAt).toBe(now.toISOString());
  });
});
