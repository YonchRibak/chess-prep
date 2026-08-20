import { useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { useAppStore } from '../store/app.ts';
import { Btn, Card } from '../components/ui.tsx';
import {
  DEFAULT_HEALTH_OPTIONS,
  runHealthCheck,
  type HealthCheckOptions,
  type HealthCheckProgress,
  type MoveAssessment,
} from '../lib/engine/healthCheck.ts';

export function HealthCheckPage() {
  const active = useAppStore((s) => s.active);
  const go = useAppStore((s) => s.go);

  const [opts, setOpts] = useState<HealthCheckOptions>(DEFAULT_HEALTH_OPTIONS);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<HealthCheckProgress | null>(null);
  const [results, setResults] = useState<MoveAssessment[] | null>(null);
  const cancelRef = useRef(false);

  // Ensure we don't leave a check running if the user navigates away.
  useEffect(
    () => () => {
      cancelRef.current = true;
    },
    [],
  );

  if (!active) {
    return (
      <p className="text-slate-400 text-sm">
        No repertoire loaded.{' '}
        <button className="underline" onClick={() => go({ kind: 'list' })}>
          Back
        </button>
      </p>
    );
  }

  async function start() {
    if (!active) return;
    cancelRef.current = false;
    setRunning(true);
    setResults(null);
    try {
      const r = await runHealthCheck(active, opts, setProgress, () => cancelRef.current);
      setResults(r);
    } finally {
      setRunning(false);
    }
  }

  function cancel() {
    cancelRef.current = true;
  }

  const flagged = results?.filter((r) => r.flagged) ?? progress?.flagged ?? [];

  return (
    <div className="w-full max-w-4xl flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <button
            onClick={() => go({ kind: 'editor', repertoireId: active.id })}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            ← Editor
          </button>
          <h2 className="text-lg font-semibold">Health check: {active.name}</h2>
        </div>
      </header>

      <Card title="Settings">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Depth</span>
            <input
              type="number"
              min={6}
              max={30}
              value={opts.depth}
              onChange={(e) =>
                setOpts((o) => ({ ...o, depth: clamp(Number(e.target.value), 6, 30) }))
              }
              disabled={running}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Lines (MultiPV)</span>
            <input
              type="number"
              min={1}
              max={8}
              value={opts.multipv}
              onChange={(e) =>
                setOpts((o) => ({ ...o, multipv: clamp(Number(e.target.value), 1, 8) }))
              }
              disabled={running}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Flag threshold (cp)</span>
            <input
              type="number"
              min={0}
              max={500}
              value={opts.flagThresholdCp}
              onChange={(e) =>
                setOpts((o) => ({
                  ...o,
                  flagThresholdCp: clamp(Number(e.target.value), 0, 500),
                }))
              }
              disabled={running}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
            />
          </label>
        </div>
        <div className="flex gap-2 mt-3">
          <Btn variant="primary" onClick={start} disabled={running}>
            {running ? 'Running…' : 'Run health check'}
          </Btn>
          {running && <Btn onClick={cancel}>Cancel</Btn>}
        </div>
      </Card>

      {progress && (
        <Card title="Progress">
          <div className="text-xs text-slate-400 mb-1">
            {progress.done} / {progress.total} moves analyzed
            {progress.current && (
              <span className="ml-2 text-slate-300 font-mono">{progress.current.san}</span>
            )}
          </div>
          <div className="h-2 w-full rounded bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-emerald-600 transition-all"
              style={{
                width: progress.total
                  ? `${Math.round((progress.done / progress.total) * 100)}%`
                  : '0%',
              }}
            />
          </div>
        </Card>
      )}

      {(results || (progress && progress.flagged.length > 0)) && (
        <Card title={`Flagged moves (${flagged.length})`}>
          {flagged.length === 0 ? (
            <p className="text-xs text-slate-500">
              {results ? 'No moves flagged. Repertoire looks clean.' : 'No flags yet.'}
            </p>
          ) : (
            <FlaggedTable assessments={flagged} repertoireRoot={active.rootFenKey} />
          )}
        </Card>
      )}
    </div>
  );
}

function FlaggedTable({
  assessments,
}: {
  assessments: MoveAssessment[];
  repertoireRoot: string;
}) {
  return (
    <div className="overflow-x-auto -mx-3 px-3">
      <table className="w-full text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="text-left py-1">Move</th>
            <th className="text-right py-1">Δ cp</th>
            <th className="text-left py-1">Engine prefers</th>
            <th className="text-left py-1">Reason</th>
          </tr>
        </thead>
        <tbody>
          {assessments.map((a) => (
            <tr key={a.move.id} className="border-t border-slate-800">
              <td className="py-1 font-mono">{a.move.san}</td>
              <td className="py-1 text-right font-mono">
                {a.deltaCp != null ? a.deltaCp.toFixed(0) : '—'}
              </td>
              <td className="py-1 font-mono text-slate-300">
                {a.engineBestUci ? uciToSan(a.parent.fullFen, a.engineBestUci) : '—'}
              </td>
              <td className="py-1 text-slate-400">
                {a.notInTopN
                  ? 'Not in engine top lines'
                  : a.deltaCp != null
                    ? `${a.deltaCp.toFixed(0)} cp worse than top`
                    : 'Mate seen by engine'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function uciToSan(fen: string, uci: string): string {
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined,
    });
    return m?.san ?? uci;
  } catch {
    return uci;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
