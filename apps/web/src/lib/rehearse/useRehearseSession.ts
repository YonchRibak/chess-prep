/**
 * The rehearsal session's state machine (Study S5) — every side effect of
 * the page lives here; `RehearseSession.tsx` only lays it out.
 *
 * Phases are few on purpose: the session is "click a chapter, play moves".
 *
 *   loading → transition(i) → prompt(i) ─┬─ correct(i) → transition(i+1) …
 *                                        └─ miss(i): reveal → note? → retry → correct(i)
 *   expand: pick → your-move → saving → pick (next branch point) …
 *   summary
 *
 * Engine gating is decided per phase from ONE boolean (`engineOn`) and flows
 * into `useEngine({ gated })`, which flips the module-level gate — the hard
 * guarantee in engine.md. It is on only while no unanswered card is on the
 * board: the expand phases, and the eval-bar pause after a correct answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Grade, fenTurn, isUserMove, mergeDrillRules, type Color } from '@chess-prep/shared';
import type { DrawShape } from 'chessground/draw';
import { api, type BookContinuation, type RepertoireFull } from '../../api/client.ts';
import { useAppStore } from '../../store/app.ts';
import { useChessRules } from '../chess/useChessRules.ts';
import { useLineTransition } from '../chess/useLineTransition.ts';
import { getEngine } from '../engine/engine.ts';
import { useEngine } from '../engine/useEngine.ts';
import { engineArrows } from '../engine/arrows.ts';
import { describeInterference, detectInterference } from '../drill/interference.ts';
import { nextMissStage, runMissReveal, type MissStage } from '../drill/missFlow.ts';
import { getAllCardsLocal, getMeta, setMeta } from '../idb/schema.ts';
import { engineLinesToCandidates, fetchExplorerEntry } from '../openings/candidates.ts';
import { gradeAndQueue, logAttempt, pullSince } from '../srs/sync.ts';
import { buildIndices } from '../walker/walker.ts';
import { isAbort, sleep } from './async.ts';
import {
  collectExpandTargets,
  pickDeviationSource,
  uncoveredReplies,
  type DeviationSource,
  type ExpandTarget,
} from './expand.ts';
import { buildRehearseQueue, type RehearseItem } from './queue.ts';
import { loadSoundPref, saveSoundPref, sounds } from './sounds.ts';
import { CORRECT_PAUSE_MS, WRONG_REVEAL_MS } from './timings.ts';
import type { ExplorerEntry, RankedReply } from '@chess-prep/shared';

export type RehearsePhase =
  | { kind: 'loading' }
  | { kind: 'transition'; index: number }
  | { kind: 'prompt'; index: number; hint: boolean }
  | { kind: 'correct'; index: number; showNote: boolean }
  | {
      kind: 'miss';
      index: number;
      userSan: string;
      stage: MissStage;
      note?: string;
      interference?: string;
    }
  | {
      kind: 'expand';
      step: 'pick' | 'your-move' | 'saving' | 'done';
      targetIndex: number;
      deviationSan?: string;
      error?: string;
    }
  | { kind: 'summary' };

export interface RehearseStats {
  correct: number;
  wrong: number;
  hinted: number;
  skipped: number;
  recorded: number;
  streak: number;
  bestStreak: number;
}

const EMPTY_STATS: RehearseStats = {
  correct: 0,
  wrong: 0,
  hinted: 0,
  skipped: 0,
  recorded: 0,
  streak: 0,
  bestStreak: 0,
};

/** How long the eval bar stays up after a correct answer when the toggle is on. */
const EVAL_PEEK_MS = 1400;
const CUE_MS = 450;

export const lastChapterKey = (repertoireId: string) => `rehearse.last.${repertoireId}`;

export interface UseRehearseSessionArgs {
  repertoire: RepertoireFull;
  chapterTag?: string;
  initialMode: 'cards' | 'expand';
}

