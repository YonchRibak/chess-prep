import { Hono } from 'hono';
import { DEFAULT_USER_ID } from '@chess-prep/shared';
import {
  HttpError,
  addMove,
  appendLine,
  appendRefutation,
  createRepertoire,
  deleteMove,
  deleteRepertoire,
  exportPgn,
  getRepertoire,
  importPgn,
  listRepertoires,
  patchDrillRules,
  patchMove,
  patchRepertoire,
} from '../services/repertoires.js';

export const repertoireRoutes = new Hono();

// Centralized error handler that maps HttpError → JSON response.
async function safeJson<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, status: e.status, error: e.message };
    console.error(e);
    return { ok: false, status: 500, error: 'Internal error' };
  }
}

function userId(): string {
  // Single-user mode: hardcoded. Will become auth-derived later.
  return DEFAULT_USER_ID;
}

repertoireRoutes.get('/', async (c) => {
  const result = await safeJson(() => listRepertoires(userId()));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data);
});

repertoireRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await safeJson(() => createRepertoire(userId(), body));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data, 201);
});

repertoireRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const result = await safeJson(() => getRepertoire(userId(), id));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data);
});

repertoireRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const result = await safeJson(() => patchRepertoire(userId(), id, body));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data);
});

repertoireRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const result = await safeJson(() => deleteRepertoire(userId(), id));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.body(null, 204);
});

repertoireRoutes.post('/:id/moves/batch', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const result = await safeJson(() => appendLine(userId(), id, body));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data, 201);
});

// Phase 9d: store a refutation shadow line. Separate from /moves/batch on
// purpose — the two write the same table but mean opposite things, and a
// boolean on the prep endpoint would make "never carded" one typo away.
repertoireRoutes.post('/:id/refutations', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const result = await safeJson(() => appendRefutation(userId(), id, body));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data, 201);
});

repertoireRoutes.post('/:id/moves', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const result = await safeJson(() => addMove(userId(), id, body));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data, 201);
});

repertoireRoutes.patch('/:id/moves/:moveId', async (c) => {
  const id = c.req.param('id');
  const moveId = c.req.param('moveId');
  const body = await c.req.json().catch(() => ({}));
  const result = await safeJson(() => patchMove(userId(), id, moveId, body));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.body(null, 204);
});

repertoireRoutes.delete('/:id/moves/:moveId', async (c) => {
  const id = c.req.param('id');
  const moveId = c.req.param('moveId');
  const result = await safeJson(() => deleteMove(userId(), id, moveId));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.body(null, 204);
});

repertoireRoutes.post('/import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await safeJson(() => importPgn(userId(), body));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data, 201);
});

repertoireRoutes.patch('/:id/drill-rules', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const result = await safeJson(() => patchDrillRules(userId(), id, body));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  return c.json(result.data);
});

repertoireRoutes.get('/:id/export', async (c) => {
  const id = c.req.param('id');
  const result = await safeJson(() => exportPgn(userId(), id));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 500);
  c.header('Content-Type', 'application/x-chess-pgn; charset=utf-8');
  return c.body(result.data);
});
