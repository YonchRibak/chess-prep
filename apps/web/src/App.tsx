import { useEffect } from 'react';
import { useAppStore } from './store/app.ts';
import { RepertoireList } from './pages/RepertoireList.tsx';
import { RepertoireEditor } from './pages/RepertoireEditor.tsx';
import { DrillSetup } from './pages/DrillSetup.tsx';
import { DrillSession } from './pages/DrillSession.tsx';
import { HealthCheckPage } from './pages/HealthCheck.tsx';
import { BrowseOpenings } from './pages/BrowseOpenings.tsx';
import { WalkerSession } from './pages/WalkerSession.tsx';
import { DailyDiet } from './pages/DailyDiet.tsx';
import { Btn, ErrorBanner } from './components/ui.tsx';
import { attachOnlineFlush, flushQueue } from './lib/srs/sync.ts';
import { useHashRouting } from './lib/router.ts';

const VIEW_LABEL: Record<string, string> = {
  list: 'Repertoires',
  browse: 'Browse openings',
  editor: 'Editor',
  'drill-setup': 'Drill setup',
  'drill-session': 'Drilling',
  'walker-session': 'Walker',
  daily: 'Daily diet',
  'health-check': 'Health check',
};

export function App() {
  const view = useAppStore((s) => s.view);
  const error = useAppStore((s) => s.error);
  const clearError = useAppStore((s) => s.clearError);

  // Keep the view in sync with location.hash: browser back/forward, refresh,
  // and deep links all work.
  useHashRouting();

  // Flush any queued SRS pushes on startup + whenever we come back online.
  useEffect(() => {
    void flushQueue();
    const detach = attachOnlineFlush();
    return detach;
  }, []);

  const go = useAppStore((s) => s.go);

  return (
    <div className="min-h-full p-4 md:p-8 flex flex-col items-center gap-6">
      <header className="w-full max-w-6xl flex items-center justify-between">
        <div className="flex items-baseline gap-4">
          <h1 className="text-2xl font-semibold">Chess Prep</h1>
          <nav className="flex gap-1 text-xs">
            <Btn
              variant={view.kind === 'list' ? 'primary' : 'ghost'}
              onClick={() => go({ kind: 'list' })}
            >
              Repertoires
            </Btn>
            <Btn
              variant={view.kind === 'daily' ? 'primary' : 'ghost'}
              onClick={() => go({ kind: 'daily' })}
            >
              Daily
            </Btn>
            <Btn
              variant={view.kind === 'browse' ? 'primary' : 'ghost'}
              onClick={() => go({ kind: 'browse' })}
            >
              Browse openings
            </Btn>
          </nav>
        </div>
        <span className="text-xs text-slate-500">{VIEW_LABEL[view.kind]}</span>
      </header>

      <main className="w-full flex flex-col items-center">
        {view.kind === 'list' && <RepertoireList />}
        {view.kind === 'browse' && <BrowseOpenings />}
        {view.kind === 'editor' && <RepertoireEditor />}
        {view.kind === 'drill-setup' && <DrillSetup />}
        {view.kind === 'drill-session' && <DrillSession />}
        {view.kind === 'walker-session' && <WalkerSession seed={view.seed} />}
        {view.kind === 'daily' && <DailyDiet />}
        {view.kind === 'health-check' && <HealthCheckPage />}
      </main>

      {error && <ErrorBanner message={error} onClose={clearError} />}
    </div>
  );
}
