import { useMemo } from 'react';
import { Chess } from 'chess.js';
import { formatEval, whiteCp } from '../lib/engine/useEngine.ts';
import { colorForRank } from '../lib/engine/arrows.ts';
import type { AnalysisProgress, EngineLine } from '../lib/engine/engine.ts';
import { Card } from './ui.tsx';

interface EnginePanelProps {
  fen: string;
  progress: AnalysisProgress | null;
  ready: boolean;
  error: string | null;
  enabled: boolean;
  onToggleEnabled: () => void;
}

export function EnginePanel({
  fen,
  progress,
  ready,
  error,
  enabled,
  onToggleEnabled,
}: EnginePanelProps) {
  const turn = (fen.split(/\s+/)[1] ?? 'w') as 'w' | 'b';
  const best = progress?.lines[0];

  return (
    <Card title="Engine">
      <div className="flex items-center gap-3">
        <EvalBar line={best} turn={turn} />
        <div className="flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-mono font-medium">
              {best ? formatEval(whiteCp(best, turn)) : '—'}
            </span>
            <span className="text-xs text-slate-500">
              {progress?.done ? 'final' : progress ? `d${progress.depth}` : ''}
            </span>
          </div>
          <div className="text-[10px] text-slate-500">
            {error ? (
              <span className="text-rose-300">{error}</span>
            ) : !ready ? (
              'Starting engine…'
            ) : !enabled ? (
              'Paused'
            ) : progress ? (
              `${progress.lines.length} line${progress.lines.length === 1 ? '' : 's'}`
            ) : (
              'Idle'
            )}
          </div>
        </div>
        <button
          onClick={onToggleEnabled}
          className="text-xs px-2 py-1 rounded border border-slate-700 hover:bg-slate-800"
          title={enabled ? 'Pause engine' : 'Resume engine'}
        >
          {enabled ? '⏸' : '▶'}
        </button>
      </div>

      {progress && progress.lines.length > 0 && (
        <>
          <ul className="mt-3 flex flex-col gap-1">
            {[...progress.lines]
              .sort((a, b) => a.multipv - b.multipv)
              .map((line) => (
                <LineRow key={line.multipv} line={line} fen={fen} turn={turn} />
              ))}
          </ul>
          <ArrowLegend count={progress.lines.length} />
        </>
      )}
    </Card>
  );
}

function EvalBar({ line, turn }: { line: EngineLine | undefined; turn: 'w' | 'b' }) {
  // Convert score to "white share" ∈ [0,1]. cp clamped to ±1000.
  let whiteShare = 0.5;
  if (line) {
    const norm = whiteCp(line, turn);
    if (norm.mate != null) {
      whiteShare = norm.mate >= 0 ? 0.98 : 0.02;
    } else if (norm.cp != null) {
      const clamped = Math.max(-1000, Math.min(1000, norm.cp));
      // Soft logistic-ish: ±500cp → ~85% / 15%.
      whiteShare = 1 / (1 + Math.exp(-clamped / 200));
    }
  }
  const whitePct = Math.round(whiteShare * 100);
  return (
    <div className="relative w-3 h-20 rounded overflow-hidden border border-slate-700 bg-slate-950">
      <div
        className="absolute bottom-0 left-0 right-0 bg-slate-100"
        style={{ height: `${whitePct}%` }}
      />
    </div>
  );
}

const RANK_LABELS = ['Best', '2nd', '3rd', '4th', '5th'];

function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? `${rank + 1}th`;
}

/** Color key tying each board arrow back to its engine line. */
function ArrowLegend({ count }: { count: number }) {
  return (
    <div className="mt-2 pt-2 border-t border-slate-800">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
        Board arrows
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {Array.from({ length: count }, (_, rank) => (
          <li key={rank} className="flex items-center gap-1.5 text-[10px] text-slate-400">
            <Swatch rank={rank} />
            <span>{rankLabel(rank)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A dot in the exact color chessground draws that rank's arrow. */
function Swatch({ rank }: { rank: number }) {
  return (
    <span
      aria-hidden
      className="inline-block w-2.5 h-2.5 rounded-sm border border-slate-600/60"
      style={{ backgroundColor: colorForRank(rank) }}
    />
  );
}

function LineRow({
  line,
  fen,
  turn,
}: {
  line: EngineLine;
  fen: string;
  turn: 'w' | 'b';
}) {
  const sanPv = useMemo(() => uciPvToSan(fen, line.pv, 8), [fen, line.pv]);
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span className="flex items-center gap-1 w-7 shrink-0 text-slate-500">
        <Swatch rank={line.multipv - 1} />
        {line.multipv}.
      </span>
      <span className="font-mono font-medium w-14">
        {formatEval(whiteCp(line, turn))}
      </span>
      <span className="font-mono text-slate-300 truncate">{sanPv}</span>
    </li>
  );
}

/** Convert a UCI PV to a SAN sequence. Truncates after `limit` plies. */
function uciPvToSan(fen: string, uciPv: string[], limit: number): string {
  if (uciPv.length === 0) return '';
  const chess = new Chess(fen);
  const out: string[] = [];
  const fullMoveStart = Number(fen.split(/\s+/)[5] ?? 1);
  const turnStart = (fen.split(/\s+/)[1] ?? 'w') as 'w' | 'b';
  for (let i = 0; i < Math.min(uciPv.length, limit); i++) {
    const uci = uciPv[i]!;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    let moved;
    try {
      moved = chess.move({ from, to, promotion });
    } catch {
      break;
    }
    if (!moved) break;
    const ply = i + (turnStart === 'b' ? 1 : 0);
    if (ply % 2 === 0) {
      const num = fullMoveStart + Math.floor(ply / 2);
      out.push(`${num}.`);
    } else if (i === 0 && turnStart === 'b') {
      out.push(`${fullMoveStart}...`);
    }
    out.push(moved.san);
  }
  return out.join(' ');
}
