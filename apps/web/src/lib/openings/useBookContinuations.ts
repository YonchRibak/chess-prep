/**
 * Phase 7: known book moves out of a given position, used by the guided
 * builder prompts. Cached process-wide so flipping back and forth through
 * positions is free after the first hit.
 */
import { useEffect, useRef, useState } from 'react';
import { fenKey as makeFenKey, type FenKey } from '@chess-prep/shared';
import { api, ApiError, type BookContinuation } from '../../api/client';

const cache = new Map<string, BookContinuation[]>();

export function useBookContinuations(fenOrKey: string | null): {
  continuations: BookContinuation[];
  loading: boolean;
} {
  const [state, setState] = useState<{ continuations: BookContinuation[]; loading: boolean }>({
    continuations: [],
    loading: false,
  });
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!fenOrKey) {
      setState({ continuations: [], loading: false });
      return;
    }
    let key: FenKey;
    try {
      key = makeFenKey(fenOrKey);
    } catch {
      setState({ continuations: [], loading: false });
      return;
    }
    if (cache.has(key)) {
      setState({ continuations: cache.get(key)!, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const myReq = ++reqIdRef.current;
    void (async () => {
      try {
        const rows = await api.getBookContinuations(key);
        cache.set(key, rows);
        if (myReq === reqIdRef.current) setState({ continuations: rows, loading: false });
      } catch (e) {
        if (!(e instanceof ApiError)) console.warn('useBookContinuations failed', e);
        if (myReq === reqIdRef.current) setState({ continuations: [], loading: false });
      }
    })();
  }, [fenOrKey]);

  return state;
}
