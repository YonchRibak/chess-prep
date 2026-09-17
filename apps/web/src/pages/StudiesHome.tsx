/**
 * Studies home — the default landing (Study S3).
 *
 * The study flow inverts the app's original shape: preparation happens in a
 * lichess study, and this screen is where the user comes to *rehearse* it.
 * One card per study-sourced repertoire, with the verbs that matter:
 * Rehearse (the walker's drill seed, smart queue), Browse, and Update from a
 * newer export. Hand-built repertoires keep their own home at `#/repertoires`.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/app.ts';
import { Btn, Card, OverflowMenu } from '../components/ui.tsx';
import { ImportStudyModal } from '../components/RepertoireModals.tsx';
import type { RepertoireSummary } from '../api/client.ts';
import { useRepStats } from '../lib/useRepStats.ts';
import { useRashidScan } from '../store/rashidScan.ts';
import { readLastChapter } from '../lib/rehearse/useRehearseSession.ts';
import type { ChapterStats } from '../lib/rehearse/chapterStats.ts';

export function StudiesHome() {
  const repertoires = useAppStore((s) => s.repertoires);
  const loading = useAppStore((s) => s.loading);
  const loadList = useAppStore((s) => s.loadList);
  const importStudy = useAppStore((s) => s.importStudy);
  const updateStudy = useAppStore((s) => s.updateStudy);
  const deleteRepertoire = useAppStore((s) => s.deleteRepertoire);
  const renameRepertoire = useAppStore((s) => s.renameRepertoire);
  const exportPgn = useAppStore((s) => s.exportPgn);
  const go = useAppStore((s) => s.go);

  const [showUpload, setShowUpload] = useState(false);
  const [updating, setUpdating] = useState<RepertoireSummary | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // S5: the chapter last rehearsed per study, so its row reads "Resume".
  const [lastChapter, setLastChapter] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const studies = repertoires.filter((r) => r.source?.kind === 'lichess-study');
  const { stats } = useRepStats(studies);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = new Map<string, string>();
      for (const r of studies) {
        const tag = await readLastChapter(r.id);
        if (tag) next.set(r.id, tag);
      }
      if (!cancelled) setLastChapter(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repertoires]);
  const totalDue = [...stats.values()].reduce((n, s) => n + s.dueCards, 0);

  /** Load into `active` first so the session component has its tree. */
  async function withLoaded(id: string, fn: () => void) {
    try {
      await useAppStore.getState().loadRepertoire(id);
      fn();
    } catch {
      /* error already surfaced by loadRepertoire */
    }
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
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Today</h2>
            {stats.size === 0 && studies.length > 0 ? (
              <p className="text-xs text-slate-500 mt-0.5">Counting due cards…</p>
            ) : totalDue > 0 ? (
              <p className="text-xs text-slate-400 mt-0.5">
                <span className="text-emerald-300 font-mono font-semibold">{totalDue}</span>{' '}
                study card{totalDue === 1 ? '' : 's'} due
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-0.5">Nothing due from your studies. ✓</p>
            )}
          </div>
          <Btn variant={totalDue > 0 ? 'primary' : 'default'} onClick={() => go({ kind: 'daily' })}>
            {totalDue > 0 ? 'Start daily session' : 'Open daily session'}
          </Btn>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Studies</h2>
        <Btn variant="primary" onClick={() => setShowUpload(true)}>
          Upload study
        </Btn>
      </div>

      {loading && studies.length === 0 ? (
        <p className="text-slate-500 text-sm">Loading…</p>
      ) : studies.length === 0 ? (
        <Card>
          <p className="text-slate-300 text-sm">
            Prepare in a <strong>lichess study</strong>, then export it as PGN (one chapter or
            the whole study) and upload it here. Every variation becomes a rehearsal line,
            each chapter is its own scope, and your comments show up when you miss a move.
          </p>
          <p className="text-xs text-slate-500 mt-2">
            Re-upload the same study whenever you change it — moves you already know keep
            their scheduling.
          </p>
          <div className="flex gap-2 pt-3">
            <Btn variant="primary" onClick={() => setShowUpload(true)}>
              Upload a lichess study
            </Btn>
            <Btn variant="ghost" onClick={() => go({ kind: 'list' })}>
              Hand-built repertoires →
            </Btn>
          </div>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {studies.map((r) => {
            const s = stats.get(r.id);
            const src = r.source!;
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
                    <span className="font-medium">{r.name}</span>
                  )}
                  <span className="text-xs text-slate-500">
                    {r.color === 'white' ? '♔ White' : '♚ Black'}
                  </span>
                </div>

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
                    </>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">…</span>
                  )}
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                    {src.chapters.length} chapter{src.chapters.length === 1 ? '' : 's'}
                  </span>
                </div>

                {/* S5: chapter rows — one click starts the flashcards for that chapter. */}
                <ul className="flex flex-col gap-1">
                  {[...src.chapters]
                    .sort((a, b) =>
                      a.tag === lastChapter.get(r.id) ? -1 : b.tag === lastChapter.get(r.id) ? 1 : 0,
                    )
                    .map((ch) => (
                      <ChapterRow
                        key={ch.tag}
                        name={ch.name}
                        stats={s?.byTag.get(ch.tag)}
                        resume={lastChapter.get(r.id) === ch.tag}
                        onStart={() =>
                          void withLoaded(r.id, () =>
                            go({ kind: 'rehearse', repertoireId: r.id, chapterTag: ch.tag }),
                          )
                        }
                      />
                    ))}
                </ul>

                <p className="text-[10px] text-slate-500">
                  Imported {new Date(src.importedAt).toLocaleString()}
                  {src.studyUrl && (
                    <>
                      {' · '}
                      <a
                        href={src.studyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-slate-300"
                      >
                        open on lichess
                      </a>
                    </>
                  )}
                </p>

                <div className="flex gap-2 pt-1 items-center">
                  <Btn
                    variant={s && s.dueCards > 0 ? 'primary' : 'default'}
                    onClick={() =>
                      void withLoaded(r.id, () => go({ kind: 'rehearse', repertoireId: r.id }))
                    }
                    title="Shuffle every chapter"
                  >
                    Rehearse all{s && s.dueCards > 0 ? ` (${s.dueCards})` : ''}
                  </Btn>
                  <Btn
                    onClick={() =>
                      void withLoaded(r.id, () =>
                        go({ kind: 'study-browser', repertoireId: r.id }),
                      )
                    }
                  >
                    Browse
                  </Btn>
                  <Btn onClick={() => setUpdating(r)}>Update</Btn>
                  <div className="ml-auto">
                    <OverflowMenu
                      items={[
                        {
                          label: 'Scan with Rashid',
                          onClick: () =>
                            void withLoaded(r.id, () => {
                              const full = useAppStore.getState().active;
                              if (full) void useRashidScan.getState().start(full);
                              go({ kind: 'study-browser', repertoireId: r.id });
                            }),
                        },
                        {
                          label: 'Expand variations',
                          onClick: () =>
                            void withLoaded(r.id, () =>
                              go({ kind: 'rehearse', repertoireId: r.id, mode: 'expand' }),
                            ),
                        },
                        {
                          label: 'Lines (walker)',
                          onClick: () =>
                            void withLoaded(r.id, () =>
                              go({ kind: 'lines', repertoireId: r.id, intent: 'train' }),
                            ),
                        },
                        { label: 'Export PGN', onClick: () => void handleExport(r) },
                        { label: 'Rename', onClick: () => setRenamingId(r.id) },
                        {
                          label: 'Delete',
                          danger: true,
                          onClick: () => {
                            if (confirm(`Delete study "${r.name}"? This cannot be undone.`)) {
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

      {showUpload && (
        <ImportStudyModal
          mode={{ kind: 'create' }}
          onClose={() => setShowUpload(false)}
          onSubmit={async (input) => (await importStudy(input)).summary}
        />
      )}

      {updating && (
        <ImportStudyModal
          mode={{ kind: 'update', repertoire: updating }}
          onClose={() => setUpdating(null)}
          onSubmit={async (input) => updateStudy(updating.id, input.pgn)}
        />
      )}
    </div>
  );
}

/** A chapter with its mastery ring and one Start button; the whole row is the target. */
function ChapterRow({
  name,
  stats,
  resume,
  onStart,
}: {
  name: string;
  stats: ChapterStats | undefined;
  resume: boolean;
  onStart: () => void;
}) {
  const total = stats?.cards ?? 0;
  const ratio = total > 0 ? (stats!.mastered / total) : 0;
  return (
    <li>
      <button
        onClick={onStart}
        title={resume ? `Resume "${name}"` : `Start flashcards for "${name}"`}
        className={`w-full flex items-center gap-2 rounded border px-2 py-1 text-left text-xs hover:bg-slate-800 ${
          resume ? 'border-emerald-800 bg-emerald-950/30' : 'border-slate-800'
        }`}
      >
        <MasteryRing ratio={ratio} />
        <span className="flex-1 truncate">{name}</span>
        {stats ? (
          <span className="font-mono text-[10px] text-slate-500 shrink-0">
            {stats.mastered}/{total}
            {stats.due > 0 && <span className="text-emerald-300"> · {stats.due} due</span>}
          </span>
        ) : (
          <span className="text-[10px] text-slate-600">…</span>
        )}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
            resume ? 'bg-emerald-700 text-white' : 'bg-slate-800 text-slate-300'
          }`}
        >
          {resume ? 'Resume' : 'Start'}
        </span>
      </button>
    </li>
  );
}

function MasteryRing({ ratio }: { ratio: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0 -rotate-90">
      <circle cx="9" cy="9" r={r} fill="none" stroke="#1e293b" strokeWidth="3" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="#34d399"
        strokeWidth="3"
        strokeDasharray={`${c * ratio} ${c}`}
        strokeLinecap="round"
      />
    </svg>
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
