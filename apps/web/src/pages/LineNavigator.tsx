/**
 * Flow F1: the line navigator — "which line tonight?" as navigation, not
 * settings.
 *
 * Reached from a repertoire's Drill/Build buttons. Shows every named line and
 * tag present in the tree with live badges (due / cards / to-build / recent
 * misses); tapping Start launches a walker session scoped to that line —
 * session-scoped only, never written to the stored `drillRules`, so a
 * one-night focus can't reshape tomorrow's daily diet.
 */
import { useEffect, useState } from 'react';
import type { LineScope } from '@chess-prep/shared';
import { useAppStore } from '../store/app.ts';
import { Btn, Card } from '../components/ui.tsx';
import { getAllCardsLocal, getAttemptsLocal } from '../lib/idb/schema.ts';
import { ensureOpeningNames, openingNameLookup } from '../lib/openings/nameCache.ts';
import { buildIndices } from '../lib/walker/walker.ts';
import { buildLineIndex, type LineNavEntry } from '../lib/lines/lineIndex.ts';

interface LineNavigatorProps {
  intent: 'train' | 'grow';
}

export function LineNavigator({ intent }: LineNavigatorProps) {
  const active = useAppStore((s) => s.active);
  const go = useAppStore((s) => s.go);

  const [entries, setEntries] = useState<LineNavEntry[] | null>(null);
  const [namesWarm, setNamesWarm] = useState(true);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      // Warm the name cache now so an `openingName` start is never cold-empty.
      const names = await ensureOpeningNames([active]);
      if (cancelled) return;
      const cards = await getAllCardsLocal();
      const attempts = await getAttemptsLocal();
      if (cancelled) return;
      // Cold cache = no position resolves to a name. Fail closed with a hint
      // (below) rather than silently showing zero name rows as if the
      // repertoire had no named lines.
      setNamesWarm(active.positions.some((p) => names.has(p.fenKey)));
      setEntries(
        buildLineIndex({
          repertoire: active,
          indices: buildIndices(active),
          openingLookup: openingNameLookup(names),
          cards,
          attempts,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

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

  function start(scope: LineScope) {
    if (!active) return;
    go({
      kind: 'walker-session',
      repertoireId: active.id,
      seed: intent === 'train' ? 'drill' : 'build',
      ...(scope.kind === 'all' ? {} : { scope }),
    });
  }

  const all = entries?.[0];
  const nameEntries = entries?.filter((e) => e.scope.kind === 'openingName') ?? [];
  const tagEntries = entries?.filter((e) => e.scope.kind === 'tag') ?? [];

  return (
    <div className="w-full max-w-3xl flex flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <button
            onClick={() => go({ kind: 'list' })}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            ← All repertoires
          </button>
          <h2 className="text-lg font-semibold">
            {intent === 'train' ? 'Train' : 'Grow'}: {active.name}
          </h2>
          <span className="text-xs text-slate-500">
            {active.color === 'white' ? '♔ White' : '♚ Black'}
          </span>
        </div>
        <Btn onClick={() => go({ kind: 'editor', repertoireId: active.id })}>
          Open editor
        </Btn>
      </header>

      {!entries && <p className="text-slate-400 text-sm">Indexing lines…</p>}

      {entries && all && (
        <Card>
          <LineRow entry={all} intent={intent} prominent onStart={() => start(all.scope)} />
        </Card>
      )}

      {entries && nameEntries.length > 0 && (
        <Card title="By opening">
          <ul className="flex flex-col">
            {nameEntries.map((e) => (
              <LineRow
                key={`name:${e.scope.value}`}
                entry={e}
                intent={intent}
                onStart={() => start(e.scope)}
              />
            ))}
          </ul>
        </Card>
      )}

      {entries && !namesWarm && active.positions.length > 1 && (
        <p className="text-xs text-amber-300">
          Opening names aren't cached yet — go online once so lines can be listed
          by name. Tags and "All lines" still work.
        </p>
      )}

      {entries && tagEntries.length > 0 && (
        <Card title="By tag">
          <ul className="flex flex-col">
            {tagEntries.map((e) => (
              <LineRow
                key={`tag:${e.scope.value}`}
                entry={e}
                intent={intent}
                onStart={() => start(e.scope)}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function LineRow({
  entry,
  intent,
  prominent,
  onStart,
}: {
  entry: LineNavEntry;
  intent: 'train' | 'grow';
  prominent?: boolean;
  onStart: () => void;
}) {
  const actionable = intent === 'train' ? entry.dueCount > 0 : entry.toBuild > 0;
  return (
    <li
      className="flex items-center gap-2 py-1.5 list-none"
      style={{ paddingLeft: `${entry.depth * 16}px` }}
    >
      <span className={`flex-1 truncate text-sm ${prominent ? 'font-semibold' : ''}`}>
        {entry.scope.kind === 'tag' ? <span className="text-slate-500">tag: </span> : null}
        {entry.label}
      </span>
      <span className="flex items-center gap-1.5 text-[10px] font-mono shrink-0">
        <span
          className={
            entry.dueCount > 0
              ? 'px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-200 border border-emerald-800'
              : 'px-1.5 py-0.5 rounded bg-slate-800 text-slate-400'
          }
        >
          {entry.dueCount} due
        </span>
        <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
          {entry.cardCount} card{entry.cardCount === 1 ? '' : 's'}
        </span>
        {entry.toBuild > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200 border border-amber-800/60">
            {entry.toBuild} to build
          </span>
        )}
        {entry.recentMisses > 0 && (
          <span
            className="px-1.5 py-0.5 rounded bg-rose-900/40 text-rose-200 border border-rose-800/60"
            title="Moves missed recently (last two weeks)"
          >
            ⚠ {entry.recentMisses}
          </span>
        )}
      </span>
      <Btn
        variant={prominent || actionable ? 'primary' : 'default'}
        onClick={onStart}
      >
        Start
      </Btn>
    </li>
  );
}
