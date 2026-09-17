/**
 * End-of-session card for the rehearsal session (Study S5).
 */
import type { RehearseItem } from '../lib/rehearse/queue.ts';
import type { RehearseStats } from '../lib/rehearse/useRehearseSession.ts';
import { MoveLine } from './MoveLine.tsx';
import { Btn, Card } from './ui.tsx';

export function SessionSummary({
  stats,
  missedItems,
  empty,
  onRehearseMisses,
  onAgain,
  onExpand,
  onExit,
}: {
  stats: RehearseStats;
  missedItems: RehearseItem[];
  /** The scope had nothing to rehearse. */
  empty: boolean;
  onRehearseMisses: () => void;
  onAgain: () => void;
  onExpand: () => void;
  onExit: () => void;
}) {
  const answered = stats.correct + stats.wrong;
  const accuracy = answered > 0 ? Math.round((stats.correct / answered) * 100) : null;
  return (
    <Card title={empty ? 'Nothing to rehearse' : 'Done'}>
      {empty ? (
        <p className="text-sm text-slate-300">
          This scope has no moves of yours to play. Try another chapter, or expand variations to
          add some.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="correct" value={stats.correct} tone="text-emerald-300" />
          <Stat label="missed" value={stats.wrong} tone={stats.wrong > 0 ? 'text-rose-300' : ''} />
          <Stat label="accuracy" value={accuracy === null ? '—' : `${accuracy}%`} />
          {stats.bestStreak > 1 && <Stat label="best streak" value={stats.bestStreak} />}
          {stats.hinted > 0 && <Stat label="with hint" value={stats.hinted} />}
          {stats.recorded > 0 && <Stat label="recorded" value={stats.recorded} tone="text-sky-300" />}
        </div>
      )}

      {missedItems.length > 0 && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">Missed</p>
          <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1">
            {missedItems.map((it) => (
              <li key={it.move.id} className="flex items-baseline gap-2">
                <MoveLine sans={it.pathSans} className="text-[11px]" />
                <span className="font-mono text-xs text-emerald-300 shrink-0">→ {it.move.san}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {missedItems.length > 0 && (
          <Btn variant="primary" onClick={onRehearseMisses}>
            Rehearse misses again <kbd className="ml-1 text-[10px] opacity-60">↵</kbd>
          </Btn>
        )}
        {!empty && (
          <Btn variant={missedItems.length > 0 ? 'default' : 'primary'} onClick={onAgain}>
            Again, new shuffle
          </Btn>
        )}
        <Btn onClick={onExpand}>Expand variations</Btn>
        <Btn variant="ghost" onClick={onExit}>
          Back to studies
        </Btn>
      </div>
    </Card>
  );
}

function Stat({ label, value, tone = '' }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5">
      <div className={`text-lg font-mono font-semibold ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}
