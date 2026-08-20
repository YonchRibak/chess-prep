import { useEffect, useMemo, useState } from 'react';
import {
  fenTurn,
  isUserMove,
  mergeDrillRules,
  type Color,
  type DrillMode,
  type DrillRules,
} from '@chess-prep/shared';
import { useAppStore } from '../store/app.ts';
import { Btn, Card } from '../components/ui.tsx';
import { buildDrillQueue } from '../lib/drill/queue.ts';
import { getAllCardsLocal, mergeCardsLocal } from '../lib/idb/schema.ts';
import { pullAll } from '../lib/srs/sync.ts';

const MODES: { value: DrillMode; label: string; hint: string }[] = [
  { value: 'due', label: 'Due cards', hint: 'Just the cards SRS has scheduled for today.' },
  { value: 'walkthrough', label: 'Full-line walkthrough', hint: 'Walk the main line of the repertoire.' },
  { value: 'weak', label: 'Weak spots', hint: 'Most-lapsed and least-stable cards first.' },
  { value: 'random', label: 'Random position', hint: 'Random card from the whole tree.' },
];

export function DrillSetup() {
  const active = useAppStore((s) => s.active);
  const go = useAppStore((s) => s.go);
  const patchRules = useAppStore((s) => s.patchDrillRules);

  const [mode, setMode] = useState<DrillMode>('due');
  const [rules, setRules] = useState<Required<DrillRules>>(
    mergeDrillRules(active?.drillRules),
  );
  const [cardCount, setCardCount] = useState<number | null>(null);
  const [dueCount, setDueCount] = useState<number | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  // Initialize rules from the active repertoire whenever it changes.
  useEffect(() => {
    if (active) setRules(mergeDrillRules(active.drillRules));
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pull fresh cards on entry; compute due-count locally.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      setPulling(true);
      setPullError(null);
      try {
        await pullAll(active.id);
      } catch (e) {
        setPullError(e instanceof Error ? e.message : 'Sync failed (offline?)');
      } finally {
        if (!cancelled) setPulling(false);
      }

      // Count user-color move cards in this repertoire.
      const allCards = await getAllCardsLocal();
      const moveIds = new Set(
        active.moves
          .filter((m) => {
            const parent = active.positions.find((p) => p.id === m.parentPositionId);
            return parent
              ? isUserMove(fenTurn(parent.fullFen), active.color as Color)
              : false;
          })
          .map((m) => m.id),
      );
      const repCards = allCards.filter((c) => moveIds.has(c.moveId));
      if (cancelled) return;
      setCardCount(repCards.length);
      const now = Date.now();
      setDueCount(repCards.filter((c) => new Date(c.due).getTime() <= now).length);
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live queue length preview based on current settings.
  const [previewLen, setPreviewLen] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      const cards = await getAllCardsLocal();
      if (cancelled) return;
      const q = buildDrillQueue({
        repertoire: active,
        cards,
        mode,
        rules,
      });
      setPreviewLen(q.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [active, mode, rules]);

  const startDisabled = useMemo(() => previewLen === 0, [previewLen]);

  if (!active) {
    return (
      <p className="text-slate-400 text-sm">
        No repertoire selected.{' '}
        <button className="underline" onClick={() => go({ kind: 'list' })}>
          Back
        </button>
      </p>
    );
  }

  async function saveRulesAndContinue(targetView: 'session' | null) {
    if (!active) return;
    if (rulesDiffer(rules, mergeDrillRules(active.drillRules))) {
      await patchRules(active.id, rules);
    }
    if (targetView === 'session') go({ kind: 'drill-session', repertoireId: active.id, mode });
  }

  return (
    <div className="w-full max-w-3xl flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <button
            onClick={() => go({ kind: 'list' })}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            ← All repertoires
          </button>
          <h2 className="text-lg font-semibold">Drill: {active.name}</h2>
          <span className="text-xs text-slate-500">
            {active.color === 'white' ? '♔ White' : '♚ Black'}
          </span>
        </div>
        <button
          onClick={() => go({ kind: 'editor', repertoireId: active.id })}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Edit repertoire →
        </button>
      </header>

      {pulling && <p className="text-xs text-slate-400">Syncing cards…</p>}
      {pullError && (
        <p className="text-xs text-amber-300">
          ⚠ {pullError} — using local cards.
        </p>
      )}

      <Card title="Cards">
        <p className="text-sm">
          <span className="font-mono">{cardCount ?? '…'}</span> total ·{' '}
          <span className="font-mono text-emerald-300">{dueCount ?? '…'}</span> due now
        </p>
      </Card>

      <Card title="Mode">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className={`text-left rounded border px-3 py-2 ${
                mode === m.value
                  ? 'border-emerald-600 bg-emerald-900/30'
                  : 'border-slate-700 bg-slate-900 hover:bg-slate-800'
              }`}
            >
              <div className="text-sm font-medium">{m.label}</div>
              <div className="text-[11px] text-slate-400">{m.hint}</div>
            </button>
          ))}
        </div>
      </Card>

      <Card title="Rules">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Min depth (ply)</span>
            <input
              type="number"
              min={0}
              value={rules.minDepth}
              onChange={(e) =>
                setRules((r) => ({ ...r, minDepth: Math.max(0, Number(e.target.value) || 0) }))
              }
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Max depth (ply, 0 = none)</span>
            <input
              type="number"
              min={0}
              value={rules.maxDepth}
              onChange={(e) =>
                setRules((r) => ({ ...r, maxDepth: Math.max(0, Number(e.target.value) || 0) }))
              }
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Branching</span>
            <select
              value={rules.branching}
              onChange={(e) =>
                setRules((r) => ({ ...r, branching: e.target.value as 'all' | 'main_line_only' }))
              }
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5"
            >
              <option value="all">Test all prepped moves</option>
              <option value="main_line_only">Main line only</option>
            </select>
          </label>
          <label className="flex items-center gap-2 mt-6">
            <input
              type="checkbox"
              checked={rules.blindfold}
              onChange={(e) => setRules((r) => ({ ...r, blindfold: e.target.checked }))}
            />
            <span className="text-xs">Blindfold (hide pieces)</span>
          </label>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">
          {previewLen === null
            ? 'Computing queue…'
            : previewLen === 0
              ? 'No cards match — adjust mode or rules.'
              : `${previewLen} cards in this session.`}
        </p>
        <div className="flex gap-2">
          <Btn onClick={() => void saveRulesAndContinue(null)}>Save rules</Btn>
          <Btn
            variant="primary"
            disabled={startDisabled}
            onClick={() => void saveRulesAndContinue('session')}
          >
            Start drill
          </Btn>
        </div>
      </div>
    </div>
  );
}

function rulesDiffer(a: Required<DrillRules>, b: Required<DrillRules>): boolean {
  return (
    a.minDepth !== b.minDepth ||
    a.maxDepth !== b.maxDepth ||
    a.branching !== b.branching ||
    a.blindfold !== b.blindfold ||
    a.evalAfterAnswer !== b.evalAfterAnswer
  );
}
