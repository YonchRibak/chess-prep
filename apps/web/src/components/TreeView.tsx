/**
 * Variation tree + breadcrumb, shared by the repertoire editor and the study
 * browser (S4). Presentational: the owner holds the current position and
 * handles navigation.
 */
import { useMemo } from 'react';
import type { RepertoireFull, RepertoireMove } from '../api/client.ts';
import { flattenTree, type TreeIndices } from '../lib/tree/treeIndex.ts';

export function TreeView({
  active,
  indices,
  currentMoveId,
  onNavigate,
}: {
  active: RepertoireFull;
  indices: TreeIndices;
  currentMoveId: string | null;
  onNavigate: (fenKey: string, moveId: string) => void;
}) {
  const tokens = useMemo(() => flattenTree(active, indices), [active, indices]);
  if (tokens.length === 0) {
    return <p className="text-xs text-slate-500">No moves yet.</p>;
  }
  return (
    <div className="text-xs font-mono leading-relaxed flex flex-wrap gap-x-1 gap-y-0.5">
      {tokens.map((t, i) => {
        if (t.kind === 'open-var') {
          return (
            <span key={i} className="text-slate-500">
              (
            </span>
          );
        }
        if (t.kind === 'close-var') {
          return (
            <span key={i} className="text-slate-500">
              )
            </span>
          );
        }
        const m = t.move!;
        const isCurrent = m.id === currentMoveId;
        const label =
          (t.needsNumberLabel
            ? t.isWhite
              ? `${t.fullMoveNumber}. `
              : `${t.fullMoveNumber}... `
            : '') + m.san;
        // Dropped edges (user "won't cover", or a study's demoted alternate)
        // and shadow lines stay visible but visibly not-prep.
        const muted = m.isDropped || m.isRefutation;
        return (
          <button
            key={i}
            onClick={() => onNavigate(m.childFenKey, m.id)}
            title={
              m.isRefutation
                ? 'Refutation shadow line'
                : m.isDropped
                  ? 'Not rehearsed (dropped / alternate)'
                  : m.comment ?? undefined
            }
            className={`px-1 rounded ${
              isCurrent
                ? 'bg-emerald-700 text-white'
                : muted
                  ? 'text-slate-600 line-through decoration-slate-700 hover:bg-slate-800'
                  : m.isMainLine
                    ? 'hover:bg-slate-800'
                    : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            {label}
            {m.annotation ? m.annotation : ''}
            {m.comment && !isCurrent ? <span className="text-slate-500">*</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function PathBreadcrumb({
  path,
  rootFenKey,
  currentFenKey,
  onJump,
}: {
  path: RepertoireMove[];
  rootFenKey: string;
  currentFenKey: string;
  onJump: (fenKey: string, moveId: string | null) => void;
}) {
  if (path.length === 0) {
    return <p className="text-xs text-slate-500">Starting position.</p>;
  }
  return (
    <ol className="flex flex-wrap gap-x-2 gap-y-1 text-xs font-mono">
      <li>
        <button
          onClick={() => onJump(rootFenKey, null)}
          className={`hover:text-emerald-300 ${currentFenKey === rootFenKey ? 'text-emerald-300' : ''}`}
        >
          start
        </button>
      </li>
      {path.map((m, i) => (
        <li key={m.id}>
          <button
            onClick={() => onJump(m.childFenKey, m.id)}
            className={`hover:text-emerald-300 ${currentFenKey === m.childFenKey ? 'text-emerald-300' : ''}`}
          >
            {i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : ''}
            {m.san}
          </button>
        </li>
      ))}
    </ol>
  );
}
