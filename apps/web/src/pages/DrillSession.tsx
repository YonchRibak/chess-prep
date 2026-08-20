import { useEffect, useRef, useState } from 'react';
import {
  Grade,
  mergeDrillRules,
  type DrillMode,
} from '@chess-prep/shared';
import { useAppStore } from '../store/app.ts';
import { useChessRules } from '../lib/chess/useChessRules.ts';
import { Board } from '../components/Board.tsx';
import { Btn, Card } from '../components/ui.tsx';
import { buildDrillQueue, type DrillItem } from '../lib/drill/queue.ts';
import { getAllCardsLocal } from '../lib/idb/schema.ts';
import { ensureOpeningNames, openingNameLookup } from '../lib/openings/nameCache.ts';
import { gradeAndQueue } from '../lib/srs/sync.ts';
import { getEngine } from '../lib/engine/engine.ts';
import type { BoardColor } from '../lib/chess/useBoard.ts';

type Phase =
  | { kind: 'loading' }
  | { kind: 'prompt'; index: number }
  | { kind: 'correct'; index: number }
  | { kind: 'wrong'; index: number; userSan: string }
  | { kind: 'complete' };

// Flow timings — tuned so the user sees their move land and the opponent
// reply animate without feeling laggy. Tweak in one place.
const CORRECT_PAUSE_MS = 300;
const OPPONENT_PAUSE_MS = 350;
const WRONG_REVEAL_MS = 1600;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

