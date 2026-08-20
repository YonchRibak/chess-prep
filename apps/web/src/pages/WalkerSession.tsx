/**
 * Phase 7 walker session — one UI for both Build and Drill seeds.
 *
 * The walker steps over the position-keyed tree. At each node it picks ONE of
 * four panel states based on (a) whose turn it is and (b) whether the user
 * has prepped it. Build and Drill differ only in the seed (which queue the
 * walker pulls from) — the per-node UX is identical.
 *
 * - **Build seed** (kind === 'build'): walker calls `findNextBuildNode` after
 *   every save action, BFS from the root, prompting at the shallowest position
 *   needing attention. Round-robin across branches at the same depth.
 * - **Drill seed** (kind === 'drill'): walker drives off the FSRS-due queue.
 *   When it auto-plays an opponent reply and lands on an unprepped child, the
 *   panel slides into build mode for that one node (drill-pauses-for-build);
 *   after the user adds the move, a soft "Keep building / Back to drill"
 *   prompt resumes the queue (default = back to drill).
 *
 * Orientation: the board is ALWAYS loaded by replaying the move path from the
 * repertoire root (not by snap-loading a FEN). That keeps `rules.history` as
 * the true current line, which drives (a) the SAN move list under the header,
 * (b) the full-path opening-name lookup, and (c) the last-move highlight that
 * makes branch jumps legible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import {
  fenTurn,
  isUserMove,
  mergeDrillRules,
  rankUserCandidates,
  selectOpponentReplies,
  Grade,
  type Color,
  type ExplorerEntry,
  type RankedReply,
  type SrsCardDto,
  type UserCandidate,
} from '@chess-prep/shared';
import { useAppStore } from '../store/app.ts';
import { useChessRules } from '../lib/chess/useChessRules.ts';
import { Board } from '../components/Board.tsx';
import { Btn, Card } from '../components/ui.tsx';
import { OpeningHeader } from '../components/OpeningHeader.tsx';
import { MoveLine } from '../components/MoveLine.tsx';
import { BuilderPrompt } from '../components/BuilderPrompt.tsx';
import { api, ApiError, type RepertoireFull, type RepertoireMove, type RepertoirePosition } from '../api/client.ts';
import { getAllCardsLocal } from '../lib/idb/schema.ts';
import { ensureOpeningNames, openingNameLookup } from '../lib/openings/nameCache.ts';
import {
  engineLinesToCandidates,
  fetchExplorerEntry,
  getOpponentCandidates,
  type CandidateSource,
} from '../lib/openings/candidates.ts';
import { selectAutoExpandSans } from '../lib/walker/autoExpand.ts';
import { warmFrontier } from '../lib/openings/prefetch.ts';
import { gradeAndQueue } from '../lib/srs/sync.ts';
import { buildDrillQueue, type DrillItem } from '../lib/drill/queue.ts';
import { getEngine } from '../lib/engine/engine.ts';
import { useEngine } from '../lib/engine/useEngine.ts';
import { engineArrows } from '../lib/engine/arrows.ts';
import { EnginePanel } from '../components/EnginePanel.tsx';
import {
  buildIndices,
  computeCoverage,
  findNextBuildNode,
  findPathToPosition,
  pickOpponentReplyForDrill,
  type FindNextBuildNodeOptions,
  type WalkerIndices,
  type WalkerNode,
} from '../lib/walker/walker.ts';
import type { BoardColor } from '../lib/chess/useBoard.ts';

type WalkerSeed = 'build' | 'drill';

type Phase =
  | { kind: 'loading' }
  | { kind: 'attention'; node: WalkerNode }
  | { kind: 'drill-prompt'; card: SrsCardDto; move: RepertoireMove; depth: number }
  | { kind: 'drill-correct'; card: SrsCardDto; move: RepertoireMove }
  | {
      kind: 'drill-wrong';
      card: SrsCardDto;
      move: RepertoireMove;
      userSan: string;
      /**
       * reveal: the correct move is briefly shown on the board (not movable).
       * retry: the user must physically play the correct move to continue —
       * that's where the motor memory comes from.
       */
      stage: 'reveal' | 'retry';
    }
  | {
      kind: 'drill-paused-for-build';
      node: WalkerNode;
      lastCardFenKey: string; // where to resume FSRS queue after answer
    }
  | { kind: 'keep-building-prompt'; freshFenKey: string }
  | { kind: 'complete'; reason: 'no-more-attention' | 'no-more-due' };

/** A prep-swap awaiting inline confirmation (replaces window.confirm). */
interface PendingSwap {
  parentFenKey: string;
  san: string;
  existingSan: string | null;
  resume: 'build' | 'drill-paused';
}

const CORRECT_PAUSE_MS = 300;
const OPPONENT_PAUSE_MS = 350;
const WRONG_REVEAL_MS = 1200;
/**
 * Safety net on Phase 9c auto-expansion. Each expansion normally uncovers a
 * user-turn node immediately, so this bound is never approached; it exists so a
 * pathological tree can't spin the walk instead of showing a prompt.
 */
const AUTO_EXPAND_MAX_STEPS = 6;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

interface WalkerSessionProps {
  seed: WalkerSeed;
}

