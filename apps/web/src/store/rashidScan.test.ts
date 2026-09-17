/**
 * Rashid study scan store (S4). What matters: only lit positions become
 * findings and each carries a clickable path; a rerun on the same study
 * keeps its findings while a different study resets them; cancel stops the
 * run and a stale run cannot write into a newer one; `loadFromCache`
 * reproduces findings from layer B — precompute tier first — without an
 * engine; and the cache key it reads is exactly the key the writer uses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Chess } from 'chess.js';
import {
  DEFAULT_RASHID_CONFIG,
  fenKey,
  rashidConfigKey,
  STARTING_FEN,
  type RashidLine,
  type RashidResult,
} from '@chess-prep/shared';
import type { RepertoireFull, RepertoireMove, RepertoirePosition } from '../api/client.ts';
import {
  LIVE_TIER,
  NODES_PRECOMPUTE,
  PRECOMPUTE_TIER,
  rashidResultKey,
  resultKeyForTier,
} from '../lib/engine/rashidLive.ts';
import type { RashidResultEntry } from '../lib/idb/schema.ts';
import { useRashidScan } from './rashidScan.ts';

let nextId = 0;
function pos(fullFen: string): RepertoirePosition {
  return { id: `p${nextId++}`, fenKey: fenKey(fullFen) as string, fullFen };
}
function move(parent: RepertoirePosition, child: RepertoirePosition, san: string, flags: Partial<RepertoireMove> = {}): RepertoireMove {
  const m = new Chess(parent.fullFen).move(san);
  return {
    id: `m${nextId++}`,
    parentPositionId: parent.id,
    childPositionId: child.id,
    parentFenKey: parent.fenKey,
    childFenKey: child.fenKey,
    san,
    uci: m.from + m.to,
    comment: null,
    annotation: null,
    isMainLine: true,
    priority: 0,
    isDropped: false,
    lineTags: ['Main'],
    isRefutation: false,
    origin: 'user',
    ...flags,
  };
}
function after(sans: string[]): string {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
}

/** White study: root ─e4→ b1 ─e5→ w2 ─Nf3→ b2 ─Nc6→ w3 ; root ─d4→ (dropped) bd ─d5→ wd */
function study(id = 'study1'): { rep: RepertoireFull; root: RepertoirePosition; w2: RepertoirePosition; w3: RepertoirePosition; wd: RepertoirePosition } {
  nextId = 0;
  const root = pos(STARTING_FEN);
  const b1 = pos(after(['e4']));
  const w2 = pos(after(['e4', 'e5']));
  const b2 = pos(after(['e4', 'e5', 'Nf3']));
  const w3 = pos(after(['e4', 'e5', 'Nf3', 'Nc6']));
  const bd = pos(after(['d4']));
  const wd = pos(after(['d4', 'd5']));
  const rep: RepertoireFull = {
    id,
    name: id,
    color: 'white',
    tags: [],
    drillRules: {},
    autoExpand: false,
    source: {
      kind: 'lichess-study',
      studyName: 's',
      studyUrl: null,
      chapters: [{ tag: 'Main', name: 'Main', url: null }],
      pgnSha256: 'x',
      importedAt: '',
    },
    rootFenKey: root.fenKey,
    rootFullFen: root.fullFen,
    createdAt: '',
    updatedAt: '',
    positions: [root, b1, w2, b2, w3, bd, wd],
    moves: [
      move(root, b1, 'e4'),
      move(b1, w2, 'e5'),
      move(w2, b2, 'Nf3'),
      move(b2, w3, 'Nc6'),
      move(root, bd, 'd4', { isDropped: true, isMainLine: false, lineTags: ['Alt'] }),
      move(bd, wd, 'd5', { lineTags: ['Alt'] }),
    ],
  };
  return { rep, root, w2, w3, wd };
}

const LINE: RashidLine = {
  rootUci: 'e2e4',
  line: ['e2e4'],
  pinchPoints: [{ ply: 1, moveUci: 'e7e5', missScore: 300 }],
  length: 1,
  riskScore: 20,
  rewardFloor: 300,
  rewardMax: 300,
  sacrifice: 0,
};
const LIT: RashidResult = { lightsUp: true, best: LINE, lines: [LINE], bestRootScore: 20, candidates: [] };
const DARK: RashidResult = { lightsUp: false, best: null, lines: [], bestRootScore: 0, candidates: [] };

const noSleep = async () => {};
const notDrilling = () => false;

beforeEach(() => {
  useRashidScan.setState({
    repertoireId: null,
    running: false,
    progress: null,
    findings: [],
    cacheLoaded: false,
    error: null,
  });
});

