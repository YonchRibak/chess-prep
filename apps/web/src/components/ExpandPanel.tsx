/**
 * "Expand variations" side panel (Study S5; presentational).
 *
 * At an opponent-turn position of the study it lists popular replies the
 * study does not cover; pick one, then play your answer on the board to
 * record it. The eval bar is always visible here; engine suggestions (PV
 * lines + board arrows) are hidden until asked for, so the user thinks first.
 */
import type { RankedReply } from '@chess-prep/shared';
import type { EngineHookState } from '../lib/engine/useEngine.ts';
import type { DeviationSource } from '../lib/rehearse/expand.ts';
import type { RehearsePhase } from '../lib/rehearse/useRehearseSession.ts';
import { EnginePanel } from './EnginePanel.tsx';
import { Btn, Card } from './ui.tsx';

const SOURCE_LABEL: Record<DeviationSource, string> = {
  explorer: 'by popularity (lichess games)',
  engine: 'engine suggestions (explorer unavailable)',
  book: 'from the opening book (no frequency data)',
  none: '',
};

export function ExpandPanel({
  phase,
  fen,
  targetNumber,
  targetTotal,
  deviation,
  engine,
  showSuggestions,
  onToggleSuggestions,
  onChoose,
  onUndoDeviation,
  onSkip,
  onBack,
}: {
  phase: Extract<RehearsePhase, { kind: 'expand' }>;
  fen: string;
  targetNumber: number;
  targetTotal: number;
  deviation: { replies: RankedReply[]; source: DeviationSource; ready: boolean };
  engine: EngineHookState;
  showSuggestions: boolean;
  onToggleSuggestions: () => void;
  onChoose: (san: string) => void;
  onUndoDeviation: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  if (phase.step === 'done') {
    return (
      <Card title="Expand variations">
        <p className="text-sm text-slate-300">
          {targetTotal === 0
            ? 'No branch points in this scope.'
            : 'Every branch point in this scope has been visited.'}
        </p>
        <div className="mt-3">
          <Btn variant="primary" onClick={onBack}>
            Back to cards <kbd className="ml-1 text-[10px] opacity-60">↵</kbd>
          </Btn>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card title={`Branch point ${targetNumber} of ${targetTotal}`}>
        {phase.step === 'pick' && (
          <>
            <p className="text-sm">Opponent to move. Replies the study doesn’t cover:</p>
            {!deviation.ready ? (
              <p className="text-xs text-slate-500 mt-2">Looking up replies…</p>
            ) : deviation.replies.length === 0 ? (
              <p className="text-xs text-slate-500 mt-2">
                Nothing to add here — the study already covers what’s known. Press N for the next.
              </p>
            ) : (
              <>
                <ul className="mt-2 flex flex-col gap-1">
                  {deviation.replies.map((r) => (
                    <li key={r.san}>
                      <button
                        onClick={() => onChoose(r.san)}
                        className="w-full flex items-baseline justify-between gap-2 rounded border border-slate-800 px-2 py-1 text-left hover:border-emerald-700 hover:bg-slate-800"
                      >
                        <span className="font-mono text-sm">{r.san}</span>
                        <span className="text-[10px] font-mono text-slate-500">
                          {r.share > 0 ? `${Math.round(r.share * 100)}%` : ''}
                          {r.score !== null ? ` · ${Math.round(r.score * 100)}% score` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-slate-500 mt-1">{SOURCE_LABEL[deviation.source]}</p>
              </>
            )}
            <div className="mt-2 flex gap-2">
              <Btn variant="ghost" onClick={onSkip}>
                Next branch point <kbd className="ml-1 text-[10px] text-slate-500">N</kbd>
              </Btn>
            </div>
          </>
        )}

        {(phase.step === 'your-move' || phase.step === 'saving') && (
          <>
            <p className="text-sm">
              After <span className="font-mono font-medium">{phase.deviationSan}</span> — your move.
              Play it on the board to record it.
            </p>
            {phase.error && <p className="text-xs text-rose-300 mt-1">{phase.error}</p>}
            <p className="text-xs text-slate-500 mt-1">
              {phase.step === 'saving' ? 'Saving…' : 'It becomes a card and survives re-uploads of the study.'}
            </p>
            <div className="mt-2 flex gap-2">
              <Btn variant="ghost" onClick={onUndoDeviation} disabled={phase.step === 'saving'}>
                ← Other reply
              </Btn>
            </div>
          </>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Engine</span>
        <button
          onClick={onToggleSuggestions}
          aria-pressed={showSuggestions}
          className={`rounded border px-2 py-0.5 text-[11px] ${
            showSuggestions
              ? 'border-emerald-700 bg-emerald-900/40 text-emerald-200'
              : 'border-slate-800 text-slate-500 hover:text-slate-300'
          }`}
        >
          {showSuggestions ? 'Hide suggestions' : 'Show suggestions'}
        </button>
      </div>
      <EnginePanel
        fen={fen}
        progress={engine.progress}
        ready={engine.ready}
        error={engine.error}
        enabled
        onToggleEnabled={() => {}}
        hideToggle
        showLines={showSuggestions}
      />
    </>
  );
}
