/**
 * Phase 6: Opening database browser.
 *
 * Left pane: search by name + ECO filter, results grouped by base name.
 * Right pane: board + auto-name header + step-through controls + free play.
 * Bottom action: "Add to my repertoire" — commits the navigated path of SANs
 * to an existing or new repertoire (idempotent on (parent, san)).
 *
 * The board is a thin local-state view — nothing is persisted until the user
 * explicitly hits "Add to my repertoire". Engine analysis is intentionally
 * NOT wired up here; the focus is exploration. Phase 8 adds an engine panel
 * here, gated by the drill flag.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { fenKey as makeFenKey, STARTING_FEN, type Color } from '@chess-prep/shared';
import type { BoardColor } from '../lib/chess/useBoard.ts';
import { useAppStore } from '../store/app.ts';
import { useChessRules } from '../lib/chess/useChessRules.ts';
import { Board } from '../components/Board.tsx';
import { Btn, Card } from '../components/ui.tsx';
import { OpeningHeader } from '../components/OpeningHeader.tsx';
import { useDeepestOpeningId } from '../lib/openings/useOpeningId.ts';
import { EnginePanel } from '../components/EnginePanel.tsx';
import { BlankRepertoireModal, ImportPgnModal } from '../components/RepertoireModals.tsx';
import { useEngine } from '../lib/engine/useEngine.ts';
import { engineArrows } from '../lib/engine/arrows.ts';
import { api, type OpeningListItem, ApiError } from '../api/client.ts';

const ECO_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
type EcoLetter = (typeof ECO_LETTERS)[number];

export function BrowseOpenings() {
  const go = useAppStore((s) => s.go);
  const createRepertoire = useAppStore((s) => s.createRepertoire);
  const importPgn = useAppStore((s) => s.importPgn);
  const [query, setQuery] = useState('');
  const [ecoFilter, setEcoFilter] = useState<string>('');
  const [results, setResults] = useState<OpeningListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<BoardColor>('white');

  // Local navigation state: sans played from STARTING_FEN.
  const [line, setLine] = useState<string[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showBlank, setShowBlank] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [engineEnabled, setEngineEnabled] = useState(false);

  // Derived: each FEN along the path (including the starting position).
  const pathFens = useMemo(() => fensAlongLine(line), [line]);
  const currentFullFen = pathFens[pathFens.length - 1]!;
  const currentFenKey = useMemo(() => makeFenKey(currentFullFen), [currentFullFen]);

  // Drive the board from currentFullFen (re-mount the rules with new FEN).
  const rules = useChessRulesPinnedTo(currentFullFen);

  // Phase 8b: engine analysis available in the browser (free study). Gated
  // off while a Walker/Drill session is mounted (handled at the engine
  // singleton). When the user toggles "show eval" here, we honor it
  // immediately — the singleton tracks gated separately.
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

  // Debounced search.
  const lastQueryRef = useRef({ q: '', eco: '' });
  useEffect(() => {
    const q = query.trim();
    const eco = ecoFilter.trim().toUpperCase();
    if (q === lastQueryRef.current.q && eco === lastQueryRef.current.eco) return;
    const handle = setTimeout(() => {
      lastQueryRef.current = { q, eco };
      setLoading(true);
      setSearchErr(null);
      api
        .listOpenings({ q: q || undefined, eco: eco || undefined, limit: 150 })
        .then((rows) => setResults(rows))
        .catch((e: unknown) => {
          setSearchErr(e instanceof ApiError ? e.message : String(e));
          setResults([]);
        })
        .finally(() => setLoading(false));
    }, 120);
    return () => clearTimeout(handle);
  }, [query, ecoFilter]);

  // Initial: nothing — encourages a query / ECO pick.
  function pickOpening(o: OpeningListItem) {
    // Translate the pgnMoves into a SAN list.
    const sans = pgnToSans(o.pgnMoves);
    setLine(sans);
  }

  function playMove(san: string) {
    setLine((prev) => [...prev, san]);
  }

  function goToPly(plyIndex: number) {
    // plyIndex is the *number of plies* to keep, 0 = start.
    setLine((prev) => prev.slice(0, plyIndex));
  }

  function flip() {
    setOrientation((o) => (o === 'white' ? 'black' : 'white'));
  }

  // Group results by base name for the list.
  const grouped = useMemo(() => groupByName(results), [results]);

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
          <div className="flex flex-col">
            <h2 className="text-lg font-semibold">Browse openings</h2>
            <p className="text-[10px] text-slate-500">
              Pick a line, step through it on the board, then save it into a new or
              existing repertoire.
            </p>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <Btn variant="ghost" onClick={() => setShowBlank(true)}>
            Start blank
          </Btn>
          <Btn variant="ghost" onClick={() => setShowImport(true)}>
            Import PGN
          </Btn>
          <Btn
            variant="primary"
            disabled={line.length === 0}
            onClick={() => setShowAdd(true)}
            title={line.length === 0 ? 'Play or pick a line first' : 'Save this line into a repertoire'}
          >
            Add to my repertoire
          </Btn>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-6">
        {/* Left: search + results */}
        <aside className="flex flex-col gap-3 text-sm">
          <Card title="Search">
            <div className="flex flex-col gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Caro-Kann, Najdorf, …"
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
              />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-slate-500 mr-1">ECO</span>
                <button
                  onClick={() => setEcoFilter('')}
                  className={`text-[10px] px-2 py-0.5 rounded border ${
                    ecoFilter === ''
                      ? 'border-emerald-700 bg-emerald-900/40 text-emerald-200'
                      : 'border-slate-700 hover:bg-slate-800'
                  }`}
                >
                  Any
                </button>
                {ECO_LETTERS.map((l) => (
                  <button
                    key={l}
                    onClick={() => setEcoFilter((cur) => (cur === l ? '' : l))}
                    className={`text-[10px] px-2 py-0.5 rounded border ${
                      ecoFilter === l
                        ? 'border-emerald-700 bg-emerald-900/40 text-emerald-200'
                        : 'border-slate-700 hover:bg-slate-800'
                    }`}
                  >
                    {l}
                  </button>
                ))}
                <input
                  value={
                    ECO_LETTERS.includes(ecoFilter as EcoLetter) || ecoFilter === ''
                      ? ''
                      : ecoFilter
                  }
                  onChange={(e) => setEcoFilter(e.target.value.toUpperCase().slice(0, 3))}
                  placeholder="B12"
                  className="w-14 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[10px] font-mono"
                />
              </div>
            </div>
          </Card>

          <Card title={loading ? 'Searching…' : `Results (${results.length})`}>
            {searchErr && <p className="text-xs text-rose-300">{searchErr}</p>}
            {results.length === 0 && !loading && !searchErr && (
              <p className="text-xs text-slate-500">
                Search by name (e.g. "Sicilian"), pick an ECO letter, or type a code (e.g. "B12").
              </p>
            )}
            <ul className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
              {grouped.map((g) => (
                <li key={g.name} className="flex flex-col">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">
                    {g.name}
                  </div>
                  <ul className="flex flex-col">
                    {g.items.map((o) => (
                      <li key={o.id}>
                        <button
                          onClick={() => pickOpening(o)}
                          className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-slate-800 ${
                            o.fenKey === currentFenKey ? 'bg-slate-800 text-emerald-300' : ''
                          }`}
                        >
                          <span className="text-slate-500 mr-1">{o.eco}</span>
                          {o.variation ?? <span className="italic text-slate-400">main</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Card>
        </aside>

        {/* Right: board + nav + breadcrumb */}
        <section className="flex flex-col items-center gap-3">
          <OpeningHeader pathFens={pathFens} className="self-start" />
          <Board
            rules={rules}
            orientation={orientation}
            shapes={engineShapes}
            onMovePlayed={(san) => playMove(san)}
          />
          <div className="flex flex-wrap gap-2 justify-center">
            <Btn disabled={line.length === 0} onClick={() => setLine([])}>
              ⏮ Start
            </Btn>
            <Btn disabled={line.length === 0} onClick={() => goToPly(line.length - 1)}>
              ← Back
            </Btn>
            <Btn onClick={flip}>Flip</Btn>
          </div>
          <Breadcrumb sans={line} onJump={goToPly} />
          <p className="text-[10px] text-slate-500 font-mono break-all max-w-full">
            {currentFullFen}
          </p>
          <div className="w-full max-w-[640px]">
            <EnginePanel
              fen={currentFullFen}
              progress={engine.progress}
              ready={engine.ready}
              error={engine.error}
              enabled={engineEnabled}
              onToggleEnabled={() => setEngineEnabled((e) => !e)}
            />
          </div>
        </section>
      </div>

      {showAdd && (
        <AddToRepertoireModal
          sans={line}
          currentFenAfter={currentFullFen}
          pathFens={pathFens}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showBlank && (
        <BlankRepertoireModal
          onClose={() => setShowBlank(false)}
          onSubmit={async (input) => {
            const id = await createRepertoire(input);
            setShowBlank(false);
            await useAppStore.getState().openRepertoire(id);
          }}
        />
      )}
      {showImport && (
        <ImportPgnModal
          onClose={() => setShowImport(false)}
          onSubmit={async (input) => {
            const id = await importPgn(input);
            setShowImport(false);
            await useAppStore.getState().openRepertoire(id);
          }}
        />
      )}
    </div>
  );
}

/* ---------------- subcomponents ---------------- */

function Breadcrumb({ sans, onJump }: { sans: string[]; onJump: (plyIndex: number) => void }) {
  if (sans.length === 0) return <p className="text-xs text-slate-500">Starting position</p>;
  return (
    <ol className="flex flex-wrap gap-x-2 gap-y-1 text-xs font-mono">
      <li>
        <button onClick={() => onJump(0)} className="hover:text-emerald-300 text-slate-500">
          start
        </button>
      </li>
      {sans.map((san, i) => (
        <li key={`${i}-${san}`}>
          <button
            onClick={() => onJump(i + 1)}
            className={`hover:text-emerald-300 ${i === sans.length - 1 ? 'text-emerald-300' : ''}`}
          >
            {i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : ''}
            {san}
          </button>
        </li>
      ))}
    </ol>
  );
}

function AddToRepertoireModal({
  sans,
  currentFenAfter,
  pathFens,
  onClose,
}: {
  sans: string[];
  currentFenAfter: string;
  pathFens: string[];
  onClose: () => void;
}) {
  const repertoires = useAppStore((s) => s.repertoires);
  const loadList = useAppStore((s) => s.loadList);
  const createRepertoire = useAppStore((s) => s.createRepertoire);

  // Hydrate the list if it's not loaded yet — the user may land on Browse
  // without ever visiting the list view.
  useEffect(() => {
    if (repertoires.length === 0) void loadList();
  }, [repertoires.length, loadList]);

  // Suggest a name from the deepest matched opening so creating a new
  // repertoire from "Caro-Kann Defense, Advance Variation" just works.
  // Uses the same lookup the header uses, so it's a cache hit in practice.
  const pathFenKeys = useMemo(() => {
    const out: string[] = [];
    for (const f of pathFens) {
      try {
        out.push(makeFenKey(f));
      } catch {
        // skip
      }
    }
    return out;
  }, [pathFens]);
  const { opening } = useDeepestOpeningId(pathFenKeys);
  const suggestedName = opening
    ? opening.variation
      ? `${opening.name}, ${opening.variation}`
      : opening.name
    : '';

  const [mode, setMode] = useState<'existing' | 'new'>(repertoires.length > 0 ? 'existing' : 'new');
  const [selectedId, setSelectedId] = useState<string>(repertoires[0]?.id ?? '');
  const [newName, setNewName] = useState(suggestedName);
  const [nameTouched, setNameTouched] = useState(false);
  const [newColor, setNewColor] = useState<Color>('white');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    added: number;
    reused: number;
    targetId: string;
  } | null>(null);

  // Keep selectedId in sync when the list loads in.
  useEffect(() => {
    if (!selectedId && repertoires.length > 0) setSelectedId(repertoires[0]!.id);
  }, [repertoires, selectedId]);

  // Suggestion arrives async after the lookup — apply it once unless the user
  // has already typed something.
  useEffect(() => {
    if (!nameTouched && suggestedName && newName === '') {
      setNewName(suggestedName);
    }
  }, [suggestedName, nameTouched, newName]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      let targetId = selectedId;
      if (mode === 'new') {
        if (!newName.trim()) throw new Error('Name is required');
        targetId = await createRepertoire({ name: newName.trim(), color: newColor });
      }
      if (!targetId) throw new Error('Pick a repertoire');
      const r = await api.appendLine(targetId, {
        fromFenKey: makeFenKey(STARTING_FEN),
        sans,
      });
      setResult({ added: r.added, reused: r.reused, targetId });
      void useAppStore.getState().loadList();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-md border border-slate-800 bg-slate-900 p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">Add line to repertoire</h3>
        <p className="text-xs text-slate-400">
          {sans.length} {sans.length === 1 ? 'move' : 'moves'} from start. Existing
          moves are reused — no duplicates.
        </p>
        <p className="text-[10px] font-mono text-slate-500 break-all">{currentFenAfter}</p>

        {result ? (
          <div className="flex flex-col gap-3">
            <div className="text-sm">
              ✅ Added <strong>{result.added}</strong> new{' '}
              {result.added === 1 ? 'move' : 'moves'}, reused{' '}
              <strong>{result.reused}</strong>.
            </div>
            <div className="flex gap-2 justify-end">
              <Btn onClick={onClose}>Keep browsing</Btn>
              <Btn
                variant="primary"
                onClick={() => {
                  void (async () => {
                    const store = useAppStore.getState();
                    await store.openRepertoire(result.targetId);
                    store.go({
                      kind: 'walker-session',
                      repertoireId: result.targetId,
                      seed: 'build',
                    });
                  })();
                }}
              >
                Start building →
              </Btn>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('existing')}
                disabled={repertoires.length === 0}
                className={`flex-1 text-xs px-2 py-1.5 rounded border ${
                  mode === 'existing'
                    ? 'border-emerald-700 bg-emerald-900/40 text-emerald-200'
                    : 'border-slate-700'
                } disabled:opacity-40`}
              >
                Add to existing
              </button>
              <button
                type="button"
                onClick={() => setMode('new')}
                className={`flex-1 text-xs px-2 py-1.5 rounded border ${
                  mode === 'new'
                    ? 'border-emerald-700 bg-emerald-900/40 text-emerald-200'
                    : 'border-slate-700'
                }`}
              >
                Create new
              </button>
            </div>

            {mode === 'existing' ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-400">Repertoire</span>
                <select
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
                >
                  {repertoires.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.color})
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">Name</span>
                  <input
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      setNameTouched(true);
                    }}
                    autoFocus
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
                    placeholder="e.g. King's Indian as Black"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">Color</span>
                  <select
                    value={newColor}
                    onChange={(e) => setNewColor(e.target.value as Color)}
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
                  >
                    <option value="white">White</option>
                    <option value="black">Black</option>
                  </select>
                </label>
              </>
            )}

            {err && <p className="text-xs text-rose-300">{err}</p>}

            <div className="flex gap-2 justify-end pt-2">
              <Btn type="button" onClick={onClose}>
                Cancel
              </Btn>
              <Btn type="submit" variant="primary" disabled={submitting}>
                {submitting ? 'Adding…' : 'Add'}
              </Btn>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ---------------- helpers ---------------- */

/**
 * useChessRules normally owns its own move history. For the browser we drive
 * the position entirely from a SAN list — wrap useChessRules so it reloads
 * whenever the upstream fen changes.
 */
function useChessRulesPinnedTo(fullFen: string) {
  const rules = useChessRules(STARTING_FEN);
  useEffect(() => {
    rules.load(fullFen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullFen]);
  return rules;
}

function fensAlongLine(sans: string[]): string[] {
  const out: string[] = [STARTING_FEN];
  const chess = new Chess();
  for (const san of sans) {
    try {
      chess.move(san);
    } catch {
      break;
    }
    out.push(chess.fen());
  }
  return out;
}

function pgnToSans(pgn: string): string[] {
  // pgnMoves from the book is a bare SAN sequence like "1. e4 c6 2. d4 d5".
  // Replay through chess.js so we get just the SAN tokens, normalized.
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch {
    return [];
  }
  return chess.history();
}

function groupByName(items: OpeningListItem[]): Array<{ name: string; items: OpeningListItem[] }> {
  const m = new Map<string, OpeningListItem[]>();
  for (const it of items) {
    const arr = m.get(it.name) ?? [];
    arr.push(it);
    m.set(it.name, arr);
  }
  return [...m.entries()].map(([name, arr]) => ({
    name,
    items: arr.sort((a, b) => {
      // Bare opening (no variation) first, then alphabetical by variation.
      if (a.variation === null && b.variation !== null) return -1;
      if (a.variation !== null && b.variation === null) return 1;
      return (a.variation ?? '').localeCompare(b.variation ?? '');
    }),
  }));
}