export function useRehearseSession({ repertoire, chapterTag, initialMode }: UseRehearseSessionArgs) {
  const heroColor = repertoire.color as 'white' | 'black';
  const rules = useChessRules(repertoire.rootFullFen);
  const transition = useLineTransition(rules, repertoire.rootFullFen);

  const [phase, setPhase] = useState<RehearsePhase>({ kind: 'loading' });
  const [items, setItems] = useState<RehearseItem[]>([]);
  const [stats, setStats] = useState<RehearseStats>(EMPTY_STATS);
  const [missed, setMissed] = useState<number[]>([]);
  const [cue, setCue] = useState<'correct' | 'wrong' | null>(null);
  const [evalAfterAnswer, setEvalAfterAnswer] = useState(
    () => mergeDrillRules(repertoire.drillRules).evalAfterAnswer,
  );
  const [sound, setSound] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Refs for everything an async sequence reads after an `await`.
  const itemsRef = useRef<RehearseItem[]>([]);
  const deferredRef = useRef<RehearseItem[]>([]);
  const requeuedRef = useRef(false);
  const cardIndexRef = useRef(0);
  const finishedRef = useRef(false);
  const hintedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const targetsRef = useRef<ExpandTarget[]>([]);
  const soundRef = useRef(false);
  soundRef.current = sound;

  const [expandData, setExpandData] = useState<{
    targetIndex: number;
    explorer: ExplorerEntry | null;
    book: BookContinuation[];
  } | null>(null);

  /* ---------------- engine gating ---------------- */

  const engineOn =
    phase.kind === 'expand' || (phase.kind === 'correct' && evalAfterAnswer && !phase.showNote);
  const engine = useEngine(engineOn ? rules.fen : null, {
    enabled: engineOn,
    gated: !engineOn,
    depth: 18,
    multipv: 3,
  });
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      getEngine().setGated(false);
    };
  }, []);

  /* ---------------- helpers ---------------- */

  function startSequence(): AbortController {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    return ctl;
  }

  function flash(kind: 'correct' | 'wrong') {
    setCue(kind);
    if (soundRef.current) sounds[kind]();
    setTimeout(() => setCue((c) => (c === kind ? null : c)), CUE_MS);
  }

  const swallow = (e: unknown) => {
    if (!isAbort(e)) console.error(e);
  };

  /* ---------------- cards ---------------- */

  async function goTo(i: number, signal: AbortSignal) {
    const it = itemsRef.current[i];
    if (!it) {
      finish();
      return;
    }
    cardIndexRef.current = i;
    hintedRef.current = false;
    setPhase({ kind: 'transition', index: i });
    await transition.animateTo(it.pathSans, it.parentFullFen, signal);
    setPhase({ kind: 'prompt', index: i, hint: false });
  }

  function finish() {
    finishedRef.current = true;
    setPhase({ kind: 'summary' });
  }

  async function advance(from: number, signal: AbortSignal) {
    const next = from + 1;
    if (next < itemsRef.current.length) {
      await goTo(next, signal);
      return;
    }
    // Skipped cards come back once, at the end — a skip is "not now", not "never".
    if (deferredRef.current.length > 0 && !requeuedRef.current) {
      requeuedRef.current = true;
      const more = deferredRef.current;
      deferredRef.current = [];
      itemsRef.current = [...itemsRef.current, ...more];
      setItems(itemsRef.current);
      await goTo(next, signal);
      return;
    }
    finish();
  }

  const start = useCallback(
    async (preset?: RehearseItem[]) => {
      const ctl = startSequence();
      setPhase({ kind: 'loading' });
      setStats(EMPTY_STATS);
      setMissed([]);
      deferredRef.current = [];
      requeuedRef.current = false;
      finishedRef.current = false;
      try {
        let queue = preset;
        if (!queue) {
          try {
            await pullSince(repertoire.id); // best effort — offline is fine
          } catch {
            /* offline */
          }
          const cards = await getAllCardsLocal();
          queue = buildRehearseQueue({ repertoire, cards, chapterTag });
        }
        if (ctl.signal.aborted) return;
        itemsRef.current = queue;
        setItems(queue);
        void setMeta(lastChapterKey(repertoire.id), chapterTag ?? '');
        if (queue.length === 0) {
          finish();
          return;
        }
        await goTo(0, ctl.signal);
      } catch (e) {
        swallow(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repertoire.id, chapterTag],
  );

  async function runCorrect(i: number, graded: boolean, signal: AbortSignal) {
    const it = itemsRef.current[i]!;
    if (graded) {
      const hinted = hintedRef.current;
      void gradeAndQueue(it.card, hinted ? Grade.Hard : Grade.Good);
      void logAttempt({ moveId: it.move.id, repertoireId: repertoire.id, playedSan: it.move.san, wasCorrect: true });
      setStats((s) => ({
        ...s,
        correct: s.correct + 1,
        hinted: s.hinted + (hinted ? 1 : 0),
        streak: s.streak + 1,
        bestStreak: Math.max(s.bestStreak, s.streak + 1),
      }));
    }
    flash('correct');
    setPhase({ kind: 'correct', index: i, showNote: false });
    await sleep(CORRECT_PAUSE_MS + (evalAfterAnswer ? EVAL_PEEK_MS : 0), signal);
    await advance(i, signal);
  }

  async function runMiss(i: number, userSan: string, signal: AbortSignal) {
    const it = itemsRef.current[i]!;
    rules.undo();
    void gradeAndQueue(it.card, Grade.Again);
    void logAttempt({ moveId: it.move.id, repertoireId: repertoire.id, playedSan: userSan, wasCorrect: false });
    setStats((s) => ({ ...s, wrong: s.wrong + 1, streak: 0 }));
    setMissed((m) => (m.includes(i) ? m : [...m, i]));
    flash('wrong');
    const rep = useAppStore.getState().active ?? repertoire;
    const interference =
      describeInterference(detectInterference(rep, it.parentPosition.id, userSan)) ?? undefined;
    const base = { kind: 'miss' as const, index: i, userSan, interference };
    setPhase({ ...base, stage: 'reveal' });
    await runMissReveal({ rules, correctSan: it.move.san, revealMs: WRONG_REVEAL_MS, signal });
    const stage = nextMissStage(it.move);
    setPhase({ ...base, stage, ...(stage === 'note' ? { note: it.move.comment!.trim() } : {}) });
  }

  /** The board accepted a legal move (already applied to `rules`). */
  function onMovePlayed(san: string) {
    const p = phase;
    if (p.kind === 'prompt') {
      const it = itemsRef.current[p.index]!;
      const ctl = startSequence();
      if (san === it.move.san) runCorrect(p.index, true, ctl.signal).catch(swallow);
      else runMiss(p.index, san, ctl.signal).catch(swallow);
      return;
    }
    if (p.kind === 'miss' && p.stage === 'retry') {
      const it = itemsRef.current[p.index]!;
      if (san !== it.move.san) {
        rules.undo();
        return;
      }
      const ctl = startSequence();
      runCorrect(p.index, false, ctl.signal).catch(swallow);
      return;
    }
    if (p.kind === 'expand' && p.step === 'your-move') {
      recordExpansion(p, san);
      return;
    }
    rules.undo();
  }

  function dismissNote() {
    const p = phase;
    if (p.kind === 'miss' && p.stage === 'note') {
      setPhase({ ...p, stage: 'retry', note: undefined });
    } else if (p.kind === 'correct' && p.showNote) {
      const ctl = startSequence();
      advance(p.index, ctl.signal).catch(swallow);
    }
  }

  function showNote() {
    if (phase.kind === 'correct') {
      abortRef.current?.abort();
      setPhase({ ...phase, showNote: true });
    }
  }

  function hint() {
    if (phase.kind === 'prompt' && !phase.hint) {
      hintedRef.current = true;
      setPhase({ ...phase, hint: true });
    }
  }

  function skip() {
    const p = phase;
    if (p.kind === 'prompt' || (p.kind === 'miss' && p.stage === 'retry')) {
      const it = itemsRef.current[p.index]!;
      if (p.kind === 'prompt') deferredRef.current.push(it);
      setStats((s) => ({ ...s, skipped: s.skipped + 1 }));
      const ctl = startSequence();
      advance(p.index, ctl.signal).catch(swallow);
    } else if (p.kind === 'expand' && p.step !== 'done') {
      const ctl = startSequence();
      expandGo(p.targetIndex + 1, ctl.signal).catch(swallow);
    }
  }

  // No idle timer: a card waits for the user for as long as they like. The
  // hint is on demand only (H / button).

  /* ---------------- expand ---------------- */

  async function expandGo(t: number, signal: AbortSignal) {
    const target = targetsRef.current[t];
    if (!target) {
      setPhase({ kind: 'expand', step: 'done', targetIndex: t });
      return;
    }
    setExpandData(null);
    setPhase({ kind: 'expand', step: 'pick', targetIndex: t });
    await transition.animateTo(target.pathSans, target.position.fullFen, signal);
    const [explorer, book] = await Promise.all([
      fetchExplorerEntry(target.position.fenKey),
      api.getBookContinuations(target.position.fenKey).catch(() => [] as BookContinuation[]),
    ]);
    if (signal.aborted) return;
    setExpandData({ targetIndex: t, explorer, book });
  }

  function enterExpand() {
    const rep = useAppStore.getState().active ?? repertoire;
    targetsRef.current = collectExpandTargets(rep, buildIndices(rep), chapterTag);
    const ctl = startSequence();
    expandGo(0, ctl.signal).catch(swallow);
  }

  function leaveExpand() {
    const ctl = startSequence();
    if (finishedRef.current || itemsRef.current.length === 0) {
      finish();
      return;
    }
    goTo(cardIndexRef.current, ctl.signal).catch(swallow);
  }

  function chooseDeviation(san: string) {
    if (phase.kind !== 'expand' || phase.step !== 'pick') return;
    abortRef.current?.abort();
    if (!rules.playSan(san)) return;
    setPhase({ kind: 'expand', step: 'your-move', targetIndex: phase.targetIndex, deviationSan: san });
  }

  function undoDeviation() {
    if (phase.kind !== 'expand' || phase.step !== 'your-move') return;
    rules.undo();
    setPhase({ kind: 'expand', step: 'pick', targetIndex: phase.targetIndex });
  }

  async function recordExpansion(p: Extract<RehearsePhase, { kind: 'expand' }>, userSan: string) {
    const target = targetsRef.current[p.targetIndex]!;
    setPhase({ ...p, step: 'saving', error: undefined });
    try {
      await api.appendLine(repertoire.id, {
        fromFenKey: target.position.fenKey,
        sans: [p.deviationSan!, userSan],
      });
      setStats((s) => ({ ...s, recorded: s.recorded + 1 }));
      await useAppStore.getState().reloadActive();
      void pullSince(repertoire.id).catch(() => {});
      const ctl = startSequence();
      await expandGo(p.targetIndex + 1, ctl.signal);
    } catch (e) {
      if (isAbort(e)) return;
      rules.undo();
      const message = e instanceof Error ? e.message : String(e);
      setPhase({ ...p, step: 'your-move', error: message });
    }
  }

  const expandTarget =
    phase.kind === 'expand' && phase.step !== 'done' ? targetsRef.current[phase.targetIndex] : undefined;

  const deviation = useMemo<{ replies: RankedReply[]; source: DeviationSource; ready: boolean }>(() => {
    if (!expandTarget || !expandData || expandData.targetIndex !== (phase.kind === 'expand' ? phase.targetIndex : -1)) {
      return { replies: [], source: 'none', ready: false };
    }
    const fullFen = expandTarget.position.fullFen;
    const engineCands =
      engine.progress && engine.progress.fen === fullFen
        ? engineLinesToCandidates(fullFen, engine.progress.lines)
        : [];
    const picked = pickDeviationSource({
      explorer: expandData.explorer,
      sideToMove: fenTurn(fullFen),
      engine: engineCands,
      book: expandData.book,
    });
    // Fresh `existing` from the store: a reply recorded a moment ago must not be offered again.
    const rep = useAppStore.getState().active ?? repertoire;
    const existing = rep.moves.filter((m) => m.parentPositionId === expandTarget.position.id);
    return { replies: uncoveredReplies(picked.replies, existing).slice(0, 5), source: picked.source, ready: true };
  }, [expandTarget, expandData, engine.progress, phase, repertoire]);

  /* ---------------- derived for the view ---------------- */

  const currentItem =
    phase.kind === 'prompt' || phase.kind === 'correct' || phase.kind === 'miss' || phase.kind === 'transition'
      ? items[phase.index]
      : undefined;

  const boardMovable: 'white' | 'black' | null =
    phase.kind === 'prompt' ||
    (phase.kind === 'miss' && phase.stage === 'retry') ||
    (phase.kind === 'expand' && phase.step === 'your-move')
      ? heroColor
      : null;

  const shapes = useMemo<DrawShape[]>(() => {
    if (phase.kind === 'prompt' && phase.hint && currentItem) {
      return [{ orig: currentItem.move.uci.slice(0, 2) as DrawShape['orig'], brush: 'yellow' }];
    }
    if (phase.kind === 'expand' && showSuggestions && engine.progress?.fen === rules.fen) {
      return engineArrows(engine.progress, { max: 3 });
    }
    return [];
  }, [phase, currentItem, showSuggestions, engine.progress, rules.fen]);

  const heroToMove = isUserMove(fenTurn(rules.fen), heroColor as Color);

  useEffect(() => {
    void loadSoundPref().then(setSound);
  }, []);

  // Kick off on mount.
  useEffect(() => {
    if (initialMode === 'expand') {
      itemsRef.current = [];
      enterExpand();
    } else {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, initialMode]);

  return {
    rules,
    transition,
    engine,
    engineOn,
    phase,
    items,
    stats,
    missed,
    cue,
    shapes,
    boardMovable,
    heroColor,
    heroToMove,
    currentItem,
    expandTarget,
    expandTargets: targetsRef.current,
    deviation,
    evalAfterAnswer,
    sound,
    showSuggestions,
    actions: {
      onMovePlayed,
      dismissNote,
      showNote,
      hint,
      skip,
      enterExpand,
      leaveExpand,
      chooseDeviation,
      undoDeviation,
      restart: () => void start(),
      rehearseMisses: () => {
        const subset = missed.map((i) => itemsRef.current[i]!).filter(Boolean);
        const shuffled = [...subset].sort(() => Math.random() - 0.5);
        void start(shuffled);
      },
      toggleEvalAfterAnswer: () => setEvalAfterAnswer((v) => !v),
      toggleSound: () => {
        const next = !sound;
        setSound(next);
        void saveSoundPref(next);
      },
      toggleSuggestions: () => setShowSuggestions((v) => !v),
    },
  };
}

export type RehearseSessionApi = ReturnType<typeof useRehearseSession>;

export async function readLastChapter(repertoireId: string): Promise<string | undefined> {
  try {
    return await getMeta(lastChapterKey(repertoireId));
  } catch {
    return undefined;
  }
}
