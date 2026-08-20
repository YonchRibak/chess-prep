import { Hono } from 'hono';
import { DEFAULT_USER_ID } from '@chess-prep/shared';
import { pullCards, pushCards } from '../services/srs.js';
import { HttpError } from '../services/repertoires.js';

export const srsRoutes = new Hono();

function userId(): string {
  return DEFAULT_USER_ID;
}

srsRoutes.get('/cards', async (c) => {
  const since = c.req.query('since');
  const repertoireId = c.req.query('repertoireId');
  try {
    const result = await pullCards(userId(), since, repertoireId);
    return c.json(result);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400 | 404 | 500);
    console.error(e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

srsRoutes.post('/cards/push', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.updates)) {
    return c.json({ error: 'expected { updates: [...] }' }, 400);
  }
  try {
    const result = await pushCards(userId(), body.updates);
    return c.json(result);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400 | 404 | 500);
    console.error(e);
    return c.json({ error: 'Internal error' }, 500);
  }
});
