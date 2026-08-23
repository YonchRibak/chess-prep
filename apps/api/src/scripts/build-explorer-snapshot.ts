/**
 * Flow F3: build the bundled explorer snapshot — a one-shot BFS over the
 * common opening positions, fetching real frequency data from the lichess
 * explorer and writing vendored JSONL under apps/api/data/explorer-snapshot/.
 *
 * Run MANUALLY, from a machine where explorer.lichess.ovh actually answers
 * (the primary dev box gets 401 from a fronting nginx — that unreachability is
 * the reason this snapshot exists). The output is committed like the ECO TSVs
 * and imported with `db:import-explorer-snapshot`. Regenerate ~yearly; opening
 * statistics move over months, not minutes.
 *
 *   pnpm --filter @chess-prep/api snapshot:build [-- --depth 12 --min-share 0.02]
 *
 * Expansion rule: from the starting position, descend into any move played in
 * at least `--min-share` of that position's games, to `--depth` plies. Tune
 * the numbers from the actual output size before vendoring — they are a
 * starting point, not a contract.
 *
 * Rate-limit manners mirror the cache service: one request at a time, a
 * polite delay between requests, and a 429 pauses everything for 60s.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { fenKey as makeFenKey, moveShare, STARTING_FEN } from '@chess-prep/shared';
import { env } from '../env.js';
import { parseExplorerResponse } from '../services/explorer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', '..', 'data', 'explorer-snapshot');

// Same dataset + filters as the live cache — a snapshot of a DIFFERENT rating
// band would silently disagree with live rows for the same position.
const SPEEDS = ['blitz', 'rapid', 'classical'] as const;
const MIN_RATING = 1600;
const EXPLORER_URL = 'https://explorer.lichess.org/lichess';
const USER_AGENT = 'chess-prep/0.1 (personal opening-prep tool; snapshot build)';
const REQUEST_GAP_MS = 800;
const BACKOFF_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

interface Args {
  depth: number;
  minShare: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    depth: Number(get('--depth') ?? 12),
    minShare: Number(get('--min-share') ?? 0.02),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchEntry(fenKeyStr: string) {
  const params = new URLSearchParams({
    variant: 'standard',
    fen: `${fenKeyStr} 0 1`,
    speeds: SPEEDS.join(','),
    ratings: String(MIN_RATING),
    moves: '12',
    topGames: '0',
    recentGames: '0',
  });
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${EXPLORER_URL}?${params}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(env.LICHESS_TOKEN ? { Authorization: `Bearer ${env.LICHESS_TOKEN}` } : {}),
        },
        signal: controller.signal,
      });
      if (res.status === 429) {
        console.warn('429 — backing off 60s');
        await sleep(BACKOFF_MS);
        continue;
      }
      if (!res.ok) {
        console.warn(`HTTP ${res.status} for ${fenKeyStr} — skipping`);
        return null;
      }
      return parseExplorerResponse(fenKeyStr, await res.json());
    } catch (e) {
      console.warn(`fetch failed for ${fenKeyStr}: ${(e as Error).message} — skipping`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function main() {
  const { depth, minShare } = parseArgs();
  const generatedAt = new Date().toISOString();
  const source = `lichess:${SPEEDS.join(',')}:${MIN_RATING}:snapshot@${generatedAt.slice(0, 10)}`;

  console.log(`Building snapshot: depth ${depth} plies, floor ${minShare * 100}% — ${source}`);

  // BFS over (fullFen, ply). Keyed by fenKey so transpositions fetch once.
  type Step = { fullFen: string; ply: number };
  const queue: Step[] = [{ fullFen: STARTING_FEN, ply: 0 }];
  const seen = new Set<string>();
  const lines: string[] = [];

  while (queue.length > 0) {
    const { fullFen, ply } = queue.shift()!;
    const key = makeFenKey(fullFen);
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = await fetchEntry(key);
    await sleep(REQUEST_GAP_MS);
    if (!entry || entry.total === 0) continue;

    lines.push(
      JSON.stringify({ fenKey: key, total: entry.total, moves: entry.moves }),
    );
    if (lines.length % 50 === 0) {
      console.log(`  ${lines.length} positions (queue ${queue.length}, ply ${ply})`);
    }

    if (ply >= depth) continue;
    for (const m of entry.moves) {
      if (moveShare(m, entry.total) < minShare) continue;
      const chess = new Chess(fullFen);
      try {
        chess.move({
          from: m.uci.slice(0, 2),
          to: m.uci.slice(2, 4),
          ...(m.uci.length > 4 ? { promotion: m.uci.slice(4, 5) } : {}),
        });
      } catch {
        continue; // malformed uci from upstream — skip the branch, keep the row
      }
      queue.push({ fullFen: chess.fen(), ply: ply + 1 });
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, 'snapshot.jsonl'), lines.join('\n') + '\n', 'utf8');
  await writeFile(
    resolve(OUT_DIR, 'meta.json'),
    JSON.stringify({ generatedAt, source, depthPlies: depth, minShare, positions: lines.length }, null, 2) + '\n',
    'utf8',
  );
  console.log(`Wrote ${lines.length} positions to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
