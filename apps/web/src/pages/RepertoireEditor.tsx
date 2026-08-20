import { useEffect, useMemo, useState } from 'react';
import type { Square } from 'chess.js';
import { fenTurn, isUserMove } from '@chess-prep/shared';
import { useAppStore } from '../store/app.ts';
import { useChessRules } from '../lib/chess/useChessRules.ts';
import { Board } from '../components/Board.tsx';
import { Btn, Card } from '../components/ui.tsx';
import { EnginePanel } from '../components/EnginePanel.tsx';
import { OpeningHeader } from '../components/OpeningHeader.tsx';
import { BuilderPrompt } from '../components/BuilderPrompt.tsx';
import { useEngine } from '../lib/engine/useEngine.ts';
import { engineArrows } from '../lib/engine/arrows.ts';
import type { BoardColor } from '../lib/chess/useBoard.ts';
import { api, ApiError, type RepertoireFull, type RepertoireMove } from '../api/client.ts';

export function RepertoireEditor() {
  const active = useAppStore((s) => s.active);
  const go = useAppStore((s) => s.go);
  const reloadActive = useAppStore((s) => s.reloadActive);
  const setComment = useAppStore((s) => s.setComment);
  const setAnnotation = useAppStore((s) => s.setAnnotation);
  const setMainLine = useAppStore((s) => s.setMainLine);
  const setLineTags = useAppStore((s) => s.setLineTags);
  const deleteMove = useAppStore((s) => s.deleteMove);
  const exportPgnFn = useAppStore((s) => s.exportPgn);

  // Current viewing position (a fenKey in the repertoire's position table).
  const [currentFenKey, setCurrentFenKey] = useState<string>(active?.rootFenKey ?? '');
  const [lastMoveId, setLastMoveId] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<BoardColor>(active?.color ?? 'white');
  const [engineEnabled, setEngineEnabled] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  useEffect(() => {
    if (active) {
      // Open at the end of the seeded line (if any) so guided-build flows resume
      // where the auto-insert left off rather than at the starting position.
      const seededTip = findSeededLineTip(active);
      setCurrentFenKey(seededTip.fenKey);
      setLastMoveId(seededTip.moveId);
      setOrientation(active.color);
    }
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lookup indices: positions by key/id, moves by parent.
  const indices = useMemo(() => buildIndices(active), [active]);

  if (!active) {
    return (
      <div className="text-slate-400">
        No repertoire loaded.{' '}
        <button className="underline" onClick={() => go({ kind: 'list' })}>
          Back to list
        </button>
      </div>
    );
  }

  const currentPosition = indices.positionByKey.get(currentFenKey);
  const currentFullFen = currentPosition?.fullFen ?? active.rootFullFen;
  const currentPositionId = currentPosition?.id ?? null;

  const movesFromHere: RepertoireMove[] = currentPositionId
    ? sortSiblings(indices.movesByParent.get(currentPositionId) ?? [])
    : [];

  const lastMove = lastMoveId ? active.moves.find((m) => m.id === lastMoveId) ?? null : null;

  // The board's rules engine: a fresh state forced to `currentFullFen` whenever
  // we navigate. We use useChessRules just for legal-move computation; we don't
  // rely on its history here.
  const rules = useChessRulesPinnedTo(currentFullFen, lastMove);

  // Engine eval on the currently displayed position.
  const engine = useEngine(engineEnabled ? currentFullFen : null, {
    enabled: engineEnabled,
    depth: 18,
    multipv: 3,
  });

  // Suggested moves as board arrows (best = green, then blue / yellow).
  const engineShapes = useMemo(
    () => (engineEnabled ? engineArrows(engine.progress, { max: 3 }) : []),
    [engineEnabled, engine.progress],
  );

  function navigateToFenKey(fenKey: string, viaMoveId: string | null) {
    setCurrentFenKey(fenKey);
    setLastMoveId(viaMoveId);
    setOpError(null);
  }

  /**
   * Phase 7 "set as prep" gesture: play a move from the current position,
   * either by dragging on the board or by clicking a book suggestion.
   * - If the SAN is already prepped at this parent, just navigate to it.
   * - Else the server enforces the v1 "one prep per user-turn position" rule.
   *   On 409 (another prep already exists at a user-turn parent), confirm
   *   with the user, then retry with `onConflict: 'swap'`.
   */
  async function handleMovePlayed(san: string) {
    if (!active) return;
    const existing = movesFromHere.find((m) => m.san === san);
    if (existing) {
      navigateToFenKey(existing.childFenKey, existing.id);
      return;
    }

    setOpError(null);
    try {
      const added = await api.addMove(active.id, { parentFenKey: currentFenKey, san });
      await reloadActive();
      navigateToFenKey(added.childFenKey, added.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const existingPrep = movesFromHere[0];
        const ok = confirm(
          existingPrep
            ? `A prep move "${existingPrep.san}" already exists for this position. ` +
                `Replace it with "${san}"? The SRS history for "${existingPrep.san}" will be lost.`
            : `Replace the existing prep move with "${san}"?`,
        );
        if (!ok) return;
        try {
          const added = await api.addMove(active.id, {
            parentFenKey: currentFenKey,
            san,
            onConflict: 'swap',
          });
          await reloadActive();
          navigateToFenKey(added.childFenKey, added.id);
        } catch (e2) {
          setOpError(e2 instanceof Error ? e2.message : String(e2));
        }
      } else {
        setOpError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async function handleOpponentPicksSelected(sans: string[]) {
    if (!active || sans.length === 0) return;
    setOpError(null);
    try {
      // Add each opponent response separately so the parent stays the same
      // for all of them. (appendLine walks a single line — wrong shape here.)
      for (const san of sans) {
        await api.addMove(active.id, { parentFenKey: currentFenKey, san });
      }
      await reloadActive();
      // Descend into the first newly-added branch for the next prompt loop.
      const next = useAppStore.getState().active;
      if (!next) return;
      const firstSan = sans[0]!;
      const fresh = next.moves.find(
        (m) => m.parentPositionId === currentPositionId && m.san === firstSan,
      );
      if (fresh) navigateToFenKey(fresh.childFenKey, fresh.id);
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  // Build breadcrumb: chain of moves from the root to here (best-effort —
  // takes the main-line incoming move at each step).
  const path = useMemo(
    () => computePathToFenKey(active, indices, currentFenKey),
    [active, indices, currentFenKey],
  );

  const goBack = () => {
    if (path.length === 0) return;
    const prev = path[path.length - 1]!;
    // Find the position before this move.
    const parent = active.positions.find((p) => p.id === prev.parentPositionId);
    if (parent) navigateToFenKey(parent.fenKey, path[path.length - 2]?.id ?? null);
  };
  const goToStart = () => navigateToFenKey(active.rootFenKey, null);
  const goForwardMainLine = () => {
    const next = movesFromHere.find((m) => m.isMainLine) ?? movesFromHere[0];
    if (next) navigateToFenKey(next.childFenKey, next.id);
  };
  const flip = () => setOrientation((o) => (o === 'white' ? 'black' : 'white'));

  const handleExport = async () => {
    const pgn = await exportPgnFn(active.id);
    downloadFile(`${slugify(active.name)}.pgn`, pgn);
  };

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
          <h2 className="text-lg font-semibold">{active.name}</h2>
          <span className="text-xs text-slate-500">
            {active.color === 'white' ? '♔ White' : '♚ Black'}
          </span>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Btn
            variant="primary"
            onClick={() =>
              go({ kind: 'walker-session', repertoireId: active.id, seed: 'build' })
            }
          >
            Build
          </Btn>
          <Btn
            onClick={() =>
              go({ kind: 'walker-session', repertoireId: active.id, seed: 'drill' })
            }
          >
            Drill (walker)
          </Btn>
          <Btn onClick={() => go({ kind: 'drill-setup', repertoireId: active.id })}>
            Classic drill
          </Btn>
          <Btn onClick={() => go({ kind: 'health-check', repertoireId: active.id })}>
            Health check
          </Btn>
          <Btn onClick={handleExport}>Export PGN</Btn>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
        <div className="flex flex-col items-center gap-3">
          <OpeningHeader
            pathFens={[
              active.rootFullFen,
              ...path
                .map((m) => indices.positionById.get(m.childPositionId)?.fullFen)
                .filter((f): f is string => Boolean(f)),
            ]}
            className="self-start"
          />
          <Board
            rules={rules}
            orientation={orientation}
            shapes={engineShapes}
            onMovePlayed={(san) => void handleMovePlayed(san)}
          />
          <div className="flex flex-wrap gap-2 justify-center">
            <Btn onClick={goToStart} disabled={currentFenKey === active.rootFenKey}>
              ⏮ Start
            </Btn>
            <Btn onClick={goBack} disabled={path.length === 0}>
              ← Back
            </Btn>
            <Btn onClick={goForwardMainLine} disabled={movesFromHere.length === 0}>
              Forward →
            </Btn>
            <Btn onClick={flip}>Flip</Btn>
          </div>
          <p className="text-[10px] text-slate-500 font-mono break-all max-w-full">
            {currentFullFen}
          </p>
        </div>

        <aside className="flex flex-col gap-3 text-sm">
          {opError && (
            <div className="rounded border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
              {opError}
            </div>
          )}

          {isUserMove(fenTurn(currentFullFen), active.color) ? (
            <BuilderPrompt
              mode="user-turn"
              currentFenKey={currentFenKey}
              existingPrep={movesFromHere.map((m) => ({ san: m.san, childFenKey: m.childFenKey }))}
              onPickPrep={(san) => handleMovePlayed(san)}
            />
          ) : (
            <BuilderPrompt
              mode="opponent-turn"
              currentFenKey={currentFenKey}
              existingPrep={movesFromHere.map((m) => ({ san: m.san, childFenKey: m.childFenKey }))}
              onSaveSelected={(sans) => handleOpponentPicksSelected(sans)}
            />
          )}

          <UncoveredBranches
            active={active}
            indices={indices}
            currentFenKey={currentFenKey}
            onJump={(fenKey, moveId) => navigateToFenKey(fenKey, moveId)}
          />

          <EnginePanel
            fen={currentFullFen}
            progress={engine.progress}
            ready={engine.ready}
            error={engine.error}
            enabled={engineEnabled}
            onToggleEnabled={() => setEngineEnabled((e) => !e)}
          />

          <Card title="Position">
            <PathBreadcrumb
              path={path}
              rootFenKey={active.rootFenKey}
              currentFenKey={currentFenKey}
              onJump={(fenKey, moveId) => navigateToFenKey(fenKey, moveId)}
            />
          </Card>

          <Card title="Candidate moves from here">
            {movesFromHere.length === 0 ? (
              <p className="text-xs text-slate-500">
                No prepared moves. Play a move on the board to add one.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {movesFromHere.map((m) => (
                  <li key={m.id} className="flex items-center gap-2">
                    <button
                      onClick={() => navigateToFenKey(m.childFenKey, m.id)}
                      className={`font-mono text-sm flex-1 text-left px-2 py-1 rounded hover:bg-slate-800 ${
                        lastMoveId === m.id ? 'bg-slate-800 text-emerald-300' : ''
                      } ${m.isDropped ? 'line-through opacity-60' : ''}`}
                    >
                      {m.san}
                      {m.annotation ? ` ${m.annotation}` : ''}
                      {m.isMainLine && (
                        <span className="ml-1 text-[10px] text-emerald-400">main</span>
                      )}
                      {m.isDropped && (
                        <span className="ml-1 text-[10px] text-rose-400">dropped</span>
                      )}
                      {m.comment && (
                        <span className="ml-2 text-[10px] text-slate-400">
                          {m.comment.length > 40 ? `${m.comment.slice(0, 40)}…` : m.comment}
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => void setMainLine(m.id, !m.isMainLine)}
                      title={m.isMainLine ? 'Demote from main line' : 'Promote to main line'}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 hover:bg-slate-800"
                    >
                      {m.isMainLine ? '★' : '☆'}
                    </button>
                    <button
                      onClick={() => {
                        void (async () => {
                          if (m.isDropped) {
                            await api.patchMove(active.id, m.id, { isDropped: false });
                            await reloadActive();
                          } else if (
                            confirm(
                              `Drop branch starting at ${m.san}? The walker will never resurface it. (You can restore from the dropped list.)`,
                            )
                          ) {
                            await api.patchMove(active.id, m.id, { isDropped: true });
                            await reloadActive();
                          }
                        })();
                      }}
                      title={m.isDropped ? 'Restore (undrop)' : "Drop branch (won't cover)"}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 hover:bg-slate-800"
                    >
                      {m.isDropped ? '↺' : '⏏'}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete move ${m.san}?`)) void deleteMove(m.id);
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 hover:bg-rose-900"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {lastMove && (
            <MoveDetails
              key={lastMove.id}
              move={lastMove}
              onCommentChange={(c) => void setComment(lastMove.id, c || null)}
              onAnnotationChange={(a) => void setAnnotation(lastMove.id, a || null)}
              onLineTagsChange={(t) => void setLineTags(lastMove.id, t)}
            />
          )}

          <Card title="Tree">
            <TreeView
              active={active}
              indices={indices}
              currentMoveId={lastMoveId}
              onNavigate={(fenKey, moveId) => navigateToFenKey(fenKey, moveId)}
            />
          </Card>
        </aside>
      </div>
    </div>
  );
}

/* ---------------- helpers ---------------- */

interface Indices {
  positionByKey: Map<string, RepertoireFull['positions'][number]>;
  positionById: Map<string, RepertoireFull['positions'][number]>;
  movesByParent: Map<string, RepertoireMove[]>;
  parentMovesByChildId: Map<string, RepertoireMove[]>;
}

function buildIndices(rep: RepertoireFull | null): Indices {
  const positionByKey = new Map<string, RepertoireFull['positions'][number]>();
  const positionById = new Map<string, RepertoireFull['positions'][number]>();
  const movesByParent = new Map<string, RepertoireMove[]>();
  const parentMovesByChildId = new Map<string, RepertoireMove[]>();
  if (rep) {
    for (const p of rep.positions) {
      positionByKey.set(p.fenKey, p);
      positionById.set(p.id, p);
    }
    for (const m of rep.moves) {
      const arr = movesByParent.get(m.parentPositionId) ?? [];
      arr.push(m);
      movesByParent.set(m.parentPositionId, arr);
      const carr = parentMovesByChildId.get(m.childPositionId) ?? [];
      carr.push(m);
      parentMovesByChildId.set(m.childPositionId, carr);
    }
  }
  return { positionByKey, positionById, movesByParent, parentMovesByChildId };
}

function sortSiblings(moves: RepertoireMove[]): RepertoireMove[] {
  return [...moves].sort((a, b) => {
    if (a.isMainLine !== b.isMainLine) return a.isMainLine ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.san.localeCompare(b.san);
  });
}

/** Best-effort path from the root to the current fenKey, choosing main-line ancestors. */
function computePathToFenKey(
  rep: RepertoireFull,
  indices: Indices,
  fenKey: string,
): RepertoireMove[] {
  const path: RepertoireMove[] = [];
  let cursorKey = fenKey;
  const visited = new Set<string>();
  while (cursorKey !== rep.rootFenKey) {
    if (visited.has(cursorKey)) break;
    visited.add(cursorKey);
    const position = indices.positionByKey.get(cursorKey);
    if (!position) break;
    const incoming = indices.parentMovesByChildId.get(position.id);
    if (!incoming || incoming.length === 0) break;
    // Prefer main-line incoming edge, else first.
    const sorted = sortSiblings(incoming);
    const chosen = sorted[0]!;
    path.unshift(chosen);
    const parentPos = indices.positionById.get(chosen.parentPositionId);
    if (!parentPos) break;
    cursorKey = parentPos.fenKey;
  }
  return path;
}

function PathBreadcrumb({
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

function MoveDetails({
  move,
  onCommentChange,
  onAnnotationChange,
  onLineTagsChange,
}: {
  move: RepertoireMove;
  onCommentChange: (comment: string) => void;
  onAnnotationChange: (annotation: string) => void;
  onLineTagsChange: (tags: string[]) => void;
}) {
  const [comment, setCommentLocal] = useState(move.comment ?? '');
  const [annotation, setAnnotationLocal] = useState(move.annotation ?? '');
  const [lineTags, setLineTagsLocal] = useState((move.lineTags ?? []).join(', '));

  // Commit on blur — avoids API call per keystroke.
  return (
    <Card title={`Move: ${move.san}`}>
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Comment</span>
          <textarea
            value={comment}
            onChange={(e) => setCommentLocal(e.target.value)}
            onBlur={() => {
              if (comment !== (move.comment ?? '')) onCommentChange(comment);
            }}
            rows={2}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Annotation (e.g. !, ?, !?, $15)</span>
          <input
            value={annotation}
            onChange={(e) => setAnnotationLocal(e.target.value)}
            onBlur={() => {
              if (annotation !== (move.annotation ?? '')) onAnnotationChange(annotation);
            }}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Line tags (comma-separated)</span>
          <input
            value={lineTags}
            onChange={(e) => setLineTagsLocal(e.target.value)}
            onBlur={() => {
              const next = lineTags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean);
              if (next.join(', ') !== (move.lineTags ?? []).join(', ')) onLineTagsChange(next);
            }}
            placeholder="vs-danny, blitz-only"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs font-mono"
          />
          <span className="text-[10px] text-slate-500">
            Applies to this move and everything below it — drill one line by picking the tag
            in Drill setup.
          </span>
        </label>
      </div>
    </Card>
  );
}

/* ---------------- uncovered branches (Phase 7) ---------------- */

/**
 * Surface every opponent-turn position in the tree that has no saved
 * responses yet — these are the gaps the user can resume the build at.
 *
 * Coverage is **derived**, not stored: an opponent-turn position is
 * "uncovered" iff its outgoing move set is empty AND it has at least one
 * incoming move (it's actually in the tree). The root is excluded — at the
 * start of a fresh blank repertoire it would always show up here for no
 * useful reason; the breadcrumb's "start" button already covers that case.
 */
function UncoveredBranches({
  active,
  indices,
  currentFenKey,
  onJump,
}: {
  active: RepertoireFull;
  indices: Indices;
  currentFenKey: string;
  onJump: (fenKey: string, moveId: string | null) => void;
}) {
  const uncovered = useMemo(() => {
    const out: Array<{ fenKey: string; viaMove: RepertoireMove | null; depth: number }> = [];
    for (const p of active.positions) {
      if (p.fenKey === active.rootFenKey) continue;
      const turn = fenTurn(p.fullFen);
      const isOpponent = !isUserMove(turn, active.color);
      if (!isOpponent) continue;
      const outgoing = (indices.movesByParent.get(p.id) ?? []).filter((m) => !m.isDropped);
      if (outgoing.length > 0) continue;
      const incoming = (indices.parentMovesByChildId.get(p.id) ?? []).filter(
        (m) => !m.isDropped,
      );
      if (incoming.length === 0) continue;
      const via = sortSiblings(incoming)[0]!;
      out.push({ fenKey: p.fenKey, viaMove: via, depth: depthOfFen(active, indices, p.fenKey) });
    }
    // Shallower (earlier in tree) branches first, then SAN-alphabetical for stability.
    out.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return (a.viaMove?.san ?? '').localeCompare(b.viaMove?.san ?? '');
    });
    return out;
  }, [active, indices]);

  return (
    <Card title={`Uncovered branches (${uncovered.length})`}>
      {uncovered.length === 0 ? (
        <p className="text-xs text-slate-500">
          No uncovered opponent-turn positions — every saved branch has at least one prepped
          response.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-1">
          {uncovered.map((u) => (
            <li key={u.fenKey}>
              <button
                type="button"
                onClick={() => onJump(u.fenKey, u.viaMove?.id ?? null)}
                className={`w-full text-left px-2 py-1 rounded text-xs font-mono hover:bg-slate-800 ${
                  u.fenKey === currentFenKey ? 'bg-slate-800 text-emerald-300' : 'text-slate-300'
                }`}
              >
                after {u.viaMove?.san ?? '?'}
                <span className="ml-1 text-[10px] text-slate-500">d{u.depth}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Approximate depth-from-root (in plies) by walking parents. */
function depthOfFen(rep: RepertoireFull, indices: Indices, fenKey: string): number {
  let cursor = fenKey;
  let depth = 0;
  const visited = new Set<string>();
  while (cursor !== rep.rootFenKey && depth < 200) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const pos = indices.positionByKey.get(cursor);
    if (!pos) break;
    const incoming = indices.parentMovesByChildId.get(pos.id);
    if (!incoming || incoming.length === 0) break;
    const chosen = sortSiblings(incoming)[0]!;
    const parent = indices.positionById.get(chosen.parentPositionId);
    if (!parent) break;
    depth++;
    cursor = parent.fenKey;
  }
  return depth;
}

/**
 * Phase 7 seed support: when a freshly-created opening-based repertoire opens,
 * jump to the end of the auto-inserted line so the prompt loop starts exactly
 * where the user takes over (e.g. for "French as White" with `1.e4 e6` seeded,
 * open at the post-`1...e6` position). Falls back to root for repertoires
 * that have no seeded line or are already branched.
 */
function findSeededLineTip(rep: RepertoireFull): { fenKey: string; moveId: string | null } {
  const indices = buildIndices(rep);
  let cursorKey = rep.rootFenKey;
  let cursorMoveId: string | null = null;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(cursorKey)) break;
    visited.add(cursorKey);
    const pos = indices.positionByKey.get(cursorKey);
    if (!pos) break;
    const children = indices.movesByParent.get(pos.id) ?? [];
    // A "seeded" prefix is a chain of single-child positions. As soon as the
    // tree branches, stop — that's the natural prompt point.
    if (children.length !== 1) break;
    const next = children[0]!;
    cursorKey = next.childFenKey;
    cursorMoveId = next.id;
  }
  return { fenKey: cursorKey, moveId: cursorMoveId };
}

/* ---------------- tree view ---------------- */

interface TreeRenderToken {
  kind: 'move' | 'open-var' | 'close-var';
  move?: RepertoireMove;
  fullMoveNumber?: number;
  isWhite?: boolean;
  needsNumberLabel?: boolean;
  depth: number;
}

function TreeView({
  active,
  indices,
  currentMoveId,
  onNavigate,
}: {
  active: RepertoireFull;
  indices: Indices;
  currentMoveId: string | null;
  onNavigate: (fenKey: string, moveId: string) => void;
}) {
  const tokens = useMemo(
    () => flattenTree(active, indices),
    [active, indices],
  );
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
        return (
          <button
            key={i}
            onClick={() => onNavigate(m.childFenKey, m.id)}
            className={`px-1 rounded ${
              isCurrent
                ? 'bg-emerald-700 text-white'
                : m.isMainLine
                  ? 'hover:bg-slate-800'
                  : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            {label}
            {m.annotation ? m.annotation : ''}
          </button>
        );
      })}
    </div>
  );
}

function flattenTree(rep: RepertoireFull, indices: Indices): TreeRenderToken[] {
  const out: TreeRenderToken[] = [];
  const visited = new Set<string>();

  function walk(parentPositionId: string, parentFullFen: string, depth: number, isLineStart: boolean) {
    const children = sortSiblings(indices.movesByParent.get(parentPositionId) ?? []);
    if (children.length === 0) return;
    let currentFullFen = parentFullFen;
    let pairFlow = !isLineStart;

    for (let idx = 0; idx < children.length; idx++) {
      const m = children[idx]!;
      const isMain = idx === 0;
      const meta = parseFenMeta(currentFullFen);

      if (isMain) {
        out.push({
          kind: 'move',
          move: m,
          fullMoveNumber: meta.fullMoveNumber,
          isWhite: meta.turn === 'w',
          needsNumberLabel: meta.turn === 'w' || !pairFlow,
          depth,
        });
      } else {
        // sibling variation
        out.push({ kind: 'open-var', depth });
        out.push({
          kind: 'move',
          move: m,
          fullMoveNumber: meta.fullMoveNumber,
          isWhite: meta.turn === 'w',
          needsNumberLabel: true,
          depth: depth + 1,
        });
        const childPosForVar = indices.positionById.get(m.childPositionId);
        if (childPosForVar && !visited.has(childPosForVar.id)) {
          visited.add(childPosForVar.id);
          walk(childPosForVar.id, childPosForVar.fullFen, depth + 1, false);
        }
        out.push({ kind: 'close-var', depth });
      }
    }

    // Continue down the main line after emitting siblings.
    const main = children[0]!;
    const mainChildPos = indices.positionById.get(main.childPositionId);
    if (mainChildPos && !visited.has(mainChildPos.id)) {
      visited.add(mainChildPos.id);
      walk(mainChildPos.id, mainChildPos.fullFen, depth, children.length > 1 ? false : true /* pairFlow */);
    }
  }

  const root = indices.positionByKey.get(rep.rootFenKey);
  if (root) {
    visited.add(root.id);
    walk(root.id, root.fullFen, 0, true);
  }
  return out;
}

function parseFenMeta(fen: string): { fullMoveNumber: number; turn: 'w' | 'b' } {
  const parts = fen.trim().split(/\s+/);
  return {
    turn: (parts[1] ?? 'w') as 'w' | 'b',
    fullMoveNumber: Number(parts[5] ?? 1),
  };
}

/* ---------------- pinned chess rules ---------------- */

/**
 * Like useChessRules but pinned to a specific FEN so navigation jumps work.
 * The legal-moves logic is recomputed every render — fine for a board.
 */
function useChessRulesPinnedTo(fullFen: string, lastMove: RepertoireMove | null) {
  // Recreate rules whenever fullFen changes. We use the existing useChessRules
  // hook by loading the FEN on each render via a small wrapper.
  const rules = useChessRules(fullFen);
  useEffect(() => {
    rules.load(fullFen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullFen]);

  // Override lastMove from the repertoire's edge for clearer highlighting.
  const lastMoveOverride = lastMove
    ? {
        from: lastMove.uci.slice(0, 2) as Square,
        to: lastMove.uci.slice(2, 4) as Square,
      }
    : null;

  return {
    ...rules,
    lastMove: lastMoveOverride ?? rules.lastMove,
  };
}

/* ---------------- file download ---------------- */

function downloadFile(name: string, content: string) {
  const blob = new Blob([content], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'repertoire';
}
