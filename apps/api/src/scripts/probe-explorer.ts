/**
 * Diagnostic: does the explorer cache actually fill on this machine?
 *
 * `pnpm --filter @chess-prep/api probe:explorer`
 *
 * Prints the cached/fetched entry for the starting position, or `NULL` when
 * neither the cache nor the network could supply one. `NULL` is a *supported*
 * state — every caller falls back to book continuations — so this script exists
 * to tell the two apart, since the service deliberately never throws.
 *
 * Known local gotcha: `explorer.lichess.ovh` answers `401` from an nginx in
 * front of it on this dev machine regardless of headers, while `lichess.org`
 * itself is reachable. See dev-setup.md.
 */
import { EXPLORER_SOURCE, getExplorerEntry } from '../services/explorer.js';

const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

const fenKey = process.argv[2] ?? START_KEY;

getExplorerEntry(fenKey)
  .then((entry) => {
    console.log(`source: ${EXPLORER_SOURCE}`);
    if (!entry) {
      console.log('NULL — nothing cached and the fetch did not succeed.');
      process.exit(0);
    }
    console.log(`fetchedAt: ${entry.fetchedAt}`);
    console.log(`total games: ${entry.total}`);
    for (const m of entry.moves.slice(0, 6)) {
      const n = m.white + m.draws + m.black;
      const share = entry.total > 0 ? ((n / entry.total) * 100).toFixed(1) : '0.0';
      console.log(`  ${m.san.padEnd(6)} ${String(n).padStart(8)} games  ${share}%`);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('probe failed', e);
    process.exit(1);
  });
