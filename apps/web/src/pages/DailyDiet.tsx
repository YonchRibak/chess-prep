/**
 * Phase 8a — Daily Diet (mixed session).
 *
 * One session, due cards across every repertoire matching the chosen side
 * (White / Black / Mixed), interleaved by repertoire so consecutive cards
 * come from different openings. New cards (FSRS state=new) are capped per
 * the user's `newCardsPerDay` setting so a freshly built repertoire doesn't
 * flood the first sessions.
 *
 * Mechanically this is a Drill-seed walker (Phase 7) with multiple source
 * repertoires; we keep this thin and reuse the existing flow:
 *   1. Top-of-page: pick side (W/B/Mixed) + show progress.
 *   2. Body: a board-and-card stack, identical to DrillSession's flow mode.
 *   3. End: short summary + per-opening accuracy breakdown.
 *
 * Engine gating (8b) is handled by the same engine module flip — mounted
 * for the lifetime of this page, regardless of whether a card is unanswered.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import {
  Grade,
  type Color,
} from '@chess-prep/shared';
import { useAppStore } from '../store/app.ts';
import { useChessRules } from '../lib/chess/useChessRules.ts';
import { Board } from '../components/Board.tsx';
import { Btn, Card } from '../components/ui.tsx';
import { OpeningHeader } from '../components/OpeningHeader.tsx';
import { MoveLine } from '../components/MoveLine.tsx';
import { api, type RepertoireFull, type UserSettings } from '../api/client.ts';
import { getAllCardsLocal, putRepertoireLocal } from '../lib/idb/schema.ts';
import { gradeAndQueue } from '../lib/srs/sync.ts';
import { buildDailyDietQueue, type DailyDietItem } from '../lib/drill/queue.ts';
import { getEngine } from '../lib/engine/engine.ts';
import {
  buildIndices,
  findPathToPosition,
  type WalkerIndices,
} from '../lib/walker/walker.ts';
import type { BoardColor } from '../lib/chess/useBoard.ts';

type Side = 'white' | 'black' | 'mixed';

type Phase =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'prompt'; index: number }
  | { kind: 'correct'; index: number }
  | { kind: 'wrong'; index: number; userSan: string; stage: 'reveal' | 'retry' }
  | { kind: 'complete' };

const CORRECT_PAUSE_MS = 300;
const WRONG_REVEAL_MS = 1400;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

export function DailyDiet() {
  const repertoires = useAppStore((s) => s.repertoires);
  const loadList = useAppStore((s) => s.loadList);
  const go = useAppStore((s) => s.go);

  const [side, setSide] = useState<Side>('mixed');
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [queue, setQueue] = useState<DailyDietItem[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [stats, setStats] = useState({ correct: 0, wrong: 0 });
  const [perOpeningStats, setPerOpeningStats] = useState<
    Map<string, { correct: number; wrong: number }>
  >(new Map());

  const rules = useChessRules();
  const transitionAbortRef = useRef<AbortController | null>(null);

  // Full repertoire snapshots + walker indices, keyed by repertoire id — used
  // to replay the board from each repertoire's root so the move list / opening
  // header always show the true line.
  const repsRef = useRef<Map<string, { rep: RepertoireFull; indices: WalkerIndices }>>(
    new Map(),
  );

  /** Load the board at the item's parent position by replaying from the root. */
  function loadTo(it: DailyDietItem) {
    const entry = repsRef.current.get(it.repertoireId);
    if (!entry) {
      rules.load(it.parentPosition.fullFen);
      return;
    }
    const path = findPathToPosition(entry.rep, entry.indices, it.parentPosition.id);
    if (path.length === 0 && it.parentPosition.fenKey !== entry.rep.rootFenKey) {
      rules.load(it.parentPosition.fullFen);
      return;
    }
    rules.load(entry.rep.rootFullFen);
    for (const m of path) {
      if (rules.playSan(m.san) === null) {
        rules.load(it.parentPosition.fullFen);
        return;
      }
    }
  }

  // Phase 8b: gate the engine for the session.
  useEffect(() => {
    const engine = getEngine();
    engine.setGated(true);
    return () => {
      engine.setGated(false);
    };
  }, []);

  // Load the list on mount + bootstrap settings.
  useEffect(() => {
    void loadList();
    void api.getUserSettings().then(setSettings);
  }, [loadList]);

  async function startSession() {
    setPhase({ kind: 'loading' });
    setStats({ correct: 0, wrong: 0 });
    setPerOpeningStats(new Map());

    // Pull full repertoire snapshots for everything matching the side scope.
    const scope = repertoires.filter(
      (r) => side === 'mixed' || (r.color as Color) === side,
    );
    const fulls: RepertoireFull[] = [];
    repsRef.current = new Map();
    for (const r of scope) {
      const full = await api.getRepertoire(r.id);
      void putRepertoireLocal(full);
      fulls.push(full);
      repsRef.current.set(full.id, { rep: full, indices: buildIndices(full) });
    }
    const cards = await getAllCardsLocal();
    const newCap = settings?.newCardsPerDay ?? 20;
    const q = buildDailyDietQueue({
      repertoires: fulls,
      cards,
      newCardsPerDay: newCap,
      dailyResetAt: settings ? new Date(settings.dailyDietLastResetAt) : undefined,
    });

    setQueue(q);
    if (q.length === 0) {
      setPhase({ kind: 'complete' });
      return;
    }
    const first = q[0]!;
    loadTo(first);
    setPhase({ kind: 'prompt', index: 0 });
  }

  const currentItem: DailyDietItem | null = useMemo(() => {
    if (!queue) return null;
    const idx =
      phase.kind === 'prompt' || phase.kind === 'correct' || phase.kind === 'wrong'
        ? phase.index
        : -1;
    return idx >= 0 ? queue[idx] ?? null : null;
  }, [queue, phase]);

  function startTransition(): AbortController {
    transitionAbortRef.current?.abort();
    const ctl = new AbortController();
    transitionAbortRef.current = ctl;
    return ctl;
  }

  function advanceTo(nextIndex: number) {
    if (!queue) return;
    const next = queue[nextIndex];
    if (!next) {
      setPhase({ kind: 'complete' });
      return;
    }
    loadTo(next);
    setPhase({ kind: 'prompt', index: nextIndex });
  }

  function recordPerOpening(repertoireName: string, kind: 'correct' | 'wrong') {
    setPerOpeningStats((prev) => {
      const next = new Map(prev);
      const cur = next.get(repertoireName) ?? { correct: 0, wrong: 0 };
      next.set(repertoireName, {
        correct: cur.correct + (kind === 'correct' ? 1 : 0),
        wrong: cur.wrong + (kind === 'wrong' ? 1 : 0),
      });
      return next;
    });
  }

  async function handleMovePlayed(san: string) {
    if (!currentItem) return;
    const it = currentItem;

    // Retry stage after a miss: only the correct move advances (retrain —
    // playing the right move yourself is where the motor memory comes from).
    if (phase.kind === 'wrong' && phase.stage === 'retry') {
      if (san !== it.move.san) {
        rules.undo();
        return;
      }
      const ctl = startTransition();
      try {
        // Already graded Again on the first miss — no re-grade here.
        setPhase({ kind: 'correct', index: phase.index });
        await sleep(CORRECT_PAUSE_MS, ctl.signal);
        advanceTo(phase.index + 1);
      } catch {
        /* aborted */
      }
      return;
    }

    if (phase.kind !== 'prompt') return;
    const idx = phase.index;
    const correct = san === it.move.san;
    const ctl = startTransition();
    try {
      if (correct) {
        setPhase({ kind: 'correct', index: idx });
        setStats((s) => ({ ...s, correct: s.correct + 1 }));
        recordPerOpening(it.repertoireName, 'correct');
        void gradeAndQueue(it.card, Grade.Good);
        await sleep(CORRECT_PAUSE_MS, ctl.signal);
        advanceTo(idx + 1);
      } else {
        rules.undo();
        setStats((s) => ({ ...s, wrong: s.wrong + 1 }));
        recordPerOpening(it.repertoireName, 'wrong');
        void gradeAndQueue(it.card, Grade.Again);
        // Briefly SHOW the correct move, take it back, then require the user
        // to play it themselves before moving on.
        setPhase({ kind: 'wrong', index: idx, userSan: san, stage: 'reveal' });
        rules.playSan(it.move.san);
        await sleep(WRONG_REVEAL_MS, ctl.signal);
        rules.undo();
        setPhase({ kind: 'wrong', index: idx, userSan: san, stage: 'retry' });
      }
    } catch {
      /* aborted */
    }
  }

  /* ---------------- render ---------------- */

  if (phase.kind === 'loading' && queue === null) {
    return (
      <div className="w-full max-w-5xl flex flex-col gap-4">
        <Setup
          side={side}
          setSide={setSide}
          settings={settings}
          repertoires={repertoires}
          onStart={() => void startSession()}
        />
      </div>
    );
  }

  if (phase.kind === 'complete') {
    return (
      <CompletePane
        stats={stats}
        perOpening={perOpeningStats}
        totalQueue={queue?.length ?? 0}
        onAgain={() => {
          setQueue(null);
          setPhase({ kind: 'setup' });
        }}
        onHome={() => go({ kind: 'list' })}
      />
    );
  }

  if (phase.kind === 'setup' || queue === null) {
    return (
      <div className="w-full max-w-5xl flex flex-col gap-4">
        <Setup
          side={side}
          setSide={setSide}
          settings={settings}
          repertoires={repertoires}
          onStart={() => void startSession()}
        />
      </div>
    );
  }

  const movableColor: BoardColor | null =
    phase.kind === 'prompt' || (phase.kind === 'wrong' && phase.stage === 'retry')
      ? ((rules.turn === 'w' ? 'white' : 'black') as BoardColor)
      : null;

  // Current line straight from the board (we always replay from the root).
  const lineSans = rules.history.map((m) => m.san);
  const headerEntry = currentItem ? repsRef.current.get(currentItem.repertoireId) : undefined;
  const headerPath = (() => {
    if (!headerEntry) return currentItem ? [currentItem.parentPosition.fullFen] : [];
    const fens = [headerEntry.rep.rootFullFen];
    try {
      const chess = new Chess(headerEntry.rep.rootFullFen);
      for (const san of lineSans) {
        chess.move(san);
        fens.push(chess.fen());
      }
    } catch {
      /* partial path is fine */
    }
    return fens;
  })();

  return (
    <div className="w-full max-w-5xl flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <button
            onClick={() => go({ kind: 'list' })}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            ← Home
          </button>
          <h2 className="text-lg font-semibold">Daily diet</h2>
          <span className="text-xs text-slate-500">
            {sideLabel(side)} ·{' '}
            {currentItem ? `${currentItem.repertoireName}` : 'mixed'}
          </span>
        </div>
        <ProgressBar
          done={stats.correct + stats.wrong}
          total={queue.length}
          correct={stats.correct}
          wrong={stats.wrong}
        />
      </header>

      {currentItem && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6">
          <div className="flex flex-col items-center gap-3 w-full">
            <OpeningHeader pathFens={headerPath} className="self-start" />
            <MoveLine sans={lineSans} className="self-start" />
            <Board
              rules={rules}
              orientation={currentItem.repertoireColor as BoardColor}
              movableColor={movableColor}
              onMovePlayed={(san) => void handleMovePlayed(san)}
            />
          </div>

          <aside className="flex flex-col gap-3 text-sm">
            <Card
              title={`Card ${
                phase.kind === 'prompt' || phase.kind === 'correct' || phase.kind === 'wrong'
                  ? phase.index + 1
                  : '?'
              }`}
            >
              <p className="text-xs text-slate-400">
                Depth: <span className="font-mono">{currentItem.depth}</span> · Reps:{' '}
                <span className="font-mono">{currentItem.card.reps}</span> · Repertoire:{' '}
                <span className="font-mono">{currentItem.repertoireName}</span>
              </p>
            </Card>

            {phase.kind === 'prompt' && (
              <Card title="Your move">
                <p className="text-xs text-slate-500">
                  Play your prepared move on the board.
                </p>
              </Card>
            )}

            {phase.kind === 'correct' && (
              <Card title="✓ Correct">
                <p className="text-sm">
                  <span className="font-mono font-medium">{currentItem.move.san}</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">Next card…</p>
              </Card>
            )}

            {phase.kind === 'wrong' && (
              <Card title={phase.stage === 'reveal' ? '✗ Wrong' : 'Play the correct move'}>
                <p className="text-sm">
                  Correct: <span className="font-mono font-medium">{currentItem.move.san}</span>
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  You played: <span className="font-mono">{phase.userSan}</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {phase.stage === 'reveal'
                    ? 'Graded Again — watch the correct move…'
                    : `Now play ${currentItem.move.san} yourself to continue.`}
                </p>
              </Card>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/* ---------------- subcomponents ---------------- */

function Setup({
  side,
  setSide,
  settings,
  repertoires,
  onStart,
}: {
  side: Side;
  setSide: (s: Side) => void;
  settings: UserSettings | null;
  repertoires: { id: string; name: string; color: string }[];
  onStart: () => void;
}) {
  const [savingCap, setSavingCap] = useState(false);
  const [cap, setCap] = useState(settings?.newCardsPerDay ?? 20);
  useEffect(() => {
    if (settings) setCap(settings.newCardsPerDay);
  }, [settings]);

  async function saveCap() {
    setSavingCap(true);
    try {
      await api.patchUserSettings({ newCardsPerDay: cap });
    } finally {
      setSavingCap(false);
    }
  }

  const eligible = repertoires.filter(
    (r) => side === 'mixed' || r.color === side,
  );

  return (
    <Card title="Daily diet">
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-2">
          <span className="text-xs text-slate-400">Scope</span>
          <div className="flex gap-2">
            {(['white', 'black', 'mixed'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`px-3 py-1 rounded border text-xs ${
                  side === s
                    ? 'border-emerald-700 bg-emerald-900/40 text-emerald-200'
                    : 'border-slate-700 hover:bg-slate-800'
                }`}
              >
                {sideLabel(s)}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-500">
            {eligible.length} repertoire{eligible.length === 1 ? '' : 's'} match
            {eligible.length === 1 ? 'es' : ''} this scope.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-xs">
            <span className="text-slate-400">New cards per day</span>
            <input
              type="number"
              min={0}
              max={1000}
              value={cap}
              onChange={(e) => setCap(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
              className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs font-mono"
            />
            <Btn type="button" disabled={savingCap || cap === settings?.newCardsPerDay} onClick={() => void saveCap()}>
              {savingCap ? 'Saving…' : 'Save'}
            </Btn>
          </label>
          <p className="text-[10px] text-slate-500">
            Cards in FSRS "new" state above this cap stay queued; non-new (learning,
            review, relearning) cards aren't capped.
          </p>
        </div>

        <div className="flex justify-end">
          <Btn variant="primary" onClick={onStart} disabled={eligible.length === 0}>
            Start session
          </Btn>
        </div>
      </div>
    </Card>
  );
}

function ProgressBar({
  done,
  total,
  correct,
  wrong,
}: {
  done: number;
  total: number;
  correct: number;
  wrong: number;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono">
        {done} / {total}
      </span>
      <span className="text-emerald-300 font-mono">✓ {correct}</span>
      <span className="text-rose-300 font-mono">✗ {wrong}</span>
    </div>
  );
}

function CompletePane({
  stats,
  perOpening,
  totalQueue,
  onAgain,
  onHome,
}: {
  stats: { correct: number; wrong: number };
  perOpening: Map<string, { correct: number; wrong: number }>;
  totalQueue: number;
  onAgain: () => void;
  onHome: () => void;
}) {
  const total = stats.correct + stats.wrong;
  const pct = total > 0 ? Math.round((stats.correct / total) * 100) : 0;

  // Sort weakest first (highest wrong rate) for "what to focus on next" insight.
  const weakest = [...perOpening.entries()]
    .map(([name, s]) => {
      const tot = s.correct + s.wrong;
      const pct = tot > 0 ? s.wrong / tot : 0;
      return { name, ...s, total: tot, wrongPct: pct };
    })
    .sort((a, b) => b.wrongPct - a.wrongPct);

  return (
    <Card title="Session complete">
      {totalQueue === 0 ? (
        <p className="text-sm text-slate-400">No due cards matched today's scope.</p>
      ) : (
        <>
          <p className="text-sm">
            {stats.correct} correct of {total} ({pct}%) · {stats.wrong} missed
          </p>
          {weakest.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                By repertoire
              </p>
              <ul className="text-xs flex flex-col gap-0.5">
                {weakest.map((w) => (
                  <li key={w.name} className="flex items-center justify-between gap-2">
                    <span>{w.name}</span>
                    <span className="font-mono text-slate-400">
                      {w.correct}/{w.total}
                      {w.wrongPct > 0 && (
                        <span className="text-rose-300 ml-1">
                          (-{Math.round(w.wrongPct * 100)}%)
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="flex gap-2 mt-3">
        <Btn variant="primary" onClick={onAgain}>
          New session
        </Btn>
        <Btn onClick={onHome}>Home</Btn>
      </div>
    </Card>
  );
}

function sideLabel(s: Side): string {
  if (s === 'white') return '♔ White';
  if (s === 'black') return '♚ Black';
  return 'Mixed';
}
