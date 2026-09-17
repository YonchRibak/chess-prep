/**
 * One-line header for the rehearsal session (Study S5): where you are,
 * how it is going, and the few switches the session has. Everything else
 * the walker's sidebar showed is deliberately absent.
 */
import type { RehearseStats } from '../lib/rehearse/useRehearseSession.ts';
import { Btn } from './ui.tsx';

export function RehearseStrip({
  title,
  subtitle,
  position,
  total,
  stats,
  expanding,
  evalAfterAnswer,
  sound,
  fullReplay,
  onToggleExpand,
  onToggleEval,
  onToggleSound,
  onToggleFullReplay,
  onExit,
}: {
  title: string;
  subtitle?: string;
  position: number | null;
  total: number;
  stats: RehearseStats;
  expanding: boolean;
  evalAfterAnswer: boolean;
  sound: boolean;
  /** Replay whole lines between cards instead of snapping and animating the last ply. */
  fullReplay: boolean;
  onToggleExpand: () => void;
  onToggleEval: () => void;
  onToggleSound: () => void;
  onToggleFullReplay: () => void;
  onExit: () => void;
}) {
  const answered = stats.correct + stats.wrong;
  const accuracy = answered > 0 ? Math.round((stats.correct / answered) * 100) : null;
  return (
    <div className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="font-medium truncate">{title}</span>
        {subtitle && <span className="text-slate-500 truncate">{subtitle}</span>}
      </div>
      <div className="flex items-center gap-3 font-mono text-slate-400">
        {position !== null && total > 0 && (
          <span title="Position in this session">
            {position + 1}
            <span className="text-slate-600">/</span>
            {total}
          </span>
        )}
        {stats.streak > 1 && (
          <span className="text-emerald-300" title="Current streak">
            🔥{stats.streak}
          </span>
        )}
        {accuracy !== null && <span title="Accuracy this session">{accuracy}%</span>}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Toggle on={evalAfterAnswer} onClick={onToggleEval} title="Show the eval bar briefly after each answer">
          eval
        </Toggle>
        <Toggle
          on={fullReplay}
          onClick={onToggleFullReplay}
          title="Replay the whole line between positions (off: only the last move is animated)"
        >
          replay
        </Toggle>
        <Toggle on={sound} onClick={onToggleSound} title="Sound on answers">
          🔈
        </Toggle>
        <Btn variant={expanding ? 'primary' : 'default'} onClick={onToggleExpand} title="Expand variations (E)">
          {expanding ? 'Back to cards' : 'Expand'}
          <kbd className="ml-1 text-[10px] opacity-60">E</kbd>
        </Btn>
        <Btn variant="ghost" onClick={onExit} title="Back to studies (Esc)">
          ✕
        </Btn>
      </div>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`rounded border px-2 py-1 text-[11px] ${
        on ? 'border-emerald-700 bg-emerald-900/40 text-emerald-200' : 'border-slate-800 text-slate-500 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  );
}
