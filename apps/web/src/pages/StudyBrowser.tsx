/**
 * Study browser (S4): step through an imported study, read its notes, and
 * ask the engine or Rashid about any position — on demand, never by default.
 *
 * Deliberately *not* an editor: the study is authored in lichess, so this
 * view has no "add move" gesture. Playing a move on the board navigates if
 * the study contains it and snaps back otherwise. It is an ungated analysis
 * surface (see engine.md): no unanswered card is ever on screen here.
 */
import { useEffect, useMemo, useState } from 'react';
import { fenTurn, formatRashidScore } from '@chess-prep/shared';
import { useAppStore } from '../store/app.ts';
import { useRashidScan, type RashidFinding } from '../store/rashidScan.ts';
import { Board } from '../components/Board.tsx';
import { Btn, Card } from '../components/ui.tsx';
import { EnginePanel } from '../components/EnginePanel.tsx';
import { RashidPanel } from '../components/RashidPanel.tsx';
import { OpeningHeader } from '../components/OpeningHeader.tsx';
import { PathBreadcrumb, TreeView } from '../components/TreeView.tsx';
import { useEngine } from '../lib/engine/useEngine.ts';
import { engineArrows } from '../lib/engine/arrows.ts';
import { useRashid } from '../lib/engine/useRashid.ts';
import { RASHID_BRUSHES, rashidShapes } from '../lib/engine/rashidArrows.ts';
import { useChessRulesPinnedTo } from '../lib/chess/useChessRulesPinnedTo.ts';
import { buildTreeIndices, computePathToFenKey, sortSiblings } from '../lib/tree/treeIndex.ts';
import type { BoardColor } from '../lib/chess/useBoard.ts';
import type { RepertoireFull, RepertoireMove } from '../api/client.ts';

export function StudyBrowser({ fenKey }: { fenKey?: string }) {
  const active = useAppStore((s) => s.active);
  const go = useAppStore((s) => s.go);
  if (!active) {
    return (
      <div className="text-slate-400">
        No study loaded.{' '}
        <button className="underline" onClick={() => go({ kind: 'studies' })}>
          Back to studies
        </button>
      </div>
    );
  }
  return <Browser active={active} initialFenKey={fenKey} />;
}

