/**
 * Rehearsal session (Study S5) — the one-click flashcard flow for a study
 * chapter. Layout only: state and side effects live in
 * `lib/rehearse/useRehearseSession.ts`.
 *
 * A fourth drill implementation, on purpose (see srs-drilling.md): the
 * walker's phase machine carries build/guided/lock-in concerns this flow
 * must not inherit. Shared pieces (miss flow, line transition) were extracted
 * so the older three can adopt them later.
 */
import { useEffect } from 'react';
import { useAppStore } from '../store/app.ts';
import { Board } from '../components/Board.tsx';
import { EnginePanel } from '../components/EnginePanel.tsx';
import { ExpandPanel } from '../components/ExpandPanel.tsx';
import { MissPanel } from '../components/MissPanel.tsx';
import { MoveLine } from '../components/MoveLine.tsx';
import { RehearseStrip } from '../components/RehearseStrip.tsx';
import { SessionSummary } from '../components/SessionSummary.tsx';
import { StudyNote } from '../components/StudyNote.tsx';
import { Btn, Card } from '../components/ui.tsx';
import { useRehearseSession } from '../lib/rehearse/useRehearseSession.ts';

export function RehearseSession({
  chapterTag,
  mode,
}: {
  chapterTag?: string;
  mode: 'cards' | 'expand';
}) {
  const active = useAppStore((s) => s.active);
  const go = useAppStore((s) => s.go);
  if (!active) return <p className="text-slate-500 text-sm">Loading…</p>;
  return (
    <Session key={active.id} chapterTag={chapterTag} mode={mode} onExit={() => go({ kind: 'studies' })} />
  );
}

