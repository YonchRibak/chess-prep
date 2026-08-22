/**
 * Flow F2: "Prepare against…" — the guided-session wizard.
 *
 * One flow that assembles existing machinery end to end: name the target
 * opening (type-ahead over the ECO book), infer the user's color (one tap to
 * flip), pick the destination repertoire (fenKey match decides extend vs
 * create), set the finish line (a prep target = reply-share floor + depth
 * cap), then launch a guided walker build session.
 *
 * The stem is committed BEFORE the session starts (create with seedSans, or
 * an idempotent appendLine): under a non-'all' scope the walker never offers
 * the root, so a scoped build is only startable once the line exists
 * ([walker.md](../../../knowledge/03-domain/walker.md#scoped-building)).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import {
  fullOpeningName,
  inferPrepColor,
  PREP_TARGET_PRESETS,
  STARTING_FEN,
  fenKey as makeFenKey,
  type Color,
  type PrepTarget,
} from '@chess-prep/shared';
import { useAppStore } from '../store/app.ts';
import { Btn, Card } from '../components/ui.tsx';
import { api, ApiError, type OpeningListItem, type RepertoireSummary } from '../api/client.ts';
import { getAllRepertoiresLocal } from '../lib/idb/schema.ts';

type PresetKey = keyof typeof PREP_TARGET_PRESETS;

const PRESET_LABELS: Record<PresetKey, string> = {
  default: 'Standard — replies in ≥ 1 in 20 games',
  broader: 'Broader — ≥ 1 in 50 games',
  mainLines: 'Main lines only — ≥ 1 in 5 games',
};

export function PrepareWizard() {
  const go = useAppStore((s) => s.go);
  const repertoires = useAppStore((s) => s.repertoires);
  const loadList = useAppStore((s) => s.loadList);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OpeningListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<OpeningListItem | null>(null);
  const [color, setColor] = useState<Color>('white');
  const [destination, setDestination] = useState<string | 'new'>('new');
  const [matchingIds, setMatchingIds] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<PresetKey>('default');
  const [depth, setDepth] = useState<number>(PREP_TARGET_PRESETS.default.maxDepthPlies);
  const [launching, setLaunching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingSwap, setPendingSwap] = useState<{ targetId: string } | null>(null);

  useEffect(() => {
    if (repertoires.length === 0) void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Type-ahead search, debounced like the opening browser's.
  const lastQ = useRef('');
  useEffect(() => {
    const q = query.trim();
    if (q === lastQ.current) return;
    const handle = setTimeout(() => {
      lastQ.current = q;
      if (!q) {
        setResults([]);
        return;
      }
      setSearching(true);
      api
        .listOpenings({ q, limit: 40 })
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 150);
    return () => clearTimeout(handle);
  }, [query]);

  const stemSans = useMemo(() => (target ? pgnToSans(target.pgnMoves) : []), [target]);
  const targetName = target
    ? fullOpeningName({ eco: target.eco, name: target.name, variation: target.variation })!
    : null;

  /** Pick a target: infer the color, find repertoires already containing the stem. */
  async function selectTarget(o: OpeningListItem) {
    setTarget(o);
    setErr(null);
    const inferred = inferPrepColor(o.pgnMoves);
    setColor(inferred);
    await refreshDestinations(o, inferred);
  }

  /**
   * Destination default: an existing repertoire of this color that already
   * contains the stem position (fenKey lookup over the local full snapshots) →
   * extend it; otherwise create. The user never has to know repertoires are
   * trees and openings subtrees — the fenKey match decides.
   */
  async function refreshDestinations(o: OpeningListItem, forColor: Color) {
    const local = await getAllRepertoiresLocal();
    const matches = new Set<string>();
    for (const rep of local) {
      if (rep.color !== forColor) continue;
      if (rep.positions.some((p) => p.fenKey === o.fenKey)) matches.add(rep.id);
    }
    setMatchingIds(matches);
    const first = repertoires.find((r) => matches.has(r.id));
    setDestination(first ? first.id : 'new');
  }

  function flipColor() {
    const next = color === 'white' ? 'black' : 'white';
    setColor(next);
    if (target) void refreshDestinations(target, next);
  }

  async function launch(onConflict?: 'swap') {
    if (!target || !targetName) return;
    setErr(null);
    setLaunching(true);
    try {
      const prepTarget: PrepTarget = {
        minShare: PREP_TARGET_PRESETS[preset].minShare,
        maxDepthPlies: depth,
      };
      let repId: string;
      if (destination === 'new') {
        const created = await api.createRepertoire({
          name: `vs ${targetName}`,
          color,
          seedSans: stemSans,
        });
        repId = created.id;
      } else {
        repId = destination;
        // Idempotent stem commit — a re-run is `added: 0, reused: N`. A 409 is
        // the one-prep invariant: the stem crosses existing prep somewhere.
        await api.appendLine(repId, {
          fromFenKey: makeFenKey(STARTING_FEN),
          sans: stemSans,
          ...(onConflict ? { onConflict } : {}),
        });
      }
      // Persist the target as this repertoire's last-used growth setting.
      const existing =
        destination === 'new'
          ? {}
          : repertoires.find((r) => r.id === repId)?.drillRules ?? {};
      await api.patchDrillRules(repId, { ...existing, prepTarget });
      await useAppStore.getState().loadRepertoire(repId);
      go({
        kind: 'walker-session',
        repertoireId: repId,
        seed: 'build',
        scope: { kind: 'openingName', value: targetName },
        guided: true,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && destination !== 'new') {
        setPendingSwap({ targetId: destination });
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLaunching(false);
    }
  }

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
          <h2 className="text-lg font-semibold">Prepare against…</h2>
        </div>
        <Btn variant="ghost" onClick={() => go({ kind: 'browse' })}>
          Start from a position instead
        </Btn>
      </header>

      <Card title="1 · Name the target">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Caro-Kann, Najdorf, Winawer…"
          autoFocus
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
        />
        {searching && <p className="text-xs text-slate-500 mt-2">Searching…</p>}
        {results.length > 0 && (
          <ul className="flex flex-col mt-2 max-h-64 overflow-y-auto pr-1">
            {results.map((o) => {
              const full = fullOpeningName({ eco: o.eco, name: o.name, variation: o.variation });
              const selected = target?.id === o.id;
              return (
                <li key={o.id}>
                  <button
                    onClick={() => void selectTarget(o)}
                    className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-slate-800 ${
                      selected ? 'bg-slate-800 text-emerald-300' : ''
                    }`}
                  >
                    <span className="text-slate-500 mr-1 font-mono">{o.eco}</span>
                    {full}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {target && targetName && (
        <>
          <Card title="2 · Your color">
            <p className="text-xs text-slate-300">
              You'll prepare as{' '}
              <span className="font-semibold">
                {color === 'white' ? '♔ White' : '♚ Black'}
              </span>{' '}
              against the {targetName}.
            </p>
            <div className="pt-2">
              <Btn onClick={flipColor}>Flip — prepare as {color === 'white' ? 'Black' : 'White'}</Btn>
            </div>
          </Card>

          <Card title="3 · Where it goes">
            <div className="flex flex-col gap-1 text-xs">
              {repertoires
                .filter((r) => r.color === color)
                .map((r) => (
                  <DestinationRow
                    key={r.id}
                    rep={r}
                    selected={destination === r.id}
                    containsStem={matchingIds.has(r.id)}
                    onSelect={() => setDestination(r.id)}
                  />
                ))}
              <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-800 cursor-pointer">
                <input
                  type="radio"
                  checked={destination === 'new'}
                  onChange={() => setDestination('new')}
                  className="accent-emerald-500"
                />
                <span>
                  New repertoire: <span className="font-medium">vs {targetName}</span>
                </span>
              </label>
            </div>
          </Card>

          <Card title="4 · Finish line">
            <div className="flex flex-col gap-1 text-xs">
              {(Object.keys(PRESET_LABELS) as PresetKey[]).map((k) => (
                <label
                  key={k}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-800 cursor-pointer"
                >
                  <input
                    type="radio"
                    checked={preset === k}
                    onChange={() => setPreset(k)}
                    className="accent-emerald-500"
                  />
                  <span>{PRESET_LABELS[k]}</span>
                </label>
              ))}
              <label className="flex items-center gap-2 px-2 py-1">
                <span className="text-slate-400">Depth:</span>
                <input
                  type="number"
                  min={4}
                  max={30}
                  value={depth}
                  onChange={(e) => setDepth(Math.max(4, Math.min(30, Number(e.target.value) || 12)))}
                  className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono"
                />
                <span className="text-slate-500">plies (~{Math.round(depth / 2)} moves)</span>
              </label>
            </div>
          </Card>

          {err && <p className="text-xs text-rose-300">{err}</p>}

          {pendingSwap ? (
            <Card title="Stem crosses existing prep">
              <p className="text-xs text-slate-300">
                Somewhere along {stemSans.join(' ')} this repertoire already has a
                different prepared move. Replace it with the stem?
              </p>
              <p className="text-[10px] text-slate-500 mt-1">
                The SRS history of the replaced move will be lost.
              </p>
              <div className="flex gap-2 pt-2">
                <Btn
                  variant="danger"
                  onClick={() => {
                    setPendingSwap(null);
                    void launch('swap');
                  }}
                >
                  Replace and start
                </Btn>
                <Btn onClick={() => setPendingSwap(null)}>Cancel</Btn>
              </div>
            </Card>
          ) : (
            <div>
              <Btn variant="primary" disabled={launching} onClick={() => void launch()}>
                {launching ? 'Setting up…' : 'Start preparing →'}
              </Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DestinationRow({
  rep,
  selected,
  containsStem,
  onSelect,
}: {
  rep: RepertoireSummary;
  selected: boolean;
  containsStem: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-800 cursor-pointer">
      <input
        type="radio"
        checked={selected}
        onChange={onSelect}
        className="accent-emerald-500"
      />
      <span className="flex-1">
        Extend <span className="font-medium">{rep.name}</span>
      </span>
      {containsStem && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-200 border border-emerald-800/60">
          already contains this line
        </span>
      )}
    </label>
  );
}

function pgnToSans(pgn: string): string[] {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch {
    return [];
  }
  return chess.history();
}