function Browser({ active, initialFenKey }: { active: RepertoireFull; initialFenKey?: string }) {
  const go = useAppStore((s) => s.go);
  const scan = useRashidScan();

  const indices = useMemo(() => buildTreeIndices(active), [active]);
  const [currentFenKey, setCurrentFenKey] = useState<string>(
    initialFenKey && indices.positionByKey.has(initialFenKey) ? initialFenKey : active.rootFenKey,
  );
  const [lastMoveId, setLastMoveId] = useState<string | null>(() => {
    if (!initialFenKey) return null;
    const p = computePathToFenKey(active, indices, initialFenKey);
    return p[p.length - 1]?.id ?? null;
  });
  const [orientation, setOrientation] = useState<BoardColor>(active.color);
  const [engineEnabled, setEngineEnabled] = useState(false);
  const [rashidEnabled, setRashidEnabled] = useState(false);
  const [includeAlternates, setIncludeAlternates] = useState(true);

  const currentPosition = indices.positionByKey.get(currentFenKey);
  const currentFullFen = currentPosition?.fullFen ?? active.rootFullFen;
  const movesFromHere: RepertoireMove[] = currentPosition
    ? sortSiblings(indices.movesByParent.get(currentPosition.id) ?? [])
    : [];
  const lastMove = lastMoveId ? active.moves.find((m) => m.id === lastMoveId) ?? null : null;
  const path = useMemo(
    () => computePathToFenKey(active, indices, currentFenKey),
    [active, indices, currentFenKey],
  );

  const rules = useChessRulesPinnedTo(currentFullFen, lastMove);
  const heroColor: 'w' | 'b' = active.color === 'white' ? 'w' : 'b';

  const engine = useEngine(engineEnabled ? currentFullFen : null, {
    enabled: engineEnabled,
    depth: 18,
    multipv: 3,
  });
  const rashid = useRashid(currentFullFen, heroColor, rashidEnabled);

  const engineShapes = useMemo(
    () => (engineEnabled ? engineArrows(engine.progress, { max: 3 }) : []),
    [engineEnabled, engine.progress],
  );
  // Same precedence as the editor: while Rashid is on the board is Rashid's.
  const boardShapes = useMemo(
    () => (rashidEnabled ? rashidShapes(rashid.result) : engineShapes),
    [rashidEnabled, rashid.result, engineShapes],
  );

  function navigate(fenKey: string, viaMoveId: string | null) {
    setCurrentFenKey(fenKey);
    setLastMoveId(viaMoveId);
  }
  const goToStart = () => navigate(active.rootFenKey, null);
  const goBack = () => {
    if (path.length === 0) return;
    const prev = path[path.length - 1]!;
    const parent = indices.positionById.get(prev.parentPositionId);
    if (parent) navigate(parent.fenKey, path[path.length - 2]?.id ?? null);
  };
  const goForward = () => {
    const next = movesFromHere[0];
    if (next) navigate(next.childFenKey, next.id);
  };
  /** ↑/↓: cycle among the siblings of the move that led here. */
  const cycleSibling = (dir: 1 | -1) => {
    if (!lastMove) return;
    const siblings = sortSiblings(indices.movesByParent.get(lastMove.parentPositionId) ?? []);
    if (siblings.length < 2) return;
    const i = siblings.findIndex((m) => m.id === lastMove.id);
    const next = siblings[(i + dir + siblings.length) % siblings.length]!;
    navigate(next.childFenKey, next.id);
  };

  /** A board move navigates if the study has it; otherwise snap back. */
  function handleMovePlayed(san: string) {
    const existing = movesFromHere.find((m) => m.san === san);
    if (existing) navigate(existing.childFenKey, existing.id);
    else rules.undo();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          goForward();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          goBack();
          break;
        case 'ArrowUp':
          e.preventDefault();
          cycleSibling(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          cycleSibling(1);
          break;
        case 'Home':
          e.preventDefault();
          goToStart();
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const scanForThis = scan.repertoireId === active.id;
  const findings = scanForThis ? scan.findings : [];
  const chapters = active.source?.chapters ?? [];

  return (
    <div className="w-full max-w-6xl flex flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <button className="text-sm text-slate-400 hover:underline" onClick={() => go({ kind: 'studies' })}>
            ← Studies
          </button>
          <h2 className="text-lg font-semibold">{active.name}</h2>
          <span className="text-xs text-slate-500">{active.color === 'white' ? '♔ White' : '♚ Black'}</span>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => go({ kind: 'walker-session', repertoireId: active.id, seed: 'drill' })}>
            Rehearse
          </Btn>
          <Btn variant="ghost" onClick={() => go({ kind: 'editor', repertoireId: active.id })}>
            Edit
          </Btn>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
        <div className="flex flex-col items-center gap-3 w-full">
          <OpeningHeader
            pathFens={[active.rootFenKey, ...path.map((m) => m.childFenKey)]}
            className="self-start"
          />
          <Board
            rules={rules}
            orientation={orientation}
            shapes={boardShapes}
            extraBrushes={RASHID_BRUSHES}
            onMovePlayed={handleMovePlayed}
          />
          <div className="flex flex-wrap gap-2 justify-center">
            <Btn onClick={goToStart} disabled={currentFenKey === active.rootFenKey}>
              ⏮ Start
            </Btn>
            <Btn onClick={goBack} disabled={path.length === 0}>
              ← Back
            </Btn>
            <Btn onClick={goForward} disabled={movesFromHere.length === 0}>
              Forward →
            </Btn>
            <Btn onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}>Flip</Btn>
            <span className="text-[10px] text-slate-500 self-center">← → ↑ ↓ Home</span>
          </div>

          <Card title="Tree">
            <TreeView
              active={active}
              indices={indices}
              currentMoveId={lastMoveId}
              onNavigate={(fk, id) => navigate(fk, id)}
            />
          </Card>
        </div>

        <aside className="flex flex-col gap-3 text-sm">
          <Card title="Position">
            <PathBreadcrumb
              path={path}
              rootFenKey={active.rootFenKey}
              currentFenKey={currentFenKey}
              onJump={navigate}
            />
            {lastMove && (
              <div className="mt-2 flex flex-wrap gap-1">
                {lastMove.lineTags.map((t) => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    {chapters.find((c) => c.tag === t)?.name ?? t}
                  </span>
                ))}
                {lastMove.isDropped && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">
                    alternate — not rehearsed
                  </span>
                )}
              </div>
            )}
          </Card>

          <Card title={lastMove ? `Note on ${lastMove.san}` : 'Note'}>
            {lastMove?.comment ? (
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{lastMove.comment}</p>
            ) : (
              <p className="text-xs text-slate-500">
                {lastMove ? 'No note on this move.' : 'Pick a move to read its note.'}
              </p>
            )}
            {lastMove?.annotation && (
              <p className="text-xs text-amber-300 mt-1">{lastMove.annotation}</p>
            )}
            {movesFromHere.length > 0 && (
              <p className="text-[10px] text-slate-500 mt-2">
                {fenTurn(currentFullFen) === heroColor ? 'Your move' : 'Their move'}:{' '}
                {movesFromHere.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => navigate(m.childFenKey, m.id)}
                    className={`font-mono mr-1.5 hover:text-emerald-300 ${
                      m.isDropped ? 'line-through text-slate-600' : ''
                    }`}
                  >
                    {m.san}
                  </button>
                ))}
              </p>
            )}
          </Card>

          <EnginePanel
            fen={currentFullFen}
            progress={engine.progress}
            ready={engine.ready}
            error={engine.error}
            enabled={engineEnabled}
            onToggleEnabled={() => setEngineEnabled((e) => !e)}
          />

          <RashidPanel
            fen={currentFullFen}
            state={rashid}
            enabled={rashidEnabled}
            onToggle={setRashidEnabled}
            precompute={scanForThis ? scan.progress : null}
            precomputing={scanForThis && scan.running}
            onStartPrecompute={() => void scan.start(active, { includeAlternates })}
            onCancelPrecompute={() => scan.cancel()}
          />

          <Card title="Study scan — findings">
            <label className="text-[10px] text-slate-400 flex items-center gap-2 mb-2">
              <input
                type="checkbox"
                checked={includeAlternates}
                onChange={(e) => setIncludeAlternates(e.target.checked)}
                disabled={scanForThis && scan.running}
              />
              include your alternates (not rehearsed)
            </label>
            {scan.error && scanForThis && (
              <p className="text-xs text-rose-300 mb-2">{scan.error}</p>
            )}
            {findings.length === 0 ? (
              <div className="text-xs text-slate-500">
                <p>
                  {scanForThis && scan.running
                    ? 'Scanning… positions where Rashid lights up will appear here.'
                    : 'Nothing reported yet.'}
                </p>
                {!(scanForThis && scan.running) && (
                  <div className="flex gap-2 pt-2">
                    <Btn onClick={() => void scan.start(active, { includeAlternates })}>
                      Scan whole study
                    </Btn>
                    <Btn
                      variant="ghost"
                      disabled={scanForThis && scan.cacheLoaded}
                      onClick={() => void scan.loadFromCache(active, { includeAlternates })}
                    >
                      Load from cache
                    </Btn>
                  </div>
                )}
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {findings.map((f) => (
                  <FindingRow
                    key={f.positionId}
                    f={f}
                    current={f.fenKey === currentFenKey}
                    onOpen={() => navigate(f.fenKey, f.viaMoveId)}
                  />
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

function FindingRow({
  f,
  current,
  onOpen,
}: {
  f: RashidFinding;
  current: boolean;
  onOpen: () => void;
}) {
  const line = f.best;
  return (
    <li>
      <button
        onClick={onOpen}
        className={`w-full text-left rounded border px-2 py-1.5 text-xs ${
          current ? 'border-emerald-700 bg-emerald-950/30' : 'border-slate-800 hover:bg-slate-800/60'
        }`}
      >
        <div className="font-mono text-slate-300 break-words">
          {f.pathSans.length ? f.pathSans.join(' ') : 'start'}
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">
          {line.length} pinch{line.length === 1 ? '' : 'es'} · risk{' '}
          <span className="font-mono">{formatRashidScore(line.riskScore)}</span> · reward ≥{' '}
          <span className="font-mono">
            {line.rewardFloor == null ? '—' : formatRashidScore(line.rewardFloor)}
          </span>
          {f.lineTags.length > 0 && <> · {f.lineTags.join(', ')}</>}
          {f.fromCache && <> · cached</>}
        </div>
      </button>
    </li>
  );
}
