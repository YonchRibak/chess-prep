import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  DATABASE_URL: required('DATABASE_URL'),
  PORT: Number(process.env.PORT ?? 8787),
  CORS_ORIGIN: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Optional lichess personal access token (lichess.org/account/oauth/token),
   * sent as `Authorization: Bearer …` on opening-explorer requests. The
   * explorer host started answering 401 to anonymous requests (observed
   * 2026-08 from every network we tried); with no token set, requests still
   * go out anonymously and the service degrades to cache/snapshot as before.
   */
  LICHESS_TOKEN: process.env.LICHESS_TOKEN?.trim() || undefined,
};
