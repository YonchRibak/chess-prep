import { Chess } from 'chess.js';
import { formatRashidScore } from '@chess-prep/shared';
import { Btn, Card } from './ui.tsx';
import { RASHID_BAND_HEX, riskBand } from '../lib/engine/rashidArrows.ts';
import type { RashidHookState } from '../lib/engine/useRashid.ts';
import type { RashidPrecomputeProgress } from '../lib/engine/rashidPrecompute.ts';

/**
 * Rashid probe panel (plan R3/R4). Presentational — the editor owns the
 * `useRashid` state so the board arrows and this panel read the same result.
 *
 * Off by default: a probe costs a few seconds of real engine time per new
 * position until R5 precompute makes hits instant. While on, the board's
 * arrows switch to Rashid mode (hue = risk band, thickness = reward floor,
 * badge = length); this panel carries the exact numbers, deliberately — the
 * arrow hue is never the only channel (chessground brushes can't dash).
 */
export function RashidPanel({
  fen,
  state,
  enabled,
  onToggle,
  precompute,
  precomputing,
  onStartPrecompute,
  onCancelPrecompute,
}: {
  fen: string;
  state: RashidHookState;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  precompute: RashidPrecomputeProgress | null;
  precomputing: boolean;
  onStartPrecompute: () => void;
  onCancelPrecompute: () => void;
}) {
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

  const best = state.result?.best ?? null;

  return (
    <Card title="Rashid — trap finder">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs text-slate-400 flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          probe this position
        </label>
        {state.status === 'ready' && (
          <span className="text-[10px] text-slate-500">
            {state.fromCache ? 'cached' : 'live probe'}
          </span>
        )}
      </div>

      {state.status === 'off' && (
        <p className="text-xs text-slate-500">
          Off — enable to hunt for opponent tightropes (takes over the board arrows).
        </p>
      )}
      {state.status === 'not-hero-turn' && (
        <p className="text-xs text-slate-500">Opponent to move — Rashid advises your turns only.</p>
      )}
      {state.status === 'pending' && <p className="text-xs text-slate-400">Probing…</p>}
      {state.status === 'gated' && (
        <p className="text-xs text-slate-500">Unavailable during a drill.</p>
      )}
      {state.status === 'error' && <p className="text-xs text-red-400">{state.error}</p>}

      {state.status === 'ready' && state.result && (
        <div className="text-xs flex flex-col gap-1">
          {best ? (
            <>
              <p className="flex items-center gap-2">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: RASHID_BAND_HEX[riskBand(best.riskScore)] }}
                  title={`risk band: ${riskBand(best.riskScore)}`}
                />
                <span className="font-mono">{san(best.line)}</span>
              </p>
              <p className="text-slate-400">
                Length <b>{best.length}</b> · Risk <b>{formatRashidScore(best.riskScore)}</b> · if
                they slip: ≥{' '}
                <b>{best.rewardFloor != null ? formatRashidScore(best.rewardFloor) : '—'}</b>
                {best.rewardMax != null && best.rewardMax !== best.rewardFloor && (
                  <> (up to {formatRashidScore(best.rewardMax)})</>
                )}
              </p>
              {best.pinchPoints.length > 1 && (
                <ul className="text-slate-500">
                  {best.pinchPoints.map((p) => (
                    <li key={p.ply}>
                      step {p.ply}: only {san(best.line.slice(0, p.ply)).split(' ').pop()} — miss
                      costs {formatRashidScore(p.missScore)}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-slate-500">
              No qualifying tightrope here (checked {state.result.candidates.length} candidate
              moves).
            </p>
          )}
        </div>
      )}

      {/* R5: background precompute — fills the caches so probes are instant. */}
      <div className="mt-3 pt-2 border-t border-slate-700/50 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Precompute</span>
          {precomputing ? (
            <Btn onClick={onCancelPrecompute}>Stop</Btn>
          ) : (
            <Btn onClick={onStartPrecompute}>
              {precompute && precompute.done < precompute.total ? 'Resume' : 'Run'}
            </Btn>
          )}
        </div>
        {precompute && (
          <div className="text-xs text-slate-400">
            <div className="h-1.5 rounded bg-slate-800 overflow-hidden mb-1">
              <div
                className="h-full bg-emerald-600"
                style={{
                  width: `${precompute.total ? (100 * precompute.done) / precompute.total : 0}%`,
                }}
              />
            </div>
            {precompute.done}/{precompute.total} positions · {precompute.computed} fresh ·{' '}
            {precompute.cached} cached · {precompute.lit} traps
            {precompute.failed > 0 && <> · {precompute.failed} skipped</>}
            {precompute.paused && (
              <span className="text-amber-400"> · paused (drill in progress)</span>
            )}
          </div>
        )}
        {!precompute && (
          <p className="text-[11px] text-slate-500">
            Analyzes every position where it&apos;s your move (~10s each, resumable) so probes
            here become instant.
          </p>
        )}
      </div>
    </Card>
  );
}
