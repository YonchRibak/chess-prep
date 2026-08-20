import {
  createEmptyCard,
  FSRS,
  generatorParameters,
  Rating,
  State,
  type Card as FsrsCard,
  type Grade as FsrsGrade,
} from 'ts-fsrs';
import type { FsrsState, Grade, SrsCardDto } from '@chess-prep/shared';

const params = generatorParameters({ enable_fuzz: true });
const scheduler = new FSRS(params);

/** Convert wire DTO → ts-fsrs Card. */
function fromDto(dto: SrsCardDto): FsrsCard {
  return {
    due: new Date(dto.due),
    stability: dto.stability,
    difficulty: dto.difficulty,
    elapsed_days: dto.elapsedDays,
    scheduled_days: dto.scheduledDays,
    reps: dto.reps,
    lapses: dto.lapses,
    state: dto.state as unknown as State,
    last_review: dto.lastReview ? new Date(dto.lastReview) : undefined,
  };
}

function toDto(moveId: string, id: string, card: FsrsCard, now: Date): SrsCardDto {
  return {
    id,
    moveId,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as unknown as FsrsState,
    lastReview: card.last_review ? card.last_review.toISOString() : null,
    updatedAt: now.toISOString(),
  };
}

const GRADE_TO_RATING: Record<Grade, FsrsGrade> = {
  1: Rating.Again as FsrsGrade,
  2: Rating.Hard as FsrsGrade,
  3: Rating.Good as FsrsGrade,
  4: Rating.Easy as FsrsGrade,
};

/** Apply a grade to a card and return the new card DTO with `updatedAt = now`. */
export function applyGrade(dto: SrsCardDto, grade: Grade, now: Date = new Date()): SrsCardDto {
  const card = fromDto(dto);
  const result = scheduler.next(card, now, GRADE_TO_RATING[grade]);
  return toDto(dto.moveId, dto.id, result.card, now);
}

/** Build an empty card for a new move. Used when bootstrapping local cards. */
export function emptyCardFor(moveId: string, now: Date = new Date()): SrsCardDto {
  const card = createEmptyCard(now);
  return toDto(moveId, crypto.randomUUID(), card, now);
}

/** Preview intervals (days) for each grade — used for grade-button labels. */
export interface GradePreview {
  again: { dueIso: string; label: string };
  hard: { dueIso: string; label: string };
  good: { dueIso: string; label: string };
  easy: { dueIso: string; label: string };
}

export function previewGrades(dto: SrsCardDto, now: Date = new Date()): GradePreview {
  const card = fromDto(dto);
  const schedule = scheduler.repeat(card, now);
  const fmt = (next: { card: FsrsCard }) => {
    const due = next.card.due;
    const ms = due.getTime() - now.getTime();
    return { dueIso: due.toISOString(), label: formatInterval(ms) };
  };
  return {
    again: fmt(schedule[Rating.Again]),
    hard: fmt(schedule[Rating.Hard]),
    good: fmt(schedule[Rating.Good]),
    easy: fmt(schedule[Rating.Easy]),
  };
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return '<1m';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}
