/**
 * Shared repertoire-creation modals: "blank" (start from scratch) and
 * "import PGN". Used from the repertoire list AND the opening browser (which
 * is the primary "New repertoire" surface — pick an opening on a real board,
 * then create from it; these two are the fallbacks).
 */
import { useState } from 'react';
import type { Color } from '@chess-prep/shared';
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
