import { Hono } from 'hono';
import { DEFAULT_USER_ID } from '@chess-prep/shared';
import { getUserSettings, patchUserSettings } from '../services/userSettings.js';

export const userSettingsRoutes = new Hono();

function userId(): string {
  return DEFAULT_USER_ID;
}

userSettingsRoutes.get('/', async (c) => {
  try {
    const s = await getUserSettings(userId());
    return c.json(s);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

userSettingsRoutes.patch('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const s = await patchUserSettings(userId(), body);
    return c.json(s);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
