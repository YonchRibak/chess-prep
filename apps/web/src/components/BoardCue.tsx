/**
 * Feedback overlay for a board (Study S5): a green or red wash for a
 * correct / wrong answer, a fade while a new line loads. Purely visual —
 * the owner decides when to show which. Keyframes live in index.css.
 */
import type { ReactNode } from 'react';

export type BoardCueKind = 'correct' | 'wrong' | 'new-line' | null;

export function BoardCue({ cue, children }: { cue: BoardCueKind; children: ReactNode }) {
  return (
    <div className={`relative ${cue === 'wrong' ? 'cue-shake' : ''}`}>
      <div className={cue === 'new-line' ? 'cue-fade-out' : 'cue-fade-in'}>{children}</div>
      {cue === 'correct' && (
        <div className="pointer-events-none absolute inset-0 rounded cue-flash bg-emerald-400/30" />
      )}
      {cue === 'wrong' && (
        <div className="pointer-events-none absolute inset-0 rounded cue-flash bg-rose-500/30" />
      )}
    </div>
  );
}
