/**
 * The wrong-answer card (Study S5; presentational). Shows what was played
 * and what was right, the stage copy, an interference hint when the SAN is
 * the user's prep elsewhere, and the "Why is X bad?" refutation prompt.
 */
import type { MissStage } from '../lib/drill/missFlow.ts';
import { RefutationPrompt } from './RefutationPrompt.tsx';
import { Btn, Card } from './ui.tsx';

export function MissPanel({
  repertoireId,
  parentFullFen,
  correctSan,
  userSan,
  stage,
  interference,
  onSkip,
}: {
  repertoireId: string;
  parentFullFen: string;
  correctSan: string;
  userSan: string;
  stage: Exclude<MissStage, 'note'>;
  interference?: string;
  onSkip?: () => void;
}) {
  return (
    <Card title={stage === 'reveal' ? '✗ Not that one' : 'Play the right move'}>
      <p className="text-sm">
        Correct: <span className="font-mono font-medium text-emerald-300">{correctSan}</span>
        <span className="text-slate-500"> · you played </span>
        <span className="font-mono text-rose-300">{userSan}</span>
      </p>
      {interference && <p className="text-xs text-amber-300 mt-1">{interference}</p>}
      <p className="text-xs text-slate-500 mt-1">
        {stage === 'reveal' ? 'Watch the move…' : `Now play ${correctSan} yourself to continue.`}
      </p>
      {stage === 'retry' && (
        <div className="mt-2 flex items-center gap-2">
          {onSkip && (
            <Btn variant="ghost" onClick={onSkip}>
              Skip <kbd className="ml-1 text-[10px] text-slate-500">N</kbd>
            </Btn>
          )}
        </div>
      )}
      <RefutationPrompt
        key={`${parentFullFen}:${userSan}`}
        repertoireId={repertoireId}
        parentFullFen={parentFullFen}
        wrongSan={userSan}
      />
    </Card>
  );
}
