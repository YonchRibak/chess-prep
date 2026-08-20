/**
 * Home screen: "what should I do now?" first.
 *
 * - Top banner: total due cards across all repertoires → one-click into the
 *   daily session (the primary daily loop).
 * - Repertoire cards: due / cards / to-build badges so choosing Drill vs
 *   Build is an informed decision, with just two primary actions per card and
 *   everything else in an overflow menu.
 * - Creation: ONE "New repertoire" button that routes through the opening
 *   browser (pick a line on a real board, then create from it). Import PGN
 *   stays as a secondary header action; "blank" lives in the browser page.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/app.ts';
import { Btn, Card, OverflowMenu } from '../components/ui.tsx';
import { ImportPgnModal } from '../components/RepertoireModals.tsx';
import { api, type RepertoireSummary } from '../api/client.ts';
import {
  getAllCardsLocal,
  getAllRepertoiresLocal,
  putRepertoireLocal,
} from '../lib/idb/schema.ts';
import { computeRepStats, type RepStats } from '../lib/repStats.ts';

export function RepertoireList() {
  const repertoires = useAppStore((s) => s.repertoires);
  const loading = useAppStore((s) => s.loading);
  const loadList = useAppStore((s) => s.loadList);
  const openRepertoire = useAppStore((s) => s.openRepertoire);
  const importPgn = useAppStore((s) => s.importPgn);
  const deleteRepertoire = useAppStore((s) => s.deleteRepertoire);
  const renameRepertoire = useAppStore((s) => s.renameRepertoire);
  const exportPgn = useAppStore((s) => s.exportPgn);
  const go = useAppStore((s) => s.go);

  const [showImport, setShowImport] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [stats, setStats] = useState<Map<string, RepStats>>(new Map());

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Per-repertoire stats from the local card store + cached full snapshots.
  // Progressive: badges fill in as each repertoire's snapshot is available.
  useEffect(() => {
    if (repertoires.length === 0) return;
    let cancelled = false;
    (async () => {
      const cards = await getAllCardsLocal();
      const local = await getAllRepertoiresLocal();
      const localById = new Map(local.map((r) => [r.id, r]));
      const next = new Map<string, RepStats>();
      for (const sum of repertoires) {
        let full = localById.get(sum.id);
        if (!full || full.updatedAt !== sum.updatedAt) {
          try {
            full = await api.getRepertoire(sum.id);
            void putRepertoireLocal(full);
          } catch {
            /* offline — fall back to the (possibly stale) local snapshot */
          }
        }
        if (!full) continue;
        next.set(sum.id, computeRepStats(full, cards));
        if (cancelled) return;
        setStats(new Map(next));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repertoires]);

  const totalDue = [...stats.values()].reduce((n, s) => n + s.dueCards, 0);
  const dueBySide = { white: 0, black: 0 };
  for (const r of repertoires) {
    const s = stats.get(r.id);
    if (s) dueBySide[r.color] += s.dueCards;
  }

  async function handleExport(r: RepertoireSummary) {
    const pgn = await exportPgn(r.id);
    const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.name.replace(/[^\w\- ]+/g, '')}.pgn`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="w-full max-w-4xl flex flex-col gap-4">
      {/* ---- Today banner: the daily loop comes first ---- */}
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Today</h2>
            {stats.size === 0 && repertoires.length > 0 ? (
              <p className="text-xs text-slate-500 mt-0.5">Counting due cards…</p>
            ) : totalDue > 0 ? (
              <p className="text-xs text-slate-400 mt-0.5">
                <span className="text-emerald-300 font-mono font-semibold">{totalDue}</span>{' '}
                card{totalDue === 1 ? '' : 's'} due
                {dueBySide.white > 0 && dueBySide.black > 0 && (
                  <span className="text-slate-500">
                    {' '}
                    (♔ {dueBySide.white} · ♚ {dueBySide.black})
                  </span>
                )}
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-0.5">
                All caught up — nothing due right now. ✓
              </p>
            )}
          </div>
          <Btn
            variant={totalDue > 0 ? 'primary' : 'default'}
            onClick={() => go({ kind: 'daily' })}
          >
            {totalDue > 0 ? 'Start daily session' : 'Open daily session'}
          </Btn>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Repertoires</h2>
        <div className="flex gap-2">
          <Btn variant="ghost" onClick={() => setShowImport(true)}>
            Import PGN
          </Btn>
          <Btn variant="primary" onClick={() => go({ kind: 'browse' })}>
            New repertoire
          </Btn>
        </div>
      </div>

      {loading && repertoires.length === 0 ? (
        <p className="text-slate-500 text-sm">Loading…</p>
      ) : repertoires.length === 0 ? (
        <Card>
          <p className="text-slate-400 text-sm">
            No repertoires yet. Hit <strong>New repertoire</strong> to pick an opening
            on the board and start building, or import a PGN.
          </p>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {repertoires.map((r) => {
            const s = stats.get(r.id);
            return (
              <li
                key={r.id}
                className="rounded border border-slate-800 bg-slate-900/60 p-3 flex flex-col gap-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  {renamingId === r.id ? (
                    <RenameForm
                      initial={r.name}
                      onCancel={() => setRenamingId(null)}
                      onSubmit={async (n) => {
                        await renameRepertoire(r.id, n);
                        setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => void openRepertoire(r.id)}
                      className="text-left font-medium hover:text-emerald-300"
                      title="Open in editor"
                    >
                      {r.name}
                    </button>
                  )}
                  <span className="text-xs text-slate-500">
                    {r.color === 'white' ? '♔ White' : '♚ Black'}
                  </span>
                </div>

                {/* Stats badges: due / total cards / build gaps */}
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  {s ? (
                    <>
                      <span
                        className={`px-1.5 py-0.5 rounded font-mono ${
                          s.dueCards > 0
                            ? 'bg-emerald-900/50 text-emerald-200 border border-emerald-800'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {s.dueCards} due
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                        {s.totalCards} card{s.totalCards === 1 ? '' : 's'}
                      </span>
                      {s.uncovered > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200 border border-amber-800/60 font-mono">
                          {s.uncovered} to build
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">…</span>
                  )}
                  {r.tags.map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                      {t}
                    </span>
                  ))}
                </div>

                <div className="flex gap-2 pt-1 items-center">
                  <Btn
                    variant={s && s.dueCards > 0 ? 'primary' : 'default'}
                    onClick={async () => {
                      await openRepertoire(r.id);
                      useAppStore
                        .getState()
                        .go({ kind: 'walker-session', repertoireId: r.id, seed: 'drill' });
                    }}
                  >
                    Drill{s && s.dueCards > 0 ? ` (${s.dueCards})` : ''}
                  </Btn>
                  <Btn
                    variant={s && s.dueCards === 0 && s.uncovered > 0 ? 'primary' : 'default'}
                    onClick={async () => {
                      await openRepertoire(r.id);
                      useAppStore
                        .getState()
                        .go({ kind: 'walker-session', repertoireId: r.id, seed: 'build' });
                    }}
                  >
                    Build
                  </Btn>
                  <div className="ml-auto">
                    <OverflowMenu
                      items={[
                        { label: 'Edit', onClick: () => void openRepertoire(r.id) },
                        {
                          label: 'Classic drill',
                          onClick: () => {
                            void (async () => {
                              await openRepertoire(r.id);
                              useAppStore
                                .getState()
                                .go({ kind: 'drill-setup', repertoireId: r.id });
                            })();
                          },
                        },
                        {
                          label: 'Health check',
                          onClick: () => {
                            void (async () => {
                              await openRepertoire(r.id);
                              useAppStore
                                .getState()
                                .go({ kind: 'health-check', repertoireId: r.id });
                            })();
                          },
                        },
                        { label: 'Export PGN', onClick: () => void handleExport(r) },
                        { label: 'Rename', onClick: () => setRenamingId(r.id) },
                        {
                          label: 'Delete',
                          danger: true,
                          onClick: () => {
                            if (
                              confirm(`Delete repertoire "${r.name}"? This cannot be undone.`)
                            ) {
                              void deleteRepertoire(r.id);
                            }
                          },
                        },
                      ]}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
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

function RenameForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void onSubmit(name.trim());
      }}
      className="flex-1 flex gap-1"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        className="flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
      />
      <Btn type="submit" variant="primary">
        Save
      </Btn>
      <Btn type="button" onClick={onCancel}>
        Cancel
      </Btn>
    </form>
  );
}
