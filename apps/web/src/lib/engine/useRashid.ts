import { useEffect, useState } from 'react';
import { fenTurn, type RashidResult } from '@chess-prep/shared';
import { RashidCancelled, requestRashid } from './rashidLive.ts';

export type RashidStatus =
  | 'off' // disabled by the caller
  | 'not-hero-turn' // Rashid only advises the hero-to-move positions
  | 'pending'
  | 'ready'
  | 'gated' // drill in progress — refused by design
  | 'error';

export interface RashidHookState {
  status: RashidStatus;
  result: RashidResult | null;
  /** True when the result came from cache layer B (instant, not provisional). */
  fromCache: boolean;
  error: string | null;
}

const OFF: RashidHookState = { status: 'off', result: null, fromCache: false, error: null };

/**
 * Live Rashid probe for the currently viewed position (plan R3).
 *
 * Requests through `requestRashid` (dedicated engine + layer-B cache) and
 * cancels the probe whenever the position changes or the component unmounts —
 * a superseded probe must neither waste searches nor write stale state.
 */
export function useRashid(
  fen: string | null,
  heroColor: 'w' | 'b',
  enabled: boolean,
): RashidHookState {
  const [state, setState] = useState<RashidHookState>(OFF);

  useEffect(() => {
    if (!enabled || !fen) {
      setState(OFF);
      return;
    }
    if (fenTurn(fen) !== heroColor) {
      setState({ status: 'not-hero-turn', result: null, fromCache: false, error: null });
      return;
    }
    let stale = false;
    setState({ status: 'pending', result: null, fromCache: false, error: null });
    const handle = requestRashid(fen, heroColor);
    handle.promise
      .then(({ result, fromCache }) => {
        if (!stale) setState({ status: 'ready', result, fromCache, error: null });
      })
      .catch((e: unknown) => {
        if (stale || e instanceof RashidCancelled) return; // superseded — say nothing
        const msg = e instanceof Error ? e.message : String(e);
        setState({
          status: /gated/.test(msg) ? 'gated' : 'error',
          result: null,
          fromCache: false,
          error: msg,
        });
      });
    return () => {
      stale = true;
      handle.cancel();
    };
  }, [fen, heroColor, enabled]);

  return state;
}
