import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { STARTING_FEN_KEY } from '@chess-prep/shared';
import { env } from './env.js';
import { explorerRoutes } from './routes/explorer.js';
import { openingRoutes } from './routes/openings.js';
import { repertoireRoutes } from './routes/repertoires.js';
import { srsRoutes } from './routes/srs.js';
import { userSettingsRoutes } from './routes/userSettings.js';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);

app.get('/health', (c) =>
  c.json({
    ok: true,
    startingFenKey: STARTING_FEN_KEY,
  }),
);

app.route('/explorer', explorerRoutes);
app.route('/openings', openingRoutes);
app.route('/repertoires', repertoireRoutes);
app.route('/srs', srsRoutes);
app.route('/settings', userSettingsRoutes);

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`chess-prep API listening on http://localhost:${info.port}`);
  },
);
