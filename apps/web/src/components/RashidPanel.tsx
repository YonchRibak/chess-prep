import { useState } from 'react';
import { Chess } from 'chess.js';
import { formatRashidScore } from '@chess-prep/shared';
import { Card } from './ui.tsx';
import { useRashid } from '../lib/engine/useRashid.ts';

/**
 * Rashid live-probe panel (plan R3) — surfaces the trap analysis for the
 * position being viewed in the editor, as data. Board arrows are R4.
 *
 * Off by default: a probe costs a few seconds of real engine time per new
 * position, and auto-running it on every navigation would burn CPU the user
 * didn't ask for. Once R5 precomputes the repertoire, hits are instant and
 * the default can flip.
 */
export function RashidPanel({ fen, heroColor }: { fen: string; heroColor: 'w' | 'b' }) {
  const [enabled, setEnabled] = useState(false);
  const rashid = useRashid(fen, heroColor, enabled);

  function san(ucis: string[]): string {
    try {
      const c = new Chess(fen);
      return ucis
        .map((u) =>
          c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined }).san,
        )
        .join(' ');
    } catch {
      return ucis.join(' '); // navigation race — show raw UCI over crashing
    }
  }

  const best = rashid.result?.best ?? null;

  return (
    <Card title="Rashid — trap finder">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs text-slate-400 flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          probe this position
        </label>
        {rashid.status === 'ready' && (
          <span className="text-[10px] text-slate-500">
            {rashid.fromCache ? 'cached' : 'live probe'}
          </span>
        )}
      </div>

      {rashid.status === 'off' && (
        <p className="text-xs text-slate-500">Off — enable to search for opponent tightropes.</p>
      )}
      {rashid.status === 'not-hero-turn' && (
        <p className="text-xs text-slate-500">Opponent to move — Rashid advises your turns only.</p>
      )}
      {rashid.status === 'pending' && <p className="text-xs text-slate-400">Probing…</p>}
      {rashid.status === 'gated' && (
        <p className="text-xs text-slate-500">Unavailable during a drill.</p>
      )}
      {rashid.status === 'error' && <p className="text-xs text-red-400">{rashid.error}</p>}

      {rashid.status === 'ready' && rashid.result && (
        <div className="text-xs flex flex-col gap-1">
          {best ? (
            <>
              <p>
                🪤 <span className="font-mono">{san(best.line)}</span>
              </p>
              <p className="text-slate-400">
                Length <b>{best.length}</b> · Risk <b>{formatRashidScore(best.riskScore)}</b> · if
                they slip: ≥ <b>{best.rewardFloor != null ? formatRashidScore(best.rewardFloor) : '—'}</b>
                {best.rewardMax != null && best.rewardMax !== best.rewardFloor && (
                  <> (up to {formatRashidScore(best.rewardMax)})</>
                )}
              </p>
            </>
          ) : (
            <p className="text-slate-500">
              No qualifying tightrope here (checked {rashid.result.candidates.length} candidate
              moves).
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
