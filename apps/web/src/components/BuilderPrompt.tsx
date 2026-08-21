/**
 * Phase 7 guided-builder prompt panels.
 *
 * On a user-turn position: "What's your move here?" — surface the book's top
 * continuations as suggestions. Clicking one sets it as prep (= a Move row +
 * an SRS card). Playing freely on the board also works (handled upstream in
 * the editor).
 *
 * On an opponent-turn position: "Which responses do you want to prepare
 * against?" — multi-select the book's continuations. Each pick saves a Move
 * (opponent-side, no card) and opens that branch for the next user-turn
 * prompt. Already-prepped responses appear pre-checked.
 *
 * "Set as prep" is *playing the move on the board* (or clicking a suggestion
 * — same gesture, fewer clicks). Browsing a book continuation without picking
 * it never creates a card.
 */
import { useEffect, useState } from 'react';
import type { RankedReply, UserCandidate } from '@chess-prep/shared';
import { Card, Btn } from './ui';
import { useBookContinuations } from '../lib/openings/useBookContinuations.ts';
import type { BookContinuation } from '../api/client.ts';
import type { CandidateSource } from '../lib/openings/candidates.ts';

interface MoveLite {
  san: string;
  childFenKey: string;
}

/**
 * Phase 9c stats strip: share of games, and the score for whoever is to move.
 * Book-sourced rows carry no counts, so they render nothing rather than a `0%`
 * that reads as "nobody plays this".
 */
function StatsBadge({ games, share, score }: { games: number; share: number; score: number | null }) {
  if (games <= 0) return null;
  return (
    <span className="ml-auto flex items-baseline gap-2 tabular-nums text-[10px] text-slate-400">
      <span title={`${games.toLocaleString()} games`}>{(share * 100).toFixed(0)}%</span>
      {score !== null && (
        <span
          title="Score for the side to move (draw = ½)"
          className={score >= 0.55 ? 'text-emerald-400' : score <= 0.45 ? 'text-rose-400' : ''}
        >
          {(score * 100).toFixed(0)}
        </span>
      )}
    </span>
  );
}

/** Engine eval, from the side-to-move's perspective. */
function EvalBadge({ cp, mate }: { cp?: number; mate?: number }) {
  if (mate !== undefined) {
    return (
      <span className="text-[10px] font-mono text-amber-300">
        #{mate > 0 ? mate : `-${Math.abs(mate)}`}
      </span>
    );
  }
  if (cp === undefined) return null;
  const pawns = cp / 100;
  return (
    <span className="text-[10px] font-mono text-slate-300">
      {pawns >= 0 ? '+' : ''}
      {pawns.toFixed(2)}
    </span>
  );
}

function SourceNote({ source }: { source: CandidateSource }) {
  if (source === 'explorer') return null; // the numbers speak for themselves
  return (
    <p className="mt-2 text-[10px] text-slate-500">
      {source === 'book'
        ? 'Frequencies unavailable — showing book continuations in book order.'
        : 'No suggestions available offline. Play any legal move on the board.'}
    </p>
  );
}

interface UserTurnProps {
  mode: 'user-turn';
  currentFenKey: string;
  /** Moves already saved from the current position (at most one in v1). */
  existingPrep: MoveLite[];
  onPickPrep: (san: string) => void | Promise<void>;
  /**
   * Phase 9c: engine candidates, re-ranked by explorer popularity. Supplied by
   * the caller because the engine lives there and is only ungated during build
   * phases ([engine](../../../../knowledge/03-domain/engine.md)) — this panel
   * must never be able to start analysis of its own.
   *
   * Omitted (or empty) falls back to the plain book list, which is what happens
   * offline, before the first depth arrives, and in the editor.
   */
  engineCandidates?: UserCandidate[];
}

