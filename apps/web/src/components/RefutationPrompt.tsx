/**
 * Phase 9d — "why was that bad?" after a miss.
 *
 * Shows the engine's punishment of the move the user just played wrong, and
 * offers to store it as a **refutation shadow line**: saved in the tree, but
 * never prep — no SRS card, no coverage, no drill, no export. See
 * `packages/shared/src/refutation.ts` and the API's `appendRefutation`.
 *
 * Two things this component is careful about:
 *
 * - **It never leaks the card's answer.** It analyzes the position *after the
 *   wrong move*, which is not the card's position, and it does so with the
 *   engine's gate still closed (`bypassGate` — see `AnalyzeOptions`). It must
 *   therefore be rendered only where the wrong move has already been played,
 *   and never handed the card's parent FEN.
 * - **It asks first.** Nothing is written until the user clicks save, because
 *   the shadow line lands in their repertoire tree.
 */
import { useState } from 'react';
import {
  fenAfterSan,
  fenKey,
  pvToRefutationSans,
  MAX_REFUTATION_PLIES,
} from '@chess-prep/shared';
import { api } from '../api/client.ts';
import { getEngine } from '../lib/engine/engine.ts';
import { Btn } from './ui.tsx';

const REFUTATION_DEPTH = 14;

export interface RefutationPromptProps {
  repertoireId: string;
  /** FEN of the position the mistake was made in — must be in the repertoire. */
  parentFullFen: string;
  /** The SAN the user played by mistake. Becomes the first ply of the line. */
  wrongSan: string;
}

type State =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'ready'; sans: string[]; scoreText: string }
  | { kind: 'saved'; sans: string[] }
  | { kind: 'error'; message: string };

export function RefutationPrompt({
  repertoireId,
  parentFullFen,
  wrongSan,
}: RefutationPromptProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function analyze() {
    const afterWrongFullFen = fenAfterSan(parentFullFen, wrongSan);
    if (!afterWrongFullFen) {
      setState({ kind: 'error', message: 'Could not replay that move.' });
      return;
    }
    setState({ kind: 'thinking' });
    try {
      const engine = getEngine();
      await engine.init();
      const progress = await engine.analyzeOnce(afterWrongFullFen, {
        depth: REFUTATION_DEPTH,
        multipv: 1,
        bypassGate: true,
      });
      const line = progress.lines[0];
      if (!line) {
        setState({ kind: 'error', message: 'The engine returned no line.' });
        return;
      }
      // The wrong move itself is ply 1 of the shadow line, so the engine's
      // continuation gets one ply less than the cap.
      const sans = pvToRefutationSans(afterWrongFullFen, line.pv, MAX_REFUTATION_PLIES - 1);
      if (sans.length === 0) {
        setState({ kind: 'error', message: 'No playable continuation to store.' });
        return;
      }
      setState({ kind: 'ready', sans, scoreText: formatScore(line) });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function save(sans: string[]) {
    try {
      await api.appendRefutation(repertoireId, {
        fromFenKey: fenKey(parentFullFen),
        sans: [wrongSan, ...sans],
      });
      setState({ kind: 'saved', sans });
    } catch (e) {
      // Deliberately not queued for offline retry: a shadow line is an
      // optional annotation, and silently replaying tree writes on reconnect
      // is reserved for grades, which the session cannot afford to lose.
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not save the refutation.',
      });
    }
  }

  if (state.kind === 'saved') {
    return (
      <p className="text-xs text-slate-400 mt-2">
        Saved as a shadow line (not drilled):{' '}
        <span className="font-mono">
          {wrongSan} {state.sans.join(' ')}
        </span>
      </p>
    );
  }

  return (
    <div className="mt-2">
      {state.kind === 'idle' && (
        <Btn className="text-xs" onClick={() => void analyze()}>
          Why is {wrongSan} bad?
        </Btn>
      )}
      {state.kind === 'thinking' && <p className="text-xs text-slate-400">Analyzing…</p>}
      {state.kind === 'ready' && (
        <div className="text-xs text-slate-300">
          <p>
            <span className="font-mono">
              {wrongSan} {state.sans.join(' ')}
            </span>{' '}
            <span className="text-slate-400">({state.scoreText})</span>
          </p>
          <div className="flex gap-2 mt-1">
            <Btn className="text-xs" onClick={() => void save(state.sans)}>
              Save as shadow line
            </Btn>
            <Btn className="text-xs" onClick={() => setState({ kind: 'idle' })}>
              Dismiss
            </Btn>
          </div>
        </div>
      )}
      {state.kind === 'error' && <p className="text-xs text-rose-300">{state.message}</p>}
    </div>
  );
}

/** Eval from the perspective of the side to move after the wrong move. */
function formatScore(line: { cp?: number; mate?: number }): string {
  if (line.mate != null) return `mate in ${Math.abs(line.mate)}`;
  if (line.cp != null) return `${line.cp > 0 ? '+' : ''}${(line.cp / 100).toFixed(2)}`;
  return 'no score';
}
