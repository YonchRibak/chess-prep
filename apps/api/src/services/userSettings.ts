/**
 * Phase 8a: per-user daily-diet settings. Single source of truth for the
 * `new_cards_per_day` cap and the daily reset timestamp.
 *
 * Reads upsert-on-first-read: every user sees a settings row even if they
 * never wrote one, so the client doesn't need to handle "missing settings"
 * as a special case.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userSettings } from '../db/schema.js';

export interface UserSettings {
  userId: string;
  newCardsPerDay: number;
  dailyDietLastResetAt: string;
  updatedAt: string;
}

const DEFAULT_NEW_PER_DAY = 20;

export async function getUserSettings(userId: string): Promise<UserSettings> {
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (row) return toApi(row);

  // First read for this user — seed defaults so the client always sees a row.
  const [created] = await db
    .insert(userSettings)
    .values({ userId, newCardsPerDay: DEFAULT_NEW_PER_DAY })
    .onConflictDoNothing()
    .returning();
  if (created) return toApi(created);

  // Race: another request created it. Re-read.
  const reread = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!reread) throw new Error('Failed to bootstrap user settings');
  return toApi(reread);
}

export async function patchUserSettings(
  userId: string,
  patch: { newCardsPerDay?: unknown },
): Promise<UserSettings> {
  await getUserSettings(userId); // ensure row exists
  const update: Partial<{ newCardsPerDay: number; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (patch.newCardsPerDay !== undefined) {
    const n = Number(patch.newCardsPerDay);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      throw new Error('newCardsPerDay must be a number between 0 and 1000');
    }
    update.newCardsPerDay = Math.trunc(n);
  }
  const [row] = await db
    .update(userSettings)
    .set(update)
    .where(eq(userSettings.userId, userId))
    .returning();
  if (!row) throw new Error('User settings row missing after upsert');
  return toApi(row);
}

/**
 * Bump `dailyDietLastResetAt` to "now" — called when a daily-diet session
 * starts and the last reset is older than ~24h. The client uses this as the
 * boundary for "new cards shown today" counting.
 */
export async function maybeResetDailyDiet(userId: string, now = new Date()): Promise<UserSettings> {
  const current = await getUserSettings(userId);
  const last = new Date(current.dailyDietLastResetAt);
  const hoursSince = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  if (hoursSince < 20) return current; // ~daily, with a fudge factor for time-of-day drift
  const [row] = await db
    .update(userSettings)
    .set({ dailyDietLastResetAt: now, updatedAt: now })
    .where(eq(userSettings.userId, userId))
    .returning();
  if (!row) throw new Error('User settings row missing after upsert');
  return toApi(row);
}

function toApi(r: {
  userId: string;
  newCardsPerDay: number;
  dailyDietLastResetAt: Date;
  updatedAt: Date;
}): UserSettings {
  return {
    userId: r.userId,
    newCardsPerDay: r.newCardsPerDay,
    dailyDietLastResetAt: r.dailyDietLastResetAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
