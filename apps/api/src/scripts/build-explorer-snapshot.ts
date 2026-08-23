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
 *   pnpm --filter @chess-prep/api snapshot:build \
 *     [-- --depth 12 --min-share 0.02 --min-games 1000 --max-positions 5000]
 *
 * Expansion is **best-first by game count with a hard position cap**, not
 * plain BFS. A relative share floor alone never converges: a rare position's
 * own top replies are still above 2% *of that position*, so the frontier
 * multiplies by ~5 every ply and depth 12 becomes weeks of crawling. Popping
 * the most-played frontier position next means `--max-positions` yields
 * exactly the N most popular positions — a predictable size AND the best N
 * for a frequency floor. `--min-games` (absolute) additionally refuses to
 * descend into moves with too few games to ever matter.
 *
 * Output is APPENDED line by line as it goes and `meta.json` is refreshed
 * periodically, so an interrupted run (Ctrl+C, network death) still leaves an
 * importable snapshot — just a smaller one.
 *
 * Rate-limit manners mirror the cache service: one request at a time, a
 * polite delay between requests, and a 429 pauses everything for 60s.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
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
  /** Never descend into a move with fewer than this many games. */
  minGames: number;
  /** Hard cap on fetched positions — the crawl's real size knob. */
  maxPositions: number;
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
    minGames: Number(get('--min-games') ?? 1000),
    maxPositions: Number(get('--max-positions') ?? 5000),
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
  const { depth, minShare, minGames, maxPositions } = parseArgs();
  const generatedAt = new Date().toISOString();
  const source = `lichess:${SPEEDS.join(',')}:${MIN_RATING}:snapshot@${generatedAt.slice(0, 10)}`;

  console.log(
    `Building snapshot: ≤${maxPositions} positions, depth ${depth} plies, ` +
      `share ≥${minShare * 100}%, games ≥${minGames} — ${source}`,
  );
  console.log(`ETA at ~${REQUEST_GAP_MS}ms/request: ~${Math.round((maxPositions * (REQUEST_GAP_MS + 300)) / 60000)} min if the cap is reached. Ctrl+C keeps what's fetched.`);

  await mkdir(OUT_DIR, { recursive: true });
  const linesPath = resolve(OUT_DIR, 'snapshot.jsonl');
  const metaPath = resolve(OUT_DIR, 'meta.json');
  await writeFile(linesPath, '', 'utf8'); // fresh run — truncate

  let written = 0;
  let complete = false;
  const writeMeta = () =>
    writeFile(
      metaPath,
      JSON.stringify(
        {
          generatedAt,
          source,
          depthPlies: depth,
          minShare,
          minGames,
          maxPositions,
          positions: written,
          complete,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

  // Graceful interrupt: finish the in-flight fetch, keep everything written.
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130); // second Ctrl+C: hard exit
    interrupted = true;
    console.log('\nInterrupt — finishing the current position, then writing meta.json…');
  });

  // Best-first frontier: always expand the most-played position next, so the
  // position cap keeps exactly the N most popular positions. `games` is the
  // play count of the move that reached the position (known from the parent's
  // stats before fetching the child).
  type Step = { fullFen: string; ply: number; games: number };
  const frontier: Step[] = [
    { fullFen: STARTING_FEN, ply: 0, games: Number.POSITIVE_INFINITY },
  ];
  const seen = new Set<string>();

  while (frontier.length > 0 && written < maxPositions && !interrupted) {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i]!.games > frontier[best]!.games) best = i;
    }
    const { fullFen, ply, games } = frontier.splice(best, 1)[0]!;
    const key = makeFenKey(fullFen);
    if (seen.has(key)) continue; // transposition — already fetched
    seen.add(key);

    const entry = await fetchEntry(key);
    await sleep(REQUEST_GAP_MS);
    if (!entry || entry.total === 0) continue;

    await appendFile(
      linesPath,
      JSON.stringify({ fenKey: key, total: entry.total, moves: entry.moves }) + '\n',
      'utf8',
    );
    written++;
    if (written % 50 === 0) {
      console.log(
        `  ${written}/${maxPositions} positions (frontier ${frontier.length}, ply ${ply}, ~${fmtGames(games)} games)`,
      );
      if (written % 200 === 0) await writeMeta();
    }

    if (ply >= depth) continue;
    for (const m of entry.moves) {
      const count = m.white + m.draws + m.black;
      if (count < minGames) continue;
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
      frontier.push({ fullFen: chess.fen(), ply: ply + 1, games: count });
    }
  }

  complete = !interrupted && (frontier.length === 0 || written >= maxPositions);
  await writeMeta();
  console.log(
    `${interrupted ? 'Interrupted — wrote' : 'Wrote'} ${written} positions to ${OUT_DIR}`,
  );
}

function fmtGames(n: number): string {
  if (!Number.isFinite(n)) return 'all';
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
