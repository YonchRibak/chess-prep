import { useRef, useState } from 'react';
import { Chess } from 'chess.js';
import {
  DEFAULT_RASHID_CONFIG,
  STARTING_FEN,
  formatRashidScore,
  rashidAnalyze,
  type RashidResult,
} from '@chess-prep/shared';
import { Btn, Card } from '../components/ui.tsx';
import { getEngine } from '../lib/engine/engine.ts';
import { createRashidAnalyzeFn } from '../lib/engine/rashidAdapter.ts';

/**
 * Rashid lab (`#/rashid-lab`) — dev harness, not a product surface.
 *
 * 1. The plan-R0 measurement: time real wasm searches across node budgets and
 *    MultiPV widths, then project a per-position Rashid cost. These numbers
 *    pick DEPTH/NODES budgets and decide browser-vs-script precompute.
 * 2. A live calibration run: full `rashidAnalyze` on any FEN through the real
 *    adapter (cache ON — reruns show layer A working).
 */

/** Fixture positions built from SAN so the FENs can't be hand-typo'd. */
function fenAfter(sans: string[]): string {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
}

const MEASURE_POSITIONS = [
  { label: 'Start', fen: STARTING_FEN },
  {
    label: 'Giuoco middlegame',
    fen: fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O']),
  },
  {
    label: 'Najdorf',
    fen: fenAfter(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']),
  },
];

interface MeasureRow {
  label: string;
  nodes: number;
  multipv: number;
  ms: number;
}

/** The plan-C1 arithmetic: a typical position ≈ 1 wide root + ~6 opponent
 * checks + ~2 cheap hero picks (early exit does the rest). */
function estimatePerPositionMs(rows: MeasureRow[]): number | null {
  const at = (nodes: number, pv: number) =>
    rows.filter((r) => r.nodes === nodes && r.multipv === pv && r.label !== 'Start');
  const median = (xs: number[]) =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null;
  const root = median(at(300_000, 8).map((r) => r.ms));
  const opp = median(at(300_000, 4).map((r) => r.ms));
  const hero = median(at(300_000, 1).map((r) => r.ms));
  if (root == null || opp == null || hero == null) return null;
  return root + 6 * opp + 2 * hero;
}

export function RashidLab() {
  const [rows, setRows] = useState<MeasureRow[]>([]);
  const [measuring, setMeasuring] = useState(false);
  const [engineId, setEngineId] = useState<string | null>(null);

  const [fen, setFen] = useState(STARTING_FEN);
  const [nodes, setNodes] = useState(300_000);
  const [minLength, setMinLength] = useState(1);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [result, setResult] = useState<RashidResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  async function measure() {
    setMeasuring(true);
    setRows([]);
    cancelRef.current = false;
    setError(null);
    try {
      const engine = getEngine();
      await engine.init();
      setEngineId(engine.getEngineId());
      // Cache OFF: a hit would fake the timing.
      const combos: Array<{ label: string; fen: string; nodes: number; multipv: number }> = [];
      for (const p of MEASURE_POSITIONS) {
        for (const n of [100_000, 300_000, 1_000_000]) {
          combos.push({ ...p, nodes: n, multipv: 4 });
        }
      }
      // MultiPV sweep on the middlegame only — width scaling, not position scaling.
      const mid = MEASURE_POSITIONS[1]!;
      combos.push({ ...mid, nodes: 300_000, multipv: 1 });
      combos.push({ ...mid, nodes: 300_000, multipv: 8 });

      for (const c of combos) {
        if (cancelRef.current) break;
        const fn = createRashidAnalyzeFn({ nodes: c.nodes, engine, cache: null });
        const t0 = performance.now();
        await fn(c.fen, c.multipv);
        const ms = Math.round(performance.now() - t0);
        setRows((prev) => [...prev, { label: c.label, nodes: c.nodes, multipv: c.multipv, ms }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMeasuring(false);
    }
  }

  async function runRashid() {
    setRunning(true);
    setResult(null);
    setElapsed(null);
    setError(null);
    try {
      const hero = new Chess(fen).turn(); // rashidAnalyze requires hero to move
      const fn = createRashidAnalyzeFn({ nodes });
      const t0 = performance.now();
      const r = await rashidAnalyze(fen, hero, fn, {
        ...DEFAULT_RASHID_CONFIG,
        minLengthToDisplay: minLength,
      });
      setElapsed(Math.round(performance.now() - t0));
      setResult(r);
      setEngineId(getEngine().getEngineId());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function sanLine(rootFen: string, ucis: string[]): string {
    const c = new Chess(rootFen);
    return ucis
      .map((u) => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined }).san)
      .join(' ');
  }

  const est = estimatePerPositionMs(rows);

  return (
    <div className="w-full max-w-4xl flex flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Rashid lab</h2>
        <span className="text-xs text-slate-500">
          dev harness · {engineId ?? 'engine not started'}
        </span>
      </header>

      <Card title="R0 — throughput measurement">
        <p className="text-xs text-slate-400 mb-3">
          Times real searches (cache off) across node budgets and MultiPV widths, then
          projects a per-position Rashid cost (1×pv8 root + 6×pv4 checks + 2×pv1). Record
          the outcome in rashid-dev-plan.md — it picks the budgets and the precompute venue.
        </p>
        <div className="flex gap-2 mb-3">
          <Btn variant="primary" onClick={() => void measure()} disabled={measuring}>
            {measuring ? 'Measuring…' : 'Run measurement'}
          </Btn>
          {measuring && <Btn onClick={() => (cancelRef.current = true)}>Cancel</Btn>}
        </div>
        {rows.length > 0 && (
          <table className="text-xs w-full">
            <thead>
              <tr className="text-slate-500 text-left">
                <th className="py-1">Position</th>
                <th>Nodes</th>
                <th>MultiPV</th>
                <th className="text-right">ms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-700/50">
                  <td className="py-1">{r.label}</td>
                  <td>{r.nodes.toLocaleString()}</td>
                  <td>{r.multipv}</td>
                  <td className="text-right tabular-nums">{r.ms.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {est != null && (
          <p className="text-xs text-slate-300 mt-3">
            Estimated per-position cost at 300k nodes: <b>{(est / 1000).toFixed(1)}s</b> →
            a 300-position repertoire ≈ <b>{((est * 300) / 3_600_000).toFixed(1)}h</b> of
            background precompute.
          </p>
        )}
      </Card>

      <Card title="Live rashidAnalyze (adapter + layer-A cache)">
        <div className="flex flex-col gap-2 mb-3">
          <label className="text-xs text-slate-400">
            FEN (hero = side to move)
            <input
              className="w-full mt-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs font-mono"
              value={fen}
              onChange={(e) => setFen(e.target.value)}
            />
          </label>
          <div className="flex gap-4 items-end">
            <label className="text-xs text-slate-400">
              Node budget
              <input
                type="number"
                className="w-28 mt-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs block"
                value={nodes}
                onChange={(e) => setNodes(Number(e.target.value) || 300_000)}
              />
            </label>
            <label className="text-xs text-slate-400">
              Min length to light up
              <input
                type="number"
                min={1}
                className="w-16 mt-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs block"
                value={minLength}
                onChange={(e) => setMinLength(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <Btn variant="primary" onClick={() => void runRashid()} disabled={running}>
              {running ? 'Analyzing…' : 'Run Rashid'}
            </Btn>
            {elapsed != null && <span className="text-xs text-slate-500">{(elapsed / 1000).toFixed(1)}s</span>}
          </div>
        </div>

        {result && (
          <div className="text-xs flex flex-col gap-2">
            <p>
              {result.lightsUp ? '🟢 lights up' : '⚫ no qualifying trap'} · best root eval{' '}
              <b>{formatRashidScore(result.bestRootScore)}</b> · {result.lines.length} candidate line(s)
            </p>
            {result.lines.map((l) => (
              <div
                key={l.rootUci}
                className={`rounded border px-2 py-1 ${
                  l === result.best ? 'border-emerald-600' : 'border-slate-700'
                }`}
              >
                <p className="font-mono">{sanLine(fen, l.line)}</p>
                <p className="text-slate-400">
                  Length <b>{l.length}</b> · Risk <b>{formatRashidScore(l.riskScore)}</b> · Reward
                  floor <b>{l.rewardFloor != null ? formatRashidScore(l.rewardFloor) : '—'}</b>
                  {l.rewardMax != null && l.rewardMax !== l.rewardFloor && (
                    <> (jackpot {formatRashidScore(l.rewardMax)})</>
                  )}{' '}
                  · sacrifice {(l.sacrifice * 100).toFixed(1)}pp
                </p>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      </Card>
    </div>
  );
}