interface OpponentTurnProps {
  mode: 'opponent-turn';
  currentFenKey: string;
  /** Moves already saved from the current position (the opponent responses already prepped). */
  existingPrep: MoveLite[];
  /** Called when user confirms multi-select picks (only newly-added SANs). */
  onSaveSelected: (sans: string[]) => void | Promise<void>;
  /**
   * One-click add: clicking a suggestion row saves that single response
   * immediately (the common case). Checkbox multi-select stays available for
   * batching. When omitted, rows only toggle the checkbox.
   */
  onPickSingle?: (san: string) => void | Promise<void>;
  /**
   * Per-row "won't cover" action — permanently drops that response so the
   * walker never asks about it again.
   */
  onDropResponse?: (san: string) => void | Promise<void>;
  /**
   * Phase 9c: explorer-ranked replies for this position. When present they
   * replace the book list — they answer "which replies actually happen", which
   * the book cannot. Falls back to the book automatically when absent.
   */
  explorerReplies?: RankedReply[];
  candidateSource?: CandidateSource;
}

export function BuilderPrompt(props: UserTurnProps | OpponentTurnProps) {
  const { continuations, loading } = useBookContinuations(props.currentFenKey);
  if (props.mode === 'user-turn') {
    return <UserTurnPanel {...props} continuations={continuations} loading={loading} />;
  }
  return <OpponentTurnPanel {...props} continuations={continuations} loading={loading} />;
}

