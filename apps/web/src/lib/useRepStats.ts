/**
 * Per-repertoire badge stats (due / cards / to-build) for a list of summaries,
 * computed from the local card store plus cached full snapshots.
 *
 * Progressive on purpose: badges fill in one repertoire at a time as each
 * snapshot is available, and a stale-but-present local snapshot is used when
 * the API is unreachable — the home screens must render offline.
 *
 * Shared by the repertoire list and the Studies home so the two cannot drift
 * in what "due" means.
 */
import { useEffect, useState } from 'react';
import { api, type RepertoireSummary } from '../api/client.ts';
import { getAllCardsLocal, getAllRepertoiresLocal, putRepertoireLocal } from './idb/schema.ts';
import { computeRepStats, type RepStats } from './repStats.ts';

export function useRepStats(repertoires: RepertoireSummary[]): {
  stats: Map<string, RepStats>;
  reset(): void;
} {
  const [stats, setStats] = useState<Map<string, RepStats>>(new Map());

  useEffect(() => {
    if (repertoires.length === 0) return;
    let cancelled = false;
    (async () => {
      const cards = await getAllCardsLocal();
      const local = await getAllRepertoiresLocal();
      const localById = new Map(local.map((r) => [r.id, r]));
      const next = new Map<string, RepStats>();
      for (const sum of repertoires) {
        let full = localById.get(sum.id);
        if (!full || full.updatedAt !== sum.updatedAt) {
          try {
            full = await api.getRepertoire(sum.id);
            void putRepertoireLocal(full);
          } catch {
            /* offline — fall back to the (possibly stale) local snapshot */
          }
        }
        if (!full) continue;
        next.set(sum.id, computeRepStats(full, cards));
        if (cancelled) return;
        setStats(new Map(next));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repertoires]);

  return { stats, reset: () => setStats(new Map()) };
}
