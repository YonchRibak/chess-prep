/**
 * Phase 9c frontier prefetcher: warm explorer entries for the positions the
 * walker is *about* to ask about, during idle time.
 *
 * It is **purely an optimization**. Every path it feeds already works with a
 * cold cache — that is the rule for anything explorer-shaped
 * ([explorer](../../../../../knowledge/03-domain/explorer.md)) — so this module
 * never reports errors, never blocks a caller, and never retries: a warm that
 * fails simply means the next prompt pays the latency it would have paid
 * anyway.
 *
 * Warming happens server-side (the API is the thing with the cache), so this
 * only issues the requests; nothing is stored locally.
 */
import { fetchExplorerEntry } from './candidates.ts';

/** Positions warmed this page-load, so a revisit costs nothing. */
const warmed = new Set<string>();

/** One at a time: this must never compete with a request the user is waiting on. */
let running = false;
const queue: string[] = [];

/** Cap per call, so a huge tree can't queue thousands of positions. */
const MAX_PER_CALL = 8;

function idle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (ric) ric(fn);
  else setTimeout(fn, 250);
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const fenKey = queue.shift()!;
      if (warmed.has(fenKey)) continue;
      warmed.add(fenKey);
      // Marked warmed BEFORE the request: on failure we deliberately do not
      // retry, since the fallback path is fine and a retry loop against an
      // unreachable explorer would be pure waste.
      await fetchExplorerEntry(fenKey);
    }
  } finally {
    running = false;
  }
}

/**
 * Queue `fenKeys` (typically the positions one ply past current coverage) for
 * background warming. Returns immediately; already-warmed keys are skipped.
 */
export function warmFrontier(fenKeys: readonly string[]): void {
  const fresh = fenKeys.filter((k) => k && !warmed.has(k) && !queue.includes(k));
  if (fresh.length === 0) return;
  queue.push(...fresh.slice(0, MAX_PER_CALL));
  idle(() => void drain());
}

/** Test/debug seam. */
export function resetFrontierWarmCache(): void {
  warmed.clear();
  queue.length = 0;
}
