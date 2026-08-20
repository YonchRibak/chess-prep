/**
 * Identify the named opening at a given position (single FEN) or the deepest
 * one along a path (used by the auto-naming header in Phase 6 / Phase 7).
 *
 * Both hooks debounce so quick navigation doesn't hammer the API, and both
 * cache results in a process-wide map so flipping back and forth through a
 * line is free after the first lookup.
 *
 * The server is the source of truth — the client only learns of openings via
 * lookup, never holds the full book. (3700+ entries is small, but loading
 * them all up-front conflicts with the "offline drilling only" promise: the
 * opening browser is online-only by design.)
 */
import { useEffect, useRef, useState } from 'react';
import { fenKey as makeFenKey, type FenKey, type OpeningId } from '@chess-prep/shared';
import { api, ApiError } from '../../api/client';

const DEBOUNCE_MS = 80;

const singleCache = new Map<string, OpeningId | null>();
const deepestCache = new Map<string, OpeningId | null>();

function pathCacheKey(keys: readonly string[]): string {
  // Order matters — same FENs in a different order is a different line.
  return keys.join('|');
}

function safeFenKey(fenOrKey: string): FenKey | null {
  try {
    return makeFenKey(fenOrKey);
  } catch {
    return null;
  }
}

/**
 * Hook that returns the named opening for a single position (or null if the
 * position isn't in the book). Pass a full FEN OR a normalized fenKey —
 * either is normalized internally before lookup.
 */
export function useOpeningId(fen: string | null): {
  opening: OpeningId | null;
  loading: boolean;
} {
  const [state, setState] = useState<{ opening: OpeningId | null; loading: boolean }>({
    opening: null,
    loading: false,
  });

  // Track the "latest requested fen" so stale responses can be dropped.
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!fen) {
      setState({ opening: null, loading: false });
      return;
    }
    const key = safeFenKey(fen);
    if (!key) {
      setState({ opening: null, loading: false });
      return;
    }
    if (singleCache.has(key)) {
      setState({ opening: singleCache.get(key)!, loading: false });
      return;
    }

    setState((s) => ({ ...s, loading: true }));
    const myReq = ++reqIdRef.current;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const row = await api.getOpeningByFenKey(key);
          const id: OpeningId | null = row
            ? { eco: row.eco, name: row.name, variation: row.variation }
            : null;
          singleCache.set(key, id);
          if (myReq === reqIdRef.current) setState({ opening: id, loading: false });
        } catch (e) {
          // 404s are normalized to null in the api client; any other failure
          // is non-fatal — the header just shows nothing.
          if (!(e instanceof ApiError)) console.warn('useOpeningId lookup failed', e);
          if (myReq === reqIdRef.current) setState({ opening: null, loading: false });
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [fen]);

  return state;
}

/**
 * Hook that returns the deepest matched opening along a path of FEN keys
 * (root → current position). Used by the editor header in Phase 6/7 so that
 * "Caro-Kann Defense" refines into "...Advance Variation" as the user steps
 * forward, AND so transpositions inherit a name from a known ancestor when
 * the current FEN itself isn't book.
 */
export function useDeepestOpeningId(fenKeysAlongLine: readonly string[]): {
  opening: OpeningId | null;
  loading: boolean;
} {
  const [state, setState] = useState<{ opening: OpeningId | null; loading: boolean }>({
    opening: null,
    loading: false,
  });
  const reqIdRef = useRef(0);

  // Stable cache key for the dep array so we don't refetch on a fresh array
  // with the same contents.
  const cacheKey = pathCacheKey(fenKeysAlongLine);

  useEffect(() => {
    if (fenKeysAlongLine.length === 0) {
      setState({ opening: null, loading: false });
      return;
    }
    if (deepestCache.has(cacheKey)) {
      setState({ opening: deepestCache.get(cacheKey)!, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const myReq = ++reqIdRef.current;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const { opening } = await api.identifyDeepestOpening([...fenKeysAlongLine]);
          deepestCache.set(cacheKey, opening);
          if (myReq === reqIdRef.current) setState({ opening, loading: false });
        } catch (e) {
          if (!(e instanceof ApiError)) console.warn('useDeepestOpeningId lookup failed', e);
          if (myReq === reqIdRef.current) setState({ opening: null, loading: false });
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
    // cacheKey is the stable identity of the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return state;
}

/** Format an OpeningId for display, e.g. "B12 — Caro-Kann Defense, Advance Variation". */
export function formatOpeningId(id: OpeningId | null): string {
  if (!id) return '';
  const base = `${id.eco} — ${id.name}`;
  return id.variation ? `${base}, ${id.variation}` : base;
}