describe('useRashidScan.start', () => {
  it('keeps only lit positions, with their path, and includes alternates for a study', async () => {
    const { rep, w2, wd } = study();
    await useRashidScan.getState().start(rep, {
      sleep: noSleep,
      isDrilling: notDrilling,
      compute: async (fen) => ({
        result: fenKey(fen) === w2.fenKey || fenKey(fen) === wd.fenKey ? LIT : DARK,
        fromCache: false,
      }),
    });
    const s = useRashidScan.getState();
    expect(s.running).toBe(false);
    expect(s.repertoireId).toBe(rep.id);
    expect(s.progress?.total).toBe(4); // root, w2, wd (alternate), w3
    expect(s.findings.map((f) => f.pathSans.join(' '))).toEqual(['e4 e5', 'd4 d5']);
    expect(s.findings[0]).toMatchObject({ positionId: w2.id, lineTags: ['Main'], best: LINE });
    expect(s.findings[1]!.lineTags).toEqual(['Alt']);
  });

  it('honours includeAlternates: false', async () => {
    const { rep } = study();
    await useRashidScan.getState().start(rep, {
      includeAlternates: false,
      sleep: noSleep,
      isDrilling: notDrilling,
      compute: async () => ({ result: DARK, fromCache: false }),
    });
    expect(useRashidScan.getState().progress?.total).toBe(3);
  });

  it('a rerun on the same study keeps findings; another study resets them', async () => {
    const { rep, w2 } = study();
    const lit = async (fen: string) => ({ result: fenKey(fen) === w2.fenKey ? LIT : DARK, fromCache: false });
    await useRashidScan.getState().start(rep, { sleep: noSleep, isDrilling: notDrilling, compute: lit });
    expect(useRashidScan.getState().findings).toHaveLength(1);
    await useRashidScan.getState().start(rep, {
      sleep: noSleep,
      isDrilling: notDrilling,
      compute: async () => ({ result: DARK, fromCache: true }),
    });
    expect(useRashidScan.getState().findings).toHaveLength(1);
    const other = study('study2').rep;
    await useRashidScan.getState().start(other, {
      sleep: noSleep,
      isDrilling: notDrilling,
      compute: async () => ({ result: DARK, fromCache: true }),
    });
    expect(useRashidScan.getState().findings).toHaveLength(0);
    expect(useRashidScan.getState().repertoireId).toBe('study2');
  });

  it('cancel stops the run and a stale run cannot write findings', async () => {
    const { rep } = study();
    let calls = 0;
    const run = useRashidScan.getState().start(rep, {
      sleep: noSleep,
      isDrilling: notDrilling,
      compute: async () => {
        calls += 1;
        if (calls === 1) useRashidScan.getState().cancel();
        return { result: LIT, fromCache: false };
      },
    });
    await run;
    expect(calls).toBe(1);
    expect(useRashidScan.getState().running).toBe(false);
    // The first position's LIT result arrived after cancel — dropped.
    expect(useRashidScan.getState().findings).toHaveLength(0);
  });
});

describe('useRashidScan.loadFromCache', () => {
  it('reads the precompute tier before the live tier with the writer\'s exact key', async () => {
    const { rep, w2, w3 } = study();
    const engineId = 'Stockfish test';
    const entry = (p: RepertoirePosition, nodes: number, cfgKey: string, result: RashidResult): RashidResultEntry => ({
      key: rashidResultKey(p.fenKey, 'w', engineId, nodes, cfgKey),
      fenKey: p.fenKey,
      heroColor: 'w',
      engineId,
      nodes,
      configKey: cfgKey,
      result,
      savedAt: '',
    });
    const store = new Map<string, RashidResultEntry>();
    // w2: precompute says lit; a stale live entry says dark — precompute must win.
    const pre = entry(w2, NODES_PRECOMPUTE, rashidConfigKey(DEFAULT_RASHID_CONFIG), LIT);
    const live = entry(w2, LIVE_TIER.nodes, rashidConfigKey(LIVE_TIER.cfg), DARK);
    store.set(pre.key, pre);
    store.set(live.key, live);
    // w3: only a live entry, lit.
    const w3live = entry(w3, LIVE_TIER.nodes, rashidConfigKey(LIVE_TIER.cfg), LIT);
    store.set(w3live.key, w3live);

    expect(resultKeyForTier(w2.fenKey, 'w', engineId, PRECOMPUTE_TIER)).toBe(pre.key);

    await useRashidScan.getState().loadFromCache(rep, {
      engineId,
      cache: { get: async (k) => store.get(k) },
    });
    const s = useRashidScan.getState();
    expect(s.cacheLoaded).toBe(true);
    expect(s.findings.map((f) => [f.positionId, f.fromCache])).toEqual([
      [w2.id, true],
      [w3.id, true],
    ]);
  });
});