export function WalkerSession({ seed }: WalkerSessionProps) {
  const active = useAppStore((s) => s.active);
  const go = useAppStore((s) => s.go);
  const reloadActive = useAppStore((s) => s.reloadActive);
  const setAutoExpand = useAppStore((s) => s.setAutoExpand);

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [stats, setStats] = useState({ correct: 0, wrong: 0, savedMoves: 0, autoAdded: 0 });
  const [drillQueue, setDrillQueue] = useState<DrillItem[] | null>(null);
  const [drillCursor, setDrillCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null);

  // Board state — one rules instance kept across the whole session so transitions feel continuous.
  const rules = useChessRules();
  const transitionAbortRef = useRef<AbortController | null>(null);

  // Session-local "skip for now" set: positions deferred until next session.
  // A ref (not state) so async flows always see the current set.
  const sessionSkippedRef = useRef<Set<string>>(new Set());

  // Indices recomputed whenever the repertoire changes (after each save).
  const indices = useMemo<WalkerIndices | null>(
    () => (active ? buildIndices(active) : null),
    [active],
  );
  const cardDueByMoveId = useMemo(() => {
    const m = new Map<string, string>();
    if (drillQueue) {
      for (const it of drillQueue) m.set(it.move.id, it.card.due);
    }
    return m;
  }, [drillQueue]);

  const coverage = useMemo(
    () => (active && indices ? computeCoverage(active, indices) : null),
    [active, indices],
  );

  /* ---------------- board loading: always replay from the root ---------------- */

  /**
   * Load the board at `pos` by replaying the move path from the root. Keeps
   * the board history = the true line (move list, opening lookup, last-move
   * highlight). Falls back to a direct FEN load when the position isn't
   * reachable via live moves (e.g. under a dropped ancestor).
   */
  const loadToPosition = useCallback(
    (rep: RepertoireFull, idx: WalkerIndices, pos: RepertoirePosition) => {
      const path = findPathToPosition(rep, idx, pos.id);
      if (path.length === 0 && pos.fenKey !== rep.rootFenKey) {
        rules.load(pos.fullFen);
        return;
      }
      rules.load(rep.rootFullFen);
      for (const m of path) {
        if (rules.playSan(m.san) === null) {
          // SAN replay diverged (shouldn't happen) — recover with a direct load.
          rules.load(pos.fullFen);
          return;
        }
      }
    },
    [rules],
  );

  // The current line, straight from the board. Drives the move list and the
  // full-path opening-name lookup (fixes the old shallow 2-position path).
  const lineSans = useMemo(() => rules.history.map((m) => m.san), [rules.history]);
  const headerPath = useMemo(() => {
    const rootFen = active?.rootFullFen;
    if (!rootFen) return [];
    const fens = [rootFen];
    try {
      const chess = new Chess(rootFen);
      for (const san of lineSans) {
        chess.move(san);
        fens.push(chess.fen());
      }
    } catch {
      /* partial path is fine */
    }
    return fens;
  }, [active?.rootFullFen, lineSans]);

  /* ---------------- session bootstrap ---------------- */

  /**
   * Phase 9a scope, resolved once at session start and reused by every later
   * `resumeBuild`. Held in a ref rather than state because the resume path
   * runs from event handlers — a stale closure over the scope would quietly
   * drop the walker back to building the whole tree.
   */
  const scopeOptionsRef = useRef<Pick<FindNextBuildNodeOptions, 'scope' | 'openingLookup'>>({});

  /* ---------------- engine (build mode only) ---------------- */

  // Phase 8b gating, refined: the hard gate follows the PHASE, not the whole
  // session. While building a move there is no card answer to leak — the user
  // is authoring the prep — so eval + suggestion arrows are available. Every
  // drill phase (prompt / correct / wrong / keep-building) re-gates the engine
  // module, so `analyze()` is a no-op and in-flight analysis is stopped.
  const buildMode =
    phase.kind === 'attention' || phase.kind === 'drill-paused-for-build';
  const [engineEnabled, setEngineEnabled] = useState(true);
  const engineOn = buildMode && engineEnabled;

  const engine = useEngine(engineOn ? rules.fen : null, {
    enabled: engineOn,
    gated: !buildMode,
    depth: 18,
    multipv: 3,
  });

  /* ---------------- Phase 9c: candidates for the build prompt ---------------- */

  // The node being built, read straight off the phase so these hooks stay
  // above the component's early returns.
  const buildNode =
    phase.kind === 'attention'
      ? phase.node
      : phase.kind === 'drill-paused-for-build'
        ? phase.node
        : null;
  const buildFenKey = buildNode?.position.fenKey ?? null;
  const buildFullFen = buildNode?.position.fullFen ?? null;

  // One explorer fetch per build node, shared by both candidate lists. Failure
  // is silent and expected — the panel falls back to the book.
  const [explorerEntry, setExplorerEntry] = useState<ExplorerEntry | null>(null);
  useEffect(() => {
    if (!buildFenKey) {
      setExplorerEntry(null);
      return;
    }
    let cancelled = false;
    void fetchExplorerEntry(buildFenKey).then((entry) => {
      if (!cancelled) setExplorerEntry(entry);
    });
    return () => {
      cancelled = true;
    };
  }, [buildFenKey]);

  const opponentReplies: RankedReply[] = useMemo(() => {
    if (!buildNode || buildNode.kind !== 'opponent-picks' || !buildFullFen) return [];
    return selectOpponentReplies(explorerEntry, fenTurn(buildFullFen));
  }, [buildNode, buildFullFen, explorerEntry]);

  const candidateSource: CandidateSource = opponentReplies.length > 0 ? 'explorer' : 'book';

  const userCandidates: UserCandidate[] = useMemo(() => {
    if (!buildNode || buildNode.kind !== 'user-prep' || !buildFullFen) return [];
    const progress = engine.progress;
    // Only trust analysis of the position actually on the board; a result for
    // the previous node arriving late must never be offered as prep here.
    if (!progress || progress.fen !== buildFullFen) return [];
    const lines = engineLinesToCandidates(buildFullFen, progress.lines);
    if (lines.length === 0) return [];
    return rankUserCandidates(lines, explorerEntry, fenTurn(buildFullFen));
  }, [buildNode, buildFullFen, engine.progress, explorerEntry]);

  const engineShapes = useMemo(
    () => (engineOn ? engineArrows(engine.progress, { max: 3 }) : []),
    [engineOn, engine.progress],
  );

  // Leaving the walker must never leave the gate on — the editor and the
  // opening browser rely on free analysis.
  useEffect(() => {
    return () => {
      getEngine().setGated(false);
    };
  }, []);

  useEffect(() => {
    if (!active || !indices) return;
    let cancelled = false;
    setPhase({ kind: 'loading' });
    setStats({ correct: 0, wrong: 0, savedMoves: 0, autoAdded: 0 });
    sessionSkippedRef.current = new Set();
    setPendingSwap(null);

    (async () => {
      // Phase 9a: the repertoire's line scope steers BOTH seeds — building
      // inside one line, and drilling only that line's cards.
      const names = await ensureOpeningNames([active]);
      if (cancelled) return;
      const scopeOptions = {
        scope: mergeDrillRules(active.drillRules).scope,
        openingLookup: openingNameLookup(names),
      };
      scopeOptionsRef.current = scopeOptions;

      if (seed === 'build') {
        const node = findNextBuildNode(active, indices, scopeOptions);
        if (cancelled) return;
        if (!node) {
          setPhase({ kind: 'complete', reason: 'no-more-attention' });
          return;
        }
        loadToPosition(active, indices, node.position);
        setPhase({ kind: 'attention', node });
      } else {
        // drill seed: load cards and build queue
        const cards = await getAllCardsLocal();
        if (cancelled) return;
        const rules2 = mergeDrillRules(active.drillRules);
        const queue = buildDrillQueue({
          repertoire: active,
          cards,
          mode: 'due',
          rules: rules2,
          openingLookup: scopeOptions.openingLookup,
        });
        if (cancelled) return;
        setDrillQueue(queue);
        if (queue.length === 0) {
          setPhase({ kind: 'complete', reason: 'no-more-due' });
          return;
        }
        const first = queue[0]!;
        loadToPosition(active, indices, first.parentPosition);
        setDrillCursor(0);
        setPhase({ kind: 'drill-prompt', card: first.card, move: first.move, depth: first.depth });
      }
    })();

    return () => {
      cancelled = true;
      transitionAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, seed]);

  /* ---------------- keyboard shortcuts ---------------- */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (phase.kind === 'attention' && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void skipCurrentNode();
      } else if (phase.kind === 'keep-building-prompt') {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          backToDrill();
        } else if (e.key.toLowerCase() === 'b') {
          e.preventDefault();
          keepBuildingFromHere(phase.freshFenKey);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
  if (!indices) return null;

  /* ---------------- common helpers ---------------- */

  function startTransition(): AbortController {
    transitionAbortRef.current?.abort();
    const ctl = new AbortController();
    transitionAbortRef.current = ctl;
    return ctl;
  }

  /**
   * Refresh the active rep, rebuild indices, then BFS for the next build node.
   * Skip-aware: nodes in `sessionSkippedRef` are passed over, not returned.
   * With `fromFenKey`, descends into that branch first; when the branch is
   * exhausted, falls back to the shallowest gap anywhere in the tree.
   */
  async function resumeBuild(fromFenKey?: string) {
    await reloadActive();
    let next = useAppStore.getState().active;
    if (!next) return;

    // Phase 9c: opponent-turn nodes may be filled in silently when the
    // repertoire opts in, so the walk keeps moving until it reaches a decision
    // only the user can make (their own move). The step cap is a safety net,
    // not a policy — each expansion normally leads straight to a user-turn
    // node, so the loop runs once or twice.
    for (let step = 0; step < AUTO_EXPAND_MAX_STEPS; step++) {
      const idx = buildIndices(next);
      const exclude = sessionSkippedRef.current;
      const scopeOptions = scopeOptionsRef.current;
      let node = findNextBuildNode(next, idx, { fromFenKey, exclude, ...scopeOptions });
      if (!node && fromFenKey) {
        node = findNextBuildNode(next, idx, { exclude, ...scopeOptions });
      }
      if (!node) {
        setPhase({ kind: 'complete', reason: 'no-more-attention' });
        return;
      }

      if (next.autoExpand && node.kind === 'opponent-picks') {
        const added = await autoExpandAt(next, idx, node);
        if (added > 0) {
          await reloadActive();
          const refreshed = useAppStore.getState().active;
          if (!refreshed) return;
          next = refreshed;
          continue; // the new branch is the next thing to walk into
        }
        // Nothing to add (cold explorer, everything known, or everything the
        // user dropped) — fall through and ask, rather than stalling.
      }

      loadToPosition(next, idx, node.position);
      setPhase({ kind: 'attention', node });
      warmFrontier(frontierKeys(next, idx));
      return;
    }
  }

  /**
   * Silently add the top opponent replies at `node`.
   *
   * The candidate list falls back to the book when the explorer is cold, and
   * `selectAutoExpandSans` is what guarantees a **dropped branch is never
   * re-added** — an attention node is one with no *live* children, so a
   * position whose replies were all dropped is indistinguishable from a fresh
   * one here.
   */
  async function autoExpandAt(
    rep: RepertoireFull,
    idx: WalkerIndices,
    node: WalkerNode,
  ): Promise<number> {
    const fenKey = node.position.fenKey;
    // No book fetch here: the book fallback can never authorize a silent write
    // (see selectAutoExpandSans), so asking for it would be a wasted request.
    const { replies, source } = await getOpponentCandidates(
      fenKey,
      fenTurn(node.position.fullFen),
      [],
    );
    // Pass ALL moves at this parent, dropped included — that is the filter.
    // `source` blocks the write when the list is the book's alphabetical order
    // rather than real frequencies.
    const existing = idx.movesByParent.get(node.position.id) ?? [];
    const decision = selectAutoExpandSans(replies, existing, { source });
    if (decision.sans.length === 0) return 0;

    let added = 0;
    for (const san of decision.sans) {
      try {
        await api.addMove(rep.id, { parentFenKey: fenKey, san });
        added++;
      } catch (e) {
        // One bad candidate must not abort the walk; the user can still add
        // responses by hand at this position.
        console.warn('[auto-expand] could not add', san, e);
      }
    }
    if (added > 0) setStats((s) => ({ ...s, autoAdded: s.autoAdded + added }));
    return added;
  }

  /* ---------------- build path: save actions ---------------- */

  /**
   * Positions one ply past current coverage — the walker's near future, and so
   * what the prefetcher should warm. Cheap to compute (one pass over the live
   * moves) and deliberately unfiltered by scope: the user may switch scope
   * mid-session, and a warm entry is never wrong, only unused.
   */
  function frontierKeys(rep: RepertoireFull, idx: WalkerIndices): string[] {
    const out: string[] = [];
    for (const p of rep.positions) {
      const live = (idx.movesByParent.get(p.id) ?? []).filter((m) => !m.isDropped);
      if (live.length === 0) out.push(p.fenKey);
    }
    return out;
  }

  async function afterPrepSaved(resume: 'build' | 'drill-paused', parentFenKey: string) {
    if (resume === 'build') {
      await resumeBuild();
    } else {
      await reloadActive();
      setPhase({ kind: 'keep-building-prompt', freshFenKey: parentFenKey });
    }
  }

  /** User picked a prep move (on a user-turn position). */
  async function savePrepMove(
    parentFenKey: string,
    san: string,
    opts: { resume: 'build' | 'drill-paused'; fromBoard?: boolean },
  ) {
    setError(null);
    try {
      await api.addMove(active!.id, { parentFenKey, san });
      setStats((s) => ({ ...s, savedMoves: s.savedMoves + 1 }));
      await afterPrepSaved(opts.resume, parentFenKey);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // One-prep-per-user-turn invariant: confirm swap inline (no window.confirm).
        if (opts.fromBoard) rules.undo();
        const parent = indices?.positionByKey.get(parentFenKey);
        const existing = parent
          ? (indices?.movesByParent.get(parent.id) ?? []).filter((m) => !m.isDropped)[0]
          : undefined;
        setPendingSwap({
          parentFenKey,
          san,
          existingSan: existing?.san ?? null,
          resume: opts.resume,
        });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async function confirmSwap() {
    if (!pendingSwap) return;
    const { parentFenKey, san, resume } = pendingSwap;
    setPendingSwap(null);
    setError(null);
    try {
      await api.addMove(active!.id, { parentFenKey, san, onConflict: 'swap' });
      setStats((s) => ({ ...s, savedMoves: s.savedMoves + 1 }));
      await afterPrepSaved(resume, parentFenKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** User picked one or more opponent responses to prepare against. */
  async function saveOpponentPicks(parentFenKey: string, sans: string[]) {
    if (sans.length === 0) return;
    setError(null);
    try {
      for (const san of sans) {
        await api.addMove(active!.id, { parentFenKey, san });
      }
      setStats((s) => ({ ...s, savedMoves: s.savedMoves + sans.length }));
      await resumeBuild();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** "Won't cover" gesture: persist a placeholder Move with isDropped=true. */
  async function dropOpponentResponse(parentFenKey: string, san: string) {
    setError(null);
    try {
      const added = await api.addMove(active!.id, { parentFenKey, san });
      await api.patchMove(active!.id, added.id, { isDropped: true });
      await resumeBuild();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Skip = defer for this session; the node resurfaces next session. */
  async function skipCurrentNode() {
    if (phase.kind !== 'attention') return;
    sessionSkippedRef.current.add(phase.node.position.id);
    await resumeBuild();
  }

  /* ---------------- drill path ---------------- */

  function advanceDrillCursor(nextCursor: number) {
    if (!drillQueue) return;
    const next = drillQueue[nextCursor];
    if (!next) {
      setPhase({ kind: 'complete', reason: 'no-more-due' });
      return;
    }
    const rep = useAppStore.getState().active ?? active!;
    loadToPosition(rep, buildIndices(rep), next.parentPosition);
    setDrillCursor(nextCursor);
    setPhase({
      kind: 'drill-prompt',
      card: next.card,
      move: next.move,
      depth: next.depth,
    });
  }

  /**
   * Shared continuation after the user's (eventually) correct move: walk the
   * board through one opponent reply (most-due-child when there are multiple
   * options). If the resulting position has no user-side prep, slide into
   * build mode for that one node (drill-pauses-for-build).
   */
  async function continueAfterUserMove(it: DrillItem, signal: AbortSignal) {
    const idx = indices;
    if (!idx) {
      advanceDrillCursor(drillCursor + 1);
      return;
    }

    const childPos = idx.positionById.get(it.move.childPositionId);
    if (!childPos) {
      advanceDrillCursor(drillCursor + 1);
      return;
    }

    const reply = pickOpponentReplyForDrill(childPos.id, idx, cardDueByMoveId);
    if (reply && rules.playSan(reply.san) !== null) {
      await sleep(OPPONENT_PAUSE_MS, signal);

      // Check the resulting position for prep.
      const replyChildPos = idx.positionById.get(reply.childPositionId);
      if (replyChildPos) {
        const liveOut = (idx.movesByParent.get(replyChildPos.id) ?? []).filter(
          (m) => !m.isDropped,
        );
        const turn = fenTurn(replyChildPos.fullFen);
        const userTurn = isUserMove(turn, active!.color as Color);
        if (userTurn && liveOut.length === 0) {
          // No prep here → drill-pauses-for-build.
          setPhase({
            kind: 'drill-paused-for-build',
            node: {
              position: replyChildPos,
              kind: 'user-prep',
              depth: it.depth + 2,
              existingMoves: [],
              path: [],
            },
            lastCardFenKey: replyChildPos.fenKey,
          });
          return;
        }
      }
    }

    advanceDrillCursor(drillCursor + 1);
  }

  async function runDrillCorrect(it: DrillItem, signal: AbortSignal) {
    setPhase({ kind: 'drill-correct', card: it.card, move: it.move });
    setStats((s) => ({ ...s, correct: s.correct + 1 }));
    void gradeAndQueue(it.card, Grade.Good);
    await sleep(CORRECT_PAUSE_MS, signal);
    await continueAfterUserMove(it, signal);
  }

  /**
   * Wrong answer: grade Again, briefly SHOW the correct move on the board,
   * then take it back and require the user to play it themselves before the
   * session moves on (retrain — that's where the motor memory comes from).
   */
  async function runDrillWrong(it: DrillItem, userSan: string, signal: AbortSignal) {
    setStats((s) => ({ ...s, wrong: s.wrong + 1 }));
    void gradeAndQueue(it.card, Grade.Again);
    setPhase({ kind: 'drill-wrong', card: it.card, move: it.move, userSan, stage: 'reveal' });
    rules.playSan(it.move.san);
    await sleep(WRONG_REVEAL_MS, signal);
    rules.undo();
    setPhase({ kind: 'drill-wrong', card: it.card, move: it.move, userSan, stage: 'retry' });
  }

  async function handleDrillMovePlayed(san: string) {
    if (phase.kind !== 'drill-prompt') return;
    const it = drillQueue?.[drillCursor];
    if (!it) return;
    const correct = san === it.move.san;
    const ctl = startTransition();
    try {
      if (correct) {
        await runDrillCorrect(it, ctl.signal);
      } else {
        rules.undo();
        await runDrillWrong(it, san, ctl.signal);
      }
    } catch {
      /* aborted */
    }
  }

  /** Retry stage: only the correct move advances; anything else snaps back. */
  async function handleRetryMovePlayed(san: string) {
    if (phase.kind !== 'drill-wrong' || phase.stage !== 'retry') return;
    const it = drillQueue?.[drillCursor];
    if (!it) return;
    if (san !== it.move.san) {
      rules.undo();
      return;
    }
    const ctl = startTransition();
    try {
      // Already graded Again on the first miss — no re-grade here.
      setPhase({ kind: 'drill-correct', card: it.card, move: it.move });
      await sleep(CORRECT_PAUSE_MS, ctl.signal);
      await continueAfterUserMove(it, ctl.signal);
    } catch {
      /* aborted */
    }
  }

  /* ---------------- board move dispatch ---------------- */

  /**
   * Board moves play different roles depending on phase. Route them.
   */
  async function handleMovePlayed(san: string) {
    if (phase.kind === 'drill-prompt') {
      await handleDrillMovePlayed(san);
      return;
    }
    if (phase.kind === 'drill-wrong') {
      await handleRetryMovePlayed(san);
      return;
    }
    if (phase.kind === 'attention') {
      const isUserTurnNode = phase.node.kind === 'user-prep';
      if (isUserTurnNode) {
        await savePrepMove(phase.node.position.fenKey, san, {
          resume: 'build',
          fromBoard: true,
        });
      } else {
        // opponent-picks: a single drop-in via the board adds one branch.
        await saveOpponentPicks(phase.node.position.fenKey, [san]);
      }
      return;
    }
    if (phase.kind === 'drill-paused-for-build') {
      // Adding a prep move for the just-discovered unprepped node.
      await savePrepMove(phase.node.position.fenKey, san, {
        resume: 'drill-paused',
        fromBoard: true,
      });
    }
  }

  function keepBuildingFromHere(freshFenKey: string) {
    void resumeBuild(freshFenKey);
  }
  function backToDrill() {
    advanceDrillCursor(drillCursor + 1);
  }

  /* ---------------- derived: current panel data ---------------- */

  const showBuildPanel =
    phase.kind === 'attention' || phase.kind === 'drill-paused-for-build';

  const currentNode: WalkerNode | null =
    phase.kind === 'attention'
      ? phase.node
      : phase.kind === 'drill-paused-for-build'
        ? phase.node
        : null;

  // Existing prep at the current attention position (for the panel).
  const existingPrepFromHere: { san: string; childFenKey: string }[] = (() => {
    if (!currentNode) return [];
    const out = (indices.movesByParent.get(currentNode.position.id) ?? []).filter(
      (m) => !m.isDropped,
    );
    return out.map((m) => ({ san: m.san, childFenKey: m.childFenKey }));
  })();

  /* ---------------- render ---------------- */

  const movableColor: BoardColor | null =
    phase.kind === 'drill-prompt' ||
    (phase.kind === 'drill-wrong' && phase.stage === 'retry') ||
    showBuildPanel
      ? ((rules.turn === 'w' ? 'white' : 'black') as BoardColor)
      : null;

  return (
    <div className="w-full max-w-6xl flex flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <button
            onClick={() => go({ kind: 'list' })}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            ← All repertoires
          </button>
          <h2 className="text-lg font-semibold">
            {seed === 'build' ? 'Build' : 'Drill'}: {active.name}
          </h2>
          <span className="text-xs text-slate-500">
            {active.color === 'white' ? '♔ White' : '♚ Black'}
          </span>
        </div>
        <div className="flex gap-2 items-center">
          {coverage && (
            <span className="text-[10px] text-slate-500 font-mono">
              {coverage.inFlight} live / {coverage.uncovered} todo
              {coverage.droppedMoves > 0 ? ` · ${coverage.droppedMoves} dropped` : ''}
            </span>
          )}
          {seed === 'build' && (
            <label
              className="flex items-center gap-1.5 text-[10px] text-slate-400"
              title="Silently add the most-played opponent replies while building. Never re-adds a branch you dropped."
            >
              <input
                type="checkbox"
                checked={active.autoExpand}
                onChange={(e) => void setAutoExpand(active.id, e.target.checked)}
                className="accent-emerald-500"
              />
              auto-expand replies
            </label>
          )}
          <Btn onClick={() => go({ kind: 'editor', repertoireId: active.id })}>
            Open editor
          </Btn>
        </div>
      </header>

      {phase.kind === 'loading' && (
        <p className="text-slate-400 text-sm">Setting up walker…</p>
      )}
      {phase.kind === 'complete' && (
        <CompletePane reason={phase.reason} stats={stats} seed={seed} />
      )}

      {phase.kind !== 'loading' && phase.kind !== 'complete' && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
          <div className="flex flex-col items-center gap-3 w-full">
            <OpeningHeader pathFens={headerPath} className="self-start" />
            <MoveLine sans={lineSans} className="self-start" />
            <Board
              rules={rules}
              orientation={active.color as BoardColor}
              movableColor={movableColor}
              shapes={engineShapes}
              onMovePlayed={(san) => void handleMovePlayed(san)}
            />
            <SessionProgress
              seed={seed}
              stats={stats}
              drillTotal={drillQueue?.length}
              drillDone={drillCursor + (phase.kind === 'drill-prompt' ? 0 : 1)}
            />
          </div>

          <aside className="flex flex-col gap-3 text-sm">
            {error && (
              <div className="rounded border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                {error}
              </div>
            )}

            {pendingSwap && (
              <Card title="Replace existing prep?">
                <p className="text-xs text-slate-300">
                  {pendingSwap.existingSan ? (
                    <>
                      This position already has{' '}
                      <span className="font-mono font-semibold">{pendingSwap.existingSan}</span>{' '}
                      as prep.
                    </>
                  ) : (
                    'A prep move already exists at this position.'
                  )}{' '}
                  Replace it with{' '}
                  <span className="font-mono font-semibold">{pendingSwap.san}</span>?
                </p>
                <p className="text-[10px] text-slate-500 mt-1">
                  The SRS history for the old move will be lost.
                </p>
                <div className="flex gap-2 pt-2">
                  <Btn variant="danger" onClick={() => void confirmSwap()}>
                    Replace
                  </Btn>
                  <Btn onClick={() => setPendingSwap(null)}>Keep {pendingSwap.existingSan ?? 'current'}</Btn>
                </div>
              </Card>
            )}

            {!pendingSwap && phase.kind === 'attention' && (
              <AttentionPanel
                node={phase.node}
                existingPrep={existingPrepFromHere}
                onPickPrep={(san) =>
                  savePrepMove(phase.node.position.fenKey, san, { resume: 'build' })
                }
                onPickSingle={(san) =>
                  saveOpponentPicks(phase.node.position.fenKey, [san])
                }
                onSaveSelected={(sans) =>
                  saveOpponentPicks(phase.node.position.fenKey, sans)
                }
                onDropResponse={(san) =>
                  dropOpponentResponse(phase.node.position.fenKey, san)
                }
                onSkip={() => void skipCurrentNode()}
                userCandidates={userCandidates}
                explorerReplies={opponentReplies}
                candidateSource={candidateSource}
              />
            )}

            {!pendingSwap && phase.kind === 'drill-paused-for-build' && (
              <Card title="New prep — fill this gap">
                <p className="text-xs text-slate-400 mb-2">
                  No prep saved for this position yet. Play your move on the board, or
                  pick a book suggestion below.
                </p>
                <BuilderPrompt
                  mode="user-turn"
                  currentFenKey={phase.node.position.fenKey}
                  existingPrep={[]}
                  engineCandidates={userCandidates}
                  onPickPrep={(san) =>
                    savePrepMove(phase.node.position.fenKey, san, { resume: 'drill-paused' })
                  }
                />
              </Card>
            )}

            {phase.kind === 'keep-building-prompt' && (
              <Card title="Keep going?">
                <p className="text-xs text-slate-400">
                  Saved. Continue building this branch, or back to today's drill queue?
                </p>
                <div className="flex gap-2 pt-2">
                  <Btn variant="primary" onClick={backToDrill}>
                    Back to drill <Kbd>↵</Kbd>
                  </Btn>
                  <Btn onClick={() => keepBuildingFromHere(phase.freshFenKey)}>
                    Keep building <Kbd>b</Kbd>
                  </Btn>
                </div>
              </Card>
            )}

            {phase.kind === 'drill-prompt' && (
              <Card title="Your move">
                <p className="text-xs text-slate-400">
                  Depth: <span className="font-mono">{phase.depth}</span> · Reps:{' '}
                  <span className="font-mono">{phase.card.reps}</span>
                </p>
                <p className="text-xs text-slate-500 mt-2">
                  Play your prepared move on the board.
                </p>
              </Card>
            )}

            {phase.kind === 'drill-correct' && (
              <Card title="✓ Correct">
                <p className="text-sm">
                  <span className="font-mono font-medium">{phase.move.san}</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">Next…</p>
              </Card>
            )}

            {phase.kind === 'drill-wrong' && (
              <Card title={phase.stage === 'reveal' ? '✗ Wrong' : 'Play the correct move'}>
                <p className="text-sm">
                  Correct: <span className="font-mono font-medium">{phase.move.san}</span>
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  You played: <span className="font-mono">{phase.userSan}</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {phase.stage === 'reveal'
                    ? 'Graded Again — watch the correct move…'
                    : `Now play ${phase.move.san} yourself to continue.`}
                </p>
              </Card>
            )}

            {buildMode && (
              <EnginePanel
                fen={rules.fen}
                progress={engine.progress}
                ready={engine.ready}
                error={engine.error}
                enabled={engineEnabled}
                onToggleEnabled={() => setEngineEnabled((e) => !e)}
              />
            )}

            <DroppedListPanel
              rep={active}
              indices={indices}
              onUndrop={async (moveId) => {
                try {
                  await api.patchMove(active.id, moveId, { isDropped: false });
                  await reloadActive();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

/* ---------------- subcomponents ---------------- */

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-1 px-1 rounded border border-slate-600 bg-slate-800 text-[9px] font-mono">
      {children}
    </kbd>
  );
}

function AttentionPanel({
  node,
  existingPrep,
  onPickPrep,
  onPickSingle,
  onSaveSelected,
  onDropResponse,
  onSkip,
  userCandidates,
  explorerReplies,
  candidateSource,
}: {
  node: WalkerNode;
  existingPrep: { san: string; childFenKey: string }[];
  onPickPrep: (san: string) => void | Promise<void>;
  onPickSingle: (san: string) => void | Promise<void>;
  onSaveSelected: (sans: string[]) => void | Promise<void>;
  onDropResponse: (san: string) => void | Promise<void>;
  onSkip: () => void;
  userCandidates: UserCandidate[];
  explorerReplies: RankedReply[];
  candidateSource: CandidateSource;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        Ply {node.depth} · {node.kind === 'user-prep' ? 'Your move' : 'Their move'}
      </div>
      {node.kind === 'user-prep' ? (
        <BuilderPrompt
          mode="user-turn"
          currentFenKey={node.position.fenKey}
          existingPrep={existingPrep}
          engineCandidates={userCandidates}
          onPickPrep={onPickPrep}
        />
      ) : (
        <BuilderPrompt
          mode="opponent-turn"
          currentFenKey={node.position.fenKey}
          existingPrep={existingPrep}
          onSaveSelected={onSaveSelected}
          onPickSingle={onPickSingle}
          onDropResponse={onDropResponse}
          explorerReplies={explorerReplies}
          candidateSource={candidateSource}
        />
      )}
      <div className="flex gap-2">
        <Btn onClick={onSkip}>
          Skip for now <Kbd>s</Kbd>
        </Btn>
      </div>
      <p className="text-[10px] text-slate-500">
        "Skip" defers this prompt to the next session. "Won't cover" on a response
        permanently drops that branch.
      </p>
    </div>
  );
}

function SessionProgress({
  seed,
  stats,
  drillTotal,
  drillDone,
}: {
  seed: WalkerSeed;
  stats: { correct: number; wrong: number; savedMoves: number; autoAdded: number };
  drillTotal?: number;
  drillDone?: number;
}) {
  if (seed === 'build') {
    return (
      <div className="flex items-center gap-3 text-xs">
        <span className="font-mono text-slate-400">
          Saved {stats.savedMoves} move{stats.savedMoves === 1 ? '' : 's'}
        </span>
        {stats.autoAdded > 0 && (
          <span
            className="text-slate-400 font-mono"
            title="Opponent replies added automatically. They carry no flashcards."
          >
            +{stats.autoAdded} auto
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="font-mono">
        {drillDone ?? 0} / {drillTotal ?? 0}
      </span>
      <span className="text-emerald-300 font-mono">✓ {stats.correct}</span>
      <span className="text-rose-300 font-mono">✗ {stats.wrong}</span>
      {stats.savedMoves > 0 && (
        <span className="text-amber-300 font-mono">+ {stats.savedMoves} built</span>
      )}
      {stats.autoAdded > 0 && (
        <span
          className="text-slate-400 font-mono"
          title="Opponent replies added automatically. They carry no flashcards."
        >
          +{stats.autoAdded} auto
        </span>
      )}
    </div>
  );
}

function CompletePane({
  reason,
  stats,
  seed,
}: {
  reason: 'no-more-attention' | 'no-more-due';
  stats: { correct: number; wrong: number; savedMoves: number; autoAdded: number };
  seed: WalkerSeed;
}) {
  const go = useAppStore((s) => s.go);
  const active = useAppStore((s) => s.active);
  const totalAnswered = stats.correct + stats.wrong;
  const pct = totalAnswered > 0 ? Math.round((stats.correct / totalAnswered) * 100) : 0;
  return (
    <Card title="Session complete">
      {reason === 'no-more-attention' ? (
        <p className="text-sm text-slate-300">
          The walker reached the end — every reachable position has a saved continuation.
        </p>
      ) : (
        <p className="text-sm text-slate-300">
          No more due cards for now. Come back later or run a Build session to grow coverage.
        </p>
      )}
      {(totalAnswered > 0 || stats.savedMoves > 0) && (
        <p className="text-xs text-slate-500 mt-1">
          {totalAnswered > 0 && (
            <>
              Answered {totalAnswered} ({pct}% correct){stats.savedMoves > 0 ? ' · ' : ''}
            </>
          )}
          {stats.savedMoves > 0 && (
            <>
              Built {stats.savedMoves} new move{stats.savedMoves === 1 ? '' : 's'}
            </>
          )}
        </p>
      )}
      <div className="flex gap-2 mt-3">
        {active && (
          <>
            <Btn onClick={() => go({ kind: 'editor', repertoireId: active.id })}>
              Edit repertoire
            </Btn>
            {seed === 'drill' ? (
              <Btn onClick={() => go({ kind: 'walker-session', repertoireId: active.id, seed: 'build' })}>
                Switch to Build
              </Btn>
            ) : (
              <Btn onClick={() => go({ kind: 'walker-session', repertoireId: active.id, seed: 'drill' })}>
                Switch to Drill
              </Btn>
            )}
          </>
        )}
        <Btn onClick={() => go({ kind: 'list' })}>All repertoires</Btn>
      </div>
    </Card>
  );
}

/**
 * List of currently-dropped branches so the user can review and undo them
 * without leaving the walker. Compact: hidden when the list is empty.
 */
function DroppedListPanel({
  rep,
  indices,
  onUndrop,
}: {
  rep: RepertoireFull;
  indices: WalkerIndices;
  onUndrop: (moveId: string) => void | Promise<void>;
}) {
  const dropped = rep.moves.filter((m) => m.isDropped);
  if (dropped.length === 0) return null;
  return (
    <Card title={`Dropped branches (${dropped.length})`}>
      <ul className="flex flex-col gap-0.5 max-h-40 overflow-y-auto pr-1">
        {dropped.map((m) => {
          const parent = indices.positionById.get(m.parentPositionId);
          return (
            <li
              key={m.id}
              className="flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-slate-800"
            >
              <span className="font-mono text-slate-300">{m.san}</span>
              {parent && (
                <span className="text-[10px] text-slate-500 font-mono truncate flex-1">
                  from {parent.fenKey.slice(0, 24)}…
                </span>
              )}
              <button
                type="button"
                onClick={() => void onUndrop(m.id)}
                className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 hover:bg-slate-800"
                title="Restore this branch"
              >
                undrop
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