export function DrillSession() {
  const active = useAppStore((s) => s.active);
  const view = useAppStore((s) => s.view);
  const go = useAppStore((s) => s.go);

  // Pin the mode for the duration of the session — the view carries it from
  // DrillSetup; default to 'due' if we somehow arrived without one.
  const modeRef = useRef<DrillMode>(
    view.kind === 'drill-session' ? view.mode : 'due',
  );

  const [queue, setQueue] = useState<DrillItem[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [stats, setStats] = useState({ correct: 0, wrong: 0 });

  // ONE persistent rules instance for the whole session. In walkthrough mode
  // the board flows continuously through user move → opponent reply → next
  // card; in other modes the board snap-loads each card's parent FEN.
  const rules = useChessRules();

  // Cancel any in-flight transition if the session is torn down or restarted.
  const transitionAbortRef = useRef<AbortController | null>(null);

  // Phase 8b: gate the engine while the drill session is mounted. The hard
  // guarantee is at the engine module — even if a stale `useEngine` somewhere
  // else tries to analyze, it can't while the gate is on.
  useEffect(() => {
    const engine = getEngine();
    engine.setGated(true);
    return () => {
      engine.setGated(false);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      const cards = await getAllCardsLocal();
      if (cancelled) return;
      const drillRules = mergeDrillRules(active.drillRules);
      // Phase 9a: the same name cache the setup screen previewed with, so the
      // session's queue matches the count the user saw before starting.
      const names = await ensureOpeningNames([active]);
      if (cancelled) return;
      const q = buildDrillQueue({
        repertoire: active,
        cards,
        mode: modeRef.current,
        rules: drillRules,
        openingLookup: openingNameLookup(names),
      });
      if (cancelled) return;
      setQueue(q);
      const first = q[0];
      if (!first) {
        setPhase({ kind: 'complete' });
      } else {
        rules.load(first.parentPosition.fullFen);
        setPhase({ kind: 'prompt', index: 0 });
      }
    })();
    return () => {
      cancelled = true;
      transitionAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

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

  const mode = modeRef.current;
  const drillRulesMerged = mergeDrillRules(active.drillRules);
  const currentIndex =
    phase.kind === 'prompt' || phase.kind === 'correct' || phase.kind === 'wrong'
      ? phase.index
      : -1;
  const item = queue && currentIndex >= 0 ? queue[currentIndex] : null;

  function advanceTo(nextIndex: number) {
    if (!queue) return;
    const nextItem = queue[nextIndex];
    if (!nextItem) {
      setPhase({ kind: 'complete' });
      return;
    }
    const nextParent = nextItem.parentPosition.fullFen;
    // Walkthrough flow leaves the board already at the right position; other
    // modes need a snap-load because consecutive cards aren't connected.
    if (rules.fen !== nextParent) {
      rules.load(nextParent);
    }
    setPhase({ kind: 'prompt', index: nextIndex });
  }

  async function runCorrect(it: DrillItem, idx: number, signal: AbortSignal) {
    setPhase({ kind: 'correct', index: idx });
    setStats((s) => ({ ...s, correct: s.correct + 1 }));
    void gradeAndQueue(it.card, Grade.Good);
    await sleep(CORRECT_PAUSE_MS, signal);
    if (mode === 'walkthrough' && it.opponentResponseSan && !rules.isGameOver) {
      rules.playSan(it.opponentResponseSan);
      await sleep(OPPONENT_PAUSE_MS, signal);
    }
    advanceTo(idx + 1);
  }

  async function runWrong(
    it: DrillItem,
    idx: number,
    userSan: string,
    signal: AbortSignal,
  ) {
    setPhase({ kind: 'wrong', index: idx, userSan });
    setStats((s) => ({ ...s, wrong: s.wrong + 1 }));
    void gradeAndQueue(it.card, Grade.Again);
    await sleep(WRONG_REVEAL_MS, signal);
    if (mode === 'walkthrough') {
      // Demonstrate the correct line so the visual flow stays coherent.
      rules.playSan(it.move.san);
      await sleep(OPPONENT_PAUSE_MS, signal);
      if (it.opponentResponseSan && !rules.isGameOver) {
        rules.playSan(it.opponentResponseSan);
        await sleep(OPPONENT_PAUSE_MS, signal);
      }
    }
    advanceTo(idx + 1);
  }

  function startTransition(): AbortController {
    transitionAbortRef.current?.abort();
    const ctl = new AbortController();
    transitionAbortRef.current = ctl;
    return ctl;
  }

  async function handleMovePlayed(san: string) {
    if (phase.kind !== 'prompt' || !item) return;
    const idx = currentIndex;
    const correct = san === item.move.san;
    const ctl = startTransition();
    try {
      if (correct) {
        await runCorrect(item, idx, ctl.signal);
      } else {
        // Snap-back the wrong move so the board returns to the prompt position
        // while we show the expected move and grade Again.
        rules.undo();
        await runWrong(item, idx, san, ctl.signal);
      }
    } catch {
      /* aborted */
    }
  }

  async function handleShowAnswer() {
    if (phase.kind !== 'prompt' || !item) return;
    const idx = currentIndex;
    const ctl = startTransition();
    try {
      await runWrong(item, idx, '', ctl.signal);
    } catch {
      /* aborted */
    }
  }

  // Movable color is enabled only during the prompt; correct/wrong phases lock
  // the board so a fast user can't fire a second move into the transition.
  const movable: BoardColor | null =
    phase.kind === 'prompt' ? ((rules.turn === 'w' ? 'white' : 'black') as BoardColor) : null;

  return (
    <div className="w-full max-w-5xl flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <button
            onClick={() => go({ kind: 'drill-setup', repertoireId: active.id })}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            ← Drill setup
          </button>
          <h2 className="text-lg font-semibold">Drilling: {active.name}</h2>
          <span className="text-xs text-slate-500">
            {modeLabel(mode)} · Card{' '}
            {currentIndex >= 0 ? currentIndex + 1 : queue?.length ?? 0} of{' '}
            {queue?.length ?? 0}
          </span>
        </div>
        <ProgressBar
          done={stats.correct + stats.wrong}
          total={queue?.length ?? 0}
          correct={stats.correct}
          wrong={stats.wrong}
        />
      </header>

      {phase.kind === 'loading' && <p className="text-slate-400">Building queue…</p>}

      {phase.kind === 'complete' && (
        <CompletePane stats={stats} totalCards={queue?.length ?? 0} />
      )}

      {item && phase.kind !== 'loading' && phase.kind !== 'complete' && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6">
          <div className="flex flex-col items-center gap-3 w-full">
            <div
              className={`w-full max-w-[640px] ${
                drillRulesMerged.blindfold ? 'opacity-0 pointer-events-none' : ''
              }`}
            >
              <Board
                rules={rules}
                orientation={active.color as BoardColor}
                movableColor={movable}
                onMovePlayed={handleMovePlayed}
              />
            </div>
            {drillRulesMerged.blindfold && (
              <BlindfoldPanel parentFullFen={item.parentPosition.fullFen} />
            )}
            <p className="text-[10px] text-slate-500 font-mono break-all max-w-full">
              {item.parentPosition.fullFen}
            </p>
          </div>

          <aside className="flex flex-col gap-3 text-sm">
            <Card title={`Card ${currentIndex + 1}`}>
              <p className="text-xs text-slate-400">
                Depth: <span className="font-mono">{item.depth}</span> · Reps:{' '}
                <span className="font-mono">{item.card.reps}</span> · Lapses:{' '}
                <span className="font-mono">{item.card.lapses}</span>
              </p>
            </Card>

            {item.move.comment && (
              <Card title="Comment">
                <p className="text-xs">{item.move.comment}</p>
              </Card>
            )}

            {phase.kind === 'prompt' && (
              <Card title="Your move">
                <p className="text-xs text-slate-400">
                  Play your prepared move. Stuck?
                </p>
                <div className="flex gap-2 pt-2">
                  <Btn onClick={handleShowAnswer}>Show answer</Btn>
                </div>
              </Card>
            )}

            {phase.kind === 'correct' && (
              <Card title="✓ Correct">
                <p className="text-sm">
                  <span className="font-mono font-medium">{item.move.san}</span>
                  {item.move.annotation && (
                    <span className="ml-1 text-amber-300">{item.move.annotation}</span>
                  )}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {mode === 'walkthrough' && item.opponentResponseSan
                    ? `Opponent: ${item.opponentResponseSan} → next card…`
                    : 'Next card…'}
                </p>
              </Card>
            )}

            {phase.kind === 'wrong' && (
              <Card title="✗ Expected">
                <p className="text-sm">
                  <span className="font-mono font-medium">{item.move.san}</span>
                  {item.move.annotation && (
                    <span className="ml-1 text-amber-300">{item.move.annotation}</span>
                  )}
                </p>
                {phase.userSan && (
                  <p className="text-xs text-slate-400 mt-1">
                    You played: <span className="font-mono">{phase.userSan}</span>
                  </p>
                )}
                <p className="text-xs text-slate-500 mt-1">Graded Again · next card…</p>
              </Card>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function modeLabel(mode: DrillMode): string {
  switch (mode) {
    case 'due':
      return 'Due';
    case 'walkthrough':
      return 'Walkthrough';
    case 'weak':
      return 'Weak spots';
    case 'random':
      return 'Random';
  }
}

function BlindfoldPanel({ parentFullFen }: { parentFullFen: string }) {
  const parts = parentFullFen.split(' ');
  const turn = parts[1] === 'b' ? 'Black' : 'White';
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-6 text-center w-full max-w-[640px] aspect-square flex flex-col items-center justify-center">
      <p className="text-3xl font-semibold">{turn} to move</p>
      <p className="text-xs text-slate-500 mt-2">Blindfold mode — pieces hidden</p>
      <p className="text-[10px] text-slate-600 font-mono mt-3 break-all">{parentFullFen}</p>
    </div>
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
  totalCards,
}: {
  stats: { correct: number; wrong: number };
  totalCards: number;
}) {
  const go = useAppStore((s) => s.go);
  const active = useAppStore((s) => s.active);
  const total = stats.correct + stats.wrong;
  const pct = total > 0 ? Math.round((stats.correct / total) * 100) : 0;
  return (
    <Card title="Session complete">
      {totalCards === 0 ? (
        <p className="text-sm text-slate-400">No cards matched the current rules.</p>
      ) : (
        <>
          <p className="text-sm">
            {stats.correct} correct of {total} ({pct}%) · {stats.wrong} missed
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Schedules updated; cards pushed to the server in the background.
          </p>
        </>
      )}
      <div className="flex gap-2 mt-3">
        {active && (
          <>
            <Btn onClick={() => go({ kind: 'drill-setup', repertoireId: active.id })}>
              New session
            </Btn>
            <Btn onClick={() => go({ kind: 'editor', repertoireId: active.id })}>
              Edit repertoire
            </Btn>
          </>
        )}
        <Btn onClick={() => go({ kind: 'list' })}>All repertoires</Btn>
      </div>
    </Card>
  );
}
