import { Hono } from 'hono';
import { HttpError } from '../services/repertoires.js';
import {
  EXPLORER_SOURCE,
  explorerBackoffRemainingMs,
  getExplorerEntry,
  validateExplorerFenKey,
} from '../services/explorer.js';

export const explorerRoutes = new Hono();

/**
 * Phase 9b. Read-through cache: serves a fresh row, refetches a stale one, and
 * falls back to whatever is stored when lichess is unreachable.
 *
 * A cache miss with no network is **`200` with `entry: null`**, not an error —
 * callers are expected to fall back to book continuations, and a 5xx here would
 * turn a degraded-but-fine situation into a broken build prompt.
 */
explorerRoutes.get('/:fenKey', async (c) => {
  try {
    const fenKey = validateExplorerFenKey(c.req.param('fenKey'));
    const cachedOnly = c.req.query('cachedOnly') === '1';
    const entry = await getExplorerEntry(fenKey, { cachedOnly });
    return c.json({
      entry,
      source: EXPLORER_SOURCE,
      backoffMs: explorerBackoffRemainingMs(),
    });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400 | 404 | 500);
    console.error(e);
    return c.json({ error: 'Internal error' }, 500);
  }
});
