import { Hono } from 'hono';
import { HttpError } from '../services/repertoires.js';
import {
  getBookContinuations,
  getOpeningByFenKey,
  identifyDeepestOpeningFromPath,
  listOpenings,
  validateAndNormalizeFenKey,
} from '../services/openings.js';

export const openingRoutes = new Hono();

async function safe<T>(
  c: { json: (body: unknown, status?: 200 | 400 | 404 | 500) => Response },
  fn: () => Promise<T>,
): Promise<Response> {
  try {
    const data = await fn();
    return c.json(data as object);
  } catch (e) {
    if (e instanceof HttpError) {
      return c.json({ error: e.message }, e.status as 400 | 404 | 500);
    }
    console.error(e);
    return c.json({ error: 'Internal error' }, 500);
  }
}

openingRoutes.get('/', (c) =>
  safe(c, () =>
    listOpenings({
      q: c.req.query('q'),
      eco: c.req.query('eco'),
      limit: c.req.query('limit'),
    }),
  ),
);

openingRoutes.get('/by-fen/:fenKey', async (c) => {
  // Encode slashes as %2F on the client; Hono decodes before handing us the
  // param. The fenKey contains spaces and slashes, both of which round-trip
  // through URL encoding cleanly.
  const param = c.req.param('fenKey');
  try {
    const normalized = validateAndNormalizeFenKey(param);
    const row = await getOpeningByFenKey(normalized);
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(row);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400 | 404 | 500);
    console.error(e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

openingRoutes.get('/continuations/:fenKey', async (c) => {
  const param = c.req.param('fenKey');
  try {
    const normalized = validateAndNormalizeFenKey(param);
    const rows = await getBookContinuations(normalized);
    return c.json(rows);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400 | 404 | 500);
    console.error(e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

openingRoutes.post('/identify-deepest', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.fenKeys)) {
    return c.json({ error: 'expected { fenKeys: string[] }' }, 400);
  }
  try {
    const path: string[] = [];
    for (const k of body.fenKeys) {
      if (typeof k !== 'string') {
        return c.json({ error: 'fenKeys must be an array of strings' }, 400);
      }
      path.push(validateAndNormalizeFenKey(k));
    }
    const hit = await identifyDeepestOpeningFromPath(path);
    return c.json({ opening: hit });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400 | 404 | 500);
    console.error(e);
    return c.json({ error: 'Internal error' }, 500);
  }
});
