/**
 * The note-on-miss pause (Study S3).
 *
 * When a rehearsal card is missed and the correct move carries a comment —
 * the user's own note from the lichess study — the drill stops here until
 * the note is dismissed. It is rendered *instead of* the retry prompt, and
 * the board is not movable while it shows, so the note cannot be skipped by
 * reflexively playing the move.
 *
 * This is the user's text, not engine output: showing it during a drill does
 * not touch the engine gate.
 */
import { Btn, Card } from './ui.tsx';

export function StudyNote({
  san,
  note,
  onContinue,
}: {
  san: string;
  note: string;
  onContinue: () => void;
}) {
  return (
    <Card title={`Your note on ${san}`}>
      <p className="text-sm whitespace-pre-wrap leading-relaxed">{note}</p>
      <div className="flex items-center gap-2 pt-3">
        <Btn autoFocus variant="primary" onClick={onContinue}>
          Continue
        </Btn>
        <span className="text-[10px] text-slate-500">↵ or Space</span>
      </div>
    </Card>
  );
}