function Session({
  chapterTag,
  mode,
  onExit,
}: {
  chapterTag?: string;
  mode: 'cards' | 'expand';
  onExit: () => void;
}) {
  // The session's queue is built once from the repertoire loaded at start; the
  // store's `active` is re-read inside the hook where freshness matters.
  const repertoire = useAppStore((s) => s.active)!;
  const s = useRehearseSession({ repertoire, chapterTag, initialMode: mode });
  const { phase, actions } = s;
  const chapterName = chapterTag
    ? (repertoire.source?.chapters.find((c) => c.tag === chapterTag)?.name ?? chapterTag)
    : 'Whole study';

  /* keyboard */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (phase.kind === 'miss' && phase.stage === 'note') actions.dismissNote();
          else if (phase.kind === 'correct' && phase.showNote) actions.dismissNote();
          else if (phase.kind === 'summary') {
            if (s.missed.length > 0) actions.rehearseMisses();
            else actions.restart();
          }
          else if (phase.kind === 'expand' && phase.step === 'done') actions.leaveExpand();
          break;
        case 'n':
        case 'N':
          actions.skip();
          break;
        case 'h':
        case 'H':
          actions.hint();
          break;
        case 'e':
        case 'E':
          if (phase.kind === 'expand') actions.leaveExpand();
          else actions.enterExpand();
          break;
        case 'Escape':
          onExit();
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, actions, s.missed.length, onExit]);

  const cardIndex =
    phase.kind === 'prompt' || phase.kind === 'correct' || phase.kind === 'miss' || phase.kind === 'transition'
      ? phase.index
      : null;
  const expanding = phase.kind === 'expand';

  return (
    <div className="w-full max-w-5xl flex flex-col gap-3">
      <RehearseStrip
        title={repertoire.name}
        subtitle={chapterName}
        position={cardIndex}
        total={s.items.length}
        stats={s.stats}
        expanding={expanding}
        evalAfterAnswer={s.evalAfterAnswer}
        sound={s.sound}
        fullReplay={s.fullReplay}
        onToggleExpand={expanding ? actions.leaveExpand : actions.enterExpand}
        onToggleEval={actions.toggleEvalAfterAnswer}
        onToggleSound={actions.toggleSound}
        onToggleFullReplay={actions.toggleFullReplay}
        onExit={onExit}
      />

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="w-full lg:w-[min(640px,60vw)] flex flex-col gap-2">
          <Board
            rules={s.rules}
            orientation={s.heroColor}
            movableColor={s.boardMovable}
            shapes={s.shapes}
            animationMs={s.transition.animationMs}
            onMovePlayed={actions.onMovePlayed}
          />
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <button
              onClick={actions.replayLine}
              disabled={
                s.replaying ||
                !(phase.kind === 'prompt' || (phase.kind === 'expand' && phase.step === 'pick'))
              }
              className="rounded border border-slate-800 px-2 py-1 text-slate-400 hover:text-slate-200 disabled:opacity-40"
              title="Replay how this position is reached, from the start"
            >
              {s.replaying ? 'Replaying…' : '▶ Replay line'}
            </button>
            <button
              onClick={actions.toggleShowLine}
              aria-pressed={s.showLine}
              className={`rounded border px-2 py-1 ${
                s.showLine
                  ? 'border-slate-600 text-slate-200'
                  : 'border-slate-800 text-slate-500 hover:text-slate-300'
              }`}
              title="Show the moves of the current line"
            >
              {s.showLine ? 'Hide moves' : 'Show moves'}
            </button>
            {s.showLine && <MoveLine sans={s.rules.history.map((m) => m.san)} className="ml-1" />}
          </div>
        </div>

        <aside className="w-full lg:flex-1 flex flex-col gap-3 text-sm">
          {phase.kind === 'loading' && (
            <Card>
              <p className="text-slate-400">Shuffling {chapterName}…</p>
            </Card>
          )}

          {phase.kind === 'transition' && (
            <Card>
              <p className="text-slate-500">Next position…</p>
            </Card>
          )}

          {phase.kind === 'prompt' && s.currentItem && (
            <Card title="Your move">
              <p className="text-slate-300">
                {s.heroToMove ? 'Play your prepared move.' : 'Waiting…'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Ply {s.currentItem.depth + 1}
                {s.currentItem.card.reps > 0 ? ` · seen ${s.currentItem.card.reps}×` : ' · new'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Btn variant="ghost" onClick={actions.hint} disabled={phase.hint}>
                  {phase.hint ? 'Piece marked' : 'Hint'} <kbd className="ml-1 text-[10px] text-slate-500">H</kbd>
                </Btn>
                <Btn variant="ghost" onClick={actions.skip}>
                  Skip <kbd className="ml-1 text-[10px] text-slate-500">N</kbd>
                </Btn>
              </div>
            </Card>
          )}

          {phase.kind === 'correct' && s.currentItem && (
            <>
              <Card title="✓ Correct">
                <p className="text-slate-300">
                  <span className="font-mono font-medium text-emerald-300">{s.currentItem.move.san}</span>
                  {phase.showNote ? '' : ' — next…'}
                </p>
                {s.currentItem.move.comment?.trim() && !phase.showNote && (
                  <div className="mt-2">
                    <Btn variant="ghost" onClick={actions.showNote}>
                      Show note
                    </Btn>
                  </div>
                )}
              </Card>
              {phase.showNote && (
                <StudyNote
                  san={s.currentItem.move.san}
                  note={s.currentItem.move.comment?.trim() ?? ''}
                  onContinue={actions.dismissNote}
                />
              )}
              {s.engineOn && (
                <EnginePanel
                  fen={s.rules.fen}
                  progress={s.engine.progress}
                  ready={s.engine.ready}
                  error={s.engine.error}
                  enabled
                  onToggleEnabled={() => {}}
                  hideToggle
                  showLines={false}
                />
              )}
            </>
          )}

          {phase.kind === 'miss' && s.currentItem && phase.stage === 'note' && (
            <StudyNote san={s.currentItem.move.san} note={phase.note ?? ''} onContinue={actions.dismissNote} />
          )}
          {phase.kind === 'miss' && s.currentItem && phase.stage !== 'note' && (
            <MissPanel
              repertoireId={repertoire.id}
              parentFullFen={s.currentItem.parentFullFen}
              correctSan={s.currentItem.move.san}
              userSan={phase.userSan}
              stage={phase.stage}
              interference={phase.interference}
              onSkip={actions.skip}
            />
          )}

          {phase.kind === 'expand' && (
            <ExpandPanel
              phase={phase}
              fen={s.rules.fen}
              targetNumber={phase.targetIndex + 1}
              targetTotal={s.expandTargets.length}
              deviation={s.deviation}
              engine={s.engine}
              showSuggestions={s.showSuggestions}
              onToggleSuggestions={actions.toggleSuggestions}
              onChoose={actions.chooseDeviation}
              onUndoDeviation={actions.undoDeviation}
              onSkip={actions.skip}
              onBack={actions.leaveExpand}
            />
          )}

          {phase.kind === 'summary' && (
            <SessionSummary
              stats={s.stats}
              missedItems={s.missed.map((i) => s.items[i]!).filter(Boolean)}
              empty={s.items.length === 0}
              onRehearseMisses={actions.rehearseMisses}
              onAgain={actions.restart}
              onExpand={actions.enterExpand}
              onExit={onExit}
            />
          )}

          <p className="text-[10px] text-slate-600">
            ↵/Space continue · N skip · H hint · E expand · Esc exit
          </p>
        </aside>
      </div>
    </div>
  );
}
