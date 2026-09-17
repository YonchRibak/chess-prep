/**
 * Shared repertoire-creation modals: "blank" (start from scratch) and
 * "import PGN". Used from the repertoire list AND the opening browser (which
 * is the primary "New repertoire" surface — pick an opening on a real board,
 * then create from it; these two are the fallbacks).
 */
import { useEffect, useState } from 'react';
import {
  parseStudyChapters,
  studyHeader,
  type Color,
  type StudySyncSummary,
} from '@chess-prep/shared';
import type { RepertoireSummary } from '../api/client.ts';
import { Btn } from './ui.tsx';

export function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-md border border-slate-800 bg-slate-900 p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function BlankRepertoireModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { name: string; color: Color; tags: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<Color>('white');
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold">Blank repertoire</h3>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setSubmitting(true);
          try {
            await onSubmit({
              name: name.trim(),
              color,
              tags: tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            });
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="e.g. White vs 1.d4"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Color</span>
          <select
            value={color}
            onChange={(e) => setColor(e.target.value as Color)}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
          >
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Tags (comma-separated)</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="e.g. main, sicilian, blitz"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
          />
        </label>
        <div className="flex gap-2 justify-end pt-2">
          <Btn type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" disabled={submitting || !name.trim()}>
            Create
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

export function ImportPgnModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { name: string; color: Color; pgn: string; tags: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<Color>('white');
  const [pgn, setPgn] = useState('');
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    const text = await file.text();
    setPgn(text);
    if (!name) setName(file.name.replace(/\.pgn$/i, ''));
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold">Import PGN</h3>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || !pgn.trim()) return;
          setSubmitting(true);
          setErr(null);
          try {
            await onSubmit({
              name: name.trim(),
              color,
              pgn,
              tags: tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            });
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : 'Import failed');
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Color</span>
            <select
              value={color}
              onChange={(e) => setColor(e.target.value as Color)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
            >
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-400">Tags</span>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="comma-separated"
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">PGN</span>
          <textarea
            value={pgn}
            onChange={(e) => setPgn(e.target.value)}
            rows={8}
            placeholder="Paste a PGN with variations, NAGs, comments…"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs font-mono resize-vertical"
          />
        </label>
        <input
          type="file"
          accept=".pgn,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
          className="text-xs text-slate-400"
        />
        {err && <p className="text-xs text-rose-300">{err}</p>}
        <div className="flex gap-2 justify-end pt-2">
          <Btn type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            type="submit"
            variant="primary"
            disabled={submitting || !name.trim() || !pgn.trim()}
          >
            Import
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Confirm wiping every repertoire.
 *
 * Deliberately heavier than the per-repertoire `confirm()`: this one also
 * destroys SRS history — months of scheduling state that no amount of
 * re-importing PGN brings back, because a re-imported move starts as a new
 * card. So it states the cost in numbers, points at the export that would have
 * preserved the trees, and asks for the word to be typed. A misclick should not
 * be able to reach the end of this.
 */
export function DeleteAllRepertoiresModal({
  repertoireCount,
  cardCount,
  onClose,
  onConfirm,
}: {
  repertoireCount: number;
  /** Cards known locally; `null` while stats are still loading. */
  cardCount: number | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const armed = typed.trim().toUpperCase() === 'DELETE';

  return (
    <Modal onClose={onClose}>
      <h3 className="font-semibold text-rose-300">Delete all repertoires?</h3>
      <p className="text-sm text-slate-300">
        This permanently deletes{' '}
        <strong className="font-mono">{repertoireCount}</strong> repertoire
        {repertoireCount === 1 ? '' : 's'}
        {cardCount !== null && (
          <>
            {' '}
            and all <strong className="font-mono">{cardCount}</strong> SRS card
            {cardCount === 1 ? '' : 's'} with them
          </>
        )}
        , on the server and on this device.
      </p>
      <p className="text-xs text-slate-400">
        Move trees can be rebuilt from a PGN export — <em>scheduling history cannot</em>.
        A re-imported move comes back as a new card. Export anything you want to keep
        first.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-slate-400 text-xs">
          Type <span className="font-mono text-rose-300">DELETE</span> to confirm
        </span>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono"
        />
      </label>
      {err && <p className="text-xs text-rose-300">{err}</p>}
      <div className="flex gap-2 justify-end pt-2">
        <Btn type="button" onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          type="button"
          disabled={!armed || submitting}
          className={
            armed && !submitting
              ? 'border-rose-700 bg-rose-900/60 text-rose-100 hover:bg-rose-900'
              : ''
          }
          onClick={() => {
            void (async () => {
              setSubmitting(true);
              setErr(null);
              try {
                await onConfirm();
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
                setSubmitting(false);
              }
            })();
          }}
        >
          {submitting ? 'Deleting…' : `Delete all ${repertoireCount}`}
        </Btn>
      </div>
    </Modal>
  );
}

/**
 * Study S3: upload a lichess study export, or re-sync an existing study
 * repertoire from a newer one.
 *
 * The file is parsed client-side (shared `parseStudyChapters`) before upload
 * purely as a *preview* — chapter count and a name prefill — so a wrong file
 * is caught before it hits the server. The server parses again and is the
 * authority. After a successful submit the modal stays open to show the
 * sync summary: what was added, updated, removed, which alternates the prep
 * policy demoted and why — the one place the user learns what the policy did.
 */
export type ImportStudyMode =
  | { kind: 'create' }
  | { kind: 'update'; repertoire: RepertoireSummary };

export function ImportStudyModal({
  mode,
  onClose,
  onSubmit,
}: {
  mode: ImportStudyMode;
  onClose: () => void;
  onSubmit: (input: {
    pgn: string;
    color: Color;
    name: string;
    tags: string[];
  }) => Promise<StudySyncSummary>;
}) {
  const [name, setName] = useState(mode.kind === 'update' ? mode.repertoire.name : '');
  const [nameTouched, setNameTouched] = useState(false);
  const [color, setColor] = useState<Color>(
    mode.kind === 'update' ? mode.repertoire.color : 'white',
  );
  const [pgn, setPgn] = useState('');
  const [tags, setTags] = useState('');
  const [preview, setPreview] = useState<
    | { ok: true; chapters: string[]; studyName: string | null }
    | { ok: false; error: string }
    | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<StudySyncSummary | null>(null);

  // Preview parse, debounced: a 30-chapter study is a few hundred ms of
  // chess.js work and must not run on every keystroke of a paste.
  useEffect(() => {
    if (!pgn.trim()) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      try {
        const chapters = parseStudyChapters(pgn);
        const header = studyHeader(pgn);
        setPreview({
          ok: true,
          chapters: chapters.map((c) => c.name),
          studyName: header.studyName,
        });
        if (mode.kind === 'create' && !nameTouched && header.studyName) setName(header.studyName);
      } catch (e) {
        setPreview({
          ok: false,
          error: e instanceof Error ? e.message : 'Could not read this PGN',
        });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [pgn, mode.kind, nameTouched]);

  const handleFile = async (file: File) => {
    setPgn(await file.text());
  };

  const canSubmit =
    !submitting &&
    pgn.trim().length > 0 &&
    preview?.ok === true &&
    (mode.kind === 'update' || name.trim().length > 0);

  if (summary) {
    return (
      <Modal onClose={onClose}>
        <h3 className="text-sm font-semibold">
          {mode.kind === 'update' ? 'Study updated' : 'Study imported'}
        </h3>
        <StudySummaryView summary={summary} />
        <div className="flex justify-end pt-2">
          <Btn variant="primary" onClick={onClose}>
            Done
          </Btn>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold">
        {mode.kind === 'update'
          ? `Update "${mode.repertoire.name}" from PGN`
          : 'Upload a lichess study'}
      </h3>
      {mode.kind === 'update' && (
        <p className="text-xs text-amber-200/90 border border-amber-900/60 bg-amber-950/30 rounded px-2 py-1.5">
          Moves that are no longer in the study will be <strong>deleted</strong>, along with
          their scheduling history. Moves still present keep theirs.
        </p>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSubmit) return;
          setSubmitting(true);
          setErr(null);
          try {
            const s = await onSubmit({
              pgn,
              color,
              name: name.trim(),
              tags: tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            });
            setSummary(s);
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : 'Import failed');
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">PGN (one chapter or the whole study)</span>
          <textarea
            value={pgn}
            onChange={(e) => setPgn(e.target.value)}
            rows={7}
            autoFocus
            placeholder="Paste the study export, or choose the .pgn file below"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs font-mono resize-vertical"
          />
        </label>
        <input
          type="file"
          accept=".pgn,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
          className="text-xs text-slate-400"
        />
        {preview && (
          <p className={`text-xs ${preview.ok ? 'text-slate-400' : 'text-rose-300'}`}>
            {preview.ok
              ? `${preview.chapters.length} chapter${preview.chapters.length === 1 ? '' : 's'}: ${preview.chapters.join(', ')}`
              : preview.error}
          </p>
        )}

        {mode.kind === 'create' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-400">Name</span>
              <input
                value={name}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
                placeholder="Defaults to the study's name"
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-400">I play</span>
                <select
                  value={color}
                  onChange={(e) => setColor(e.target.value as Color)}
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
                >
                  <option value="white">White</option>
                  <option value="black">Black</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-400">Tags</span>
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="comma-separated"
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
                />
              </label>
            </div>
          </>
        )}
        {err && <p className="text-xs text-rose-300">{err}</p>}
        <div className="flex gap-2 justify-end pt-2">
          <Btn type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" disabled={!canSubmit}>
            {submitting ? 'Working…' : mode.kind === 'update' ? 'Update' : 'Import'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

function StudySummaryView({ summary: s }: { summary: StudySyncSummary }) {
  const rows: Array<[string, number]> = [
    ['Chapters', s.chapters],
    ['Moves added', s.movesAdded],
    ['Moves updated', s.movesUpdated],
    ['Moves removed', s.movesRemoved],
    ['New cards', s.cardsCreated],
    ['Cards kept (history preserved)', s.cardsKept],
  ];
  if (s.refutationsKept > 0) rows.push(['Refutation lines kept', s.refutationsKept]);
  if (s.extensionsKept > 0) rows.push(['Your extensions kept', s.extensionsKept]);
  if (s.extensionsAdopted > 0) rows.push(['Your extensions now in the study', s.extensionsAdopted]);
  if (s.extensionsRemoved > 0) rows.push(['Your extensions removed (line gone)', s.extensionsRemoved]);
  const cross = s.demoted.filter((d) => d.reason === 'cross-chapter');
  const vars = s.demoted.filter((d) => d.reason === 'variation');
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-400">{k}</dt>
            <dd className="font-mono text-right">{v}</dd>
          </div>
        ))}
      </dl>
      {s.extensionsDemoted.length > 0 && (
        <div className="text-xs">
          <p className="text-slate-300 mb-1">
            The study now plays a different move where you had recorded one — yours{' '}
            {s.extensionsDemoted.length === 1 ? 'is' : 'are'} parked, scheduling kept:
          </p>
          <ul className="ml-3 list-disc text-slate-400">
            {s.extensionsDemoted.map((d) => (
              <li key={`${d.parentFenKey}:${d.san}`}>
                study plays <span className="font-mono">{d.keptSan}</span>; your{' '}
                <span className="font-mono">{d.san}</span> parked
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.demoted.length > 0 && (
        <div className="text-xs">
          <p className="text-slate-300 mb-1">
            One prep move per position: {s.demoted.length} of your alternates{' '}
            {s.demoted.length === 1 ? 'is' : 'are'} in the tree but not rehearsed.
          </p>
          {cross.length > 0 && (
            <>
              <p className="text-amber-200/90 mt-1">Chapters disagree (earlier chapter wins):</p>
              <ul className="ml-3 list-disc text-slate-400">
                {cross.map((d) => (
                  <li key={`${d.parentFenKey}:${d.san}`}>
                    <span className="font-mono">{d.san}</span> in "{d.chapter}" — rehearsing{' '}
                    <span className="font-mono">{d.keptSan}</span> from "{d.keptChapter}"
                  </li>
                ))}
              </ul>
            </>
          )}
          {vars.length > 0 && (
            <>
              <p className="text-slate-400 mt-1">Sidelines at your own turn:</p>
              <ul className="ml-3 list-disc text-slate-500">
                {vars.map((d) => (
                  <li key={`${d.parentFenKey}:${d.san}`}>
                    <span className="font-mono">{d.san}</span> ("{d.chapter}") — rehearsing{' '}
                    <span className="font-mono">{d.keptSan}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