function UserTurnPanel({
  existingPrep,
  onPickPrep,
  engineCandidates,
  continuations,
  loading,
}: UserTurnProps & { continuations: BookContinuation[]; loading: boolean }) {
  const prepped = existingPrep[0] ?? null;
  const ranked = engineCandidates ?? [];
  return (
    <Card title="What's your move here?">
      {prepped && (
        <div className="text-xs text-emerald-300 mb-2">
          Prep set: <span className="font-mono font-semibold">{prepped.san}</span>{' '}
          <span className="text-slate-500">— pick another to swap (we'll confirm).</span>
        </div>
      )}
      {ranked.length > 0 ? (
        <>
          <ul className="flex flex-col gap-1">
            {ranked.map((c) => (
              <li key={c.san}>
                <button
                  type="button"
                  onClick={() => void onPickPrep(c.san)}
                  className={`w-full flex items-baseline gap-2 text-left px-2 py-1.5 rounded text-xs hover:bg-slate-800 ${
                    prepped?.san === c.san ? 'bg-slate-800 text-emerald-300' : ''
                  }`}
                >
                  <span className="font-mono font-semibold">{c.san}</span>
                  <EvalBadge cp={c.cp} mate={c.mate} />
                  {c.engineRank > 1 && (
                    <span className="text-[10px] text-slate-500">engine #{c.engineRank}</span>
                  )}
                  <StatsBadge
                    games={c.games ?? 0}
                    share={c.share ?? 0}
                    score={c.score}
                  />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-slate-500">
            Engine picks the shortlist; how often a move is played only breaks ties between
            moves it rates equally. Or play any legal move on the board.
          </p>
        </>
      ) : loading && continuations.length === 0 ? (
        <p className="text-xs text-slate-500">Loading book suggestions…</p>
      ) : continuations.length === 0 ? (
        <p className="text-xs text-slate-500">
          No book continuations from this position. Play any legal move on the board to set
          your prep.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {continuations.map((c) => (
            <li key={c.san}>
              <button
                type="button"
                onClick={() => void onPickPrep(c.san)}
                className={`w-full flex items-baseline gap-2 text-left px-2 py-1.5 rounded text-xs hover:bg-slate-800 ${
                  prepped?.san === c.san ? 'bg-slate-800 text-emerald-300' : ''
                }`}
              >
                <span className="font-mono font-semibold">{c.san}</span>
                {c.opening && (
                  <span className="text-slate-400">
                    {c.opening.name}
                    {c.opening.variation ? `, ${c.opening.variation}` : ''}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {ranked.length === 0 && (
        <p className="mt-2 text-[10px] text-slate-500">
          Or play any legal move on the board to set your prep.
        </p>
      )}
    </Card>
  );
}

function OpponentTurnPanel({
  existingPrep,
  onSaveSelected,
  onPickSingle,
  onDropResponse,
  explorerReplies,
  candidateSource,
  continuations,
  loading,
}: OpponentTurnProps & { continuations: BookContinuation[]; loading: boolean }) {
  const preppedSans = new Set(existingPrep.map((m) => m.san));
  // Explorer rows answer "which replies actually happen"; book rows only say
  // "this has a name". Prefer the former, keep the latter as the offline path.
  const openingBySan = new Map(continuations.map((c) => [c.san, c.opening]));
  const rows: Array<{ san: string; games: number; share: number; score: number | null }> =
    (explorerReplies ?? []).length > 0
      ? explorerReplies!.map((r) => ({
          san: r.san,
          games: r.games,
          share: r.share,
          score: r.score,
        }))
      : continuations.map((c) => ({ san: c.san, games: 0, share: 0, score: null }));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Reset selection when the position changes (continuations array identity is
  // stable per fenKey via the hook's cache).
  useEffect(() => {
    setSelected(new Set());
  }, [continuations]);

  function toggle(san: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(san)) next.delete(san);
      else next.add(san);
      return next;
    });
  }

  async function save() {
    const newSans = [...selected].filter((s) => !preppedSans.has(s));
    if (newSans.length === 0) return;
    setSubmitting(true);
    try {
      await onSaveSelected(newSans);
      setSelected(new Set());
    } finally {
      setSubmitting(false);
    }
  }

  const showSave = selected.size > 0;

  return (
    <Card title="Which responses do you want to prepare against?">
      {existingPrep.length > 0 && (
        <div className="text-[11px] text-slate-400 mb-2">
          Already prepped:{' '}
          {existingPrep.map((m, i) => (
            <span key={m.san} className="font-mono">
              {m.san}
              {i < existingPrep.length - 1 ? ', ' : ''}
            </span>
          ))}
        </div>
      )}
      {loading && rows.length === 0 ? (
        <p className="text-xs text-slate-500">Loading suggestions…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-500">
          No suggestions from this position. Play any legal opponent move on the board to add
          a sideline.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((c) => {
            const isPrepped = preppedSans.has(c.san);
            const isSelected = selected.has(c.san);
            const opening = openingBySan.get(c.san) ?? null;
            return (
              <li
                key={c.san}
                className={`flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-slate-800 ${
                  isPrepped ? 'text-slate-500' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={isPrepped || isSelected}
                  disabled={isPrepped}
                  onChange={() => toggle(c.san)}
                  className="accent-emerald-500"
                />
                <button
                  type="button"
                  disabled={isPrepped || submitting}
                  onClick={() => {
                    if (onPickSingle) void onPickSingle(c.san);
                    else toggle(c.san);
                  }}
                  className="flex-1 flex items-baseline gap-2 text-left disabled:cursor-default"
                  title={
                    isPrepped
                      ? 'Already prepped'
                      : onPickSingle
                        ? 'Add this response now'
                        : undefined
                  }
                >
                  <span className="font-mono font-semibold">{c.san}</span>
                  {opening && (
                    <span className="text-slate-400">
                      {opening.name}
                      {opening.variation ? `, ${opening.variation}` : ''}
                    </span>
                  )}
                  <StatsBadge games={c.games} share={c.share} score={c.score} />
                </button>
                {isPrepped ? (
                  <span className="text-[10px] text-slate-500">prepped</span>
                ) : (
                  onDropResponse && (
                    <button
                      type="button"
                      onClick={() => void onDropResponse(c.san)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:border-rose-800 hover:text-rose-300"
                      title="Won't cover — permanently drop this response"
                    >
                      won't cover
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[10px] text-slate-500">
        {onPickSingle
          ? 'Click a response to add it now, or tick several and save together. '
          : ''}
        Playing an opponent move on the board also adds it (for off-book sidelines).
      </p>
      <SourceNote source={candidateSource ?? 'book'} />
      {showSave && (
        <div className="mt-2 flex justify-end">
          <Btn type="button" variant="primary" disabled={submitting} onClick={() => void save()}>
            {submitting
              ? 'Saving…'
              : `Save ${selected.size} ${selected.size === 1 ? 'response' : 'responses'}`}
          </Btn>
        </div>
      )}
    </Card>
  );
}
