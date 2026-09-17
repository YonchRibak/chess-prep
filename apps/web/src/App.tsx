import { useEffect } from 'react';
import { useAppStore } from './store/app.ts';
import { RepertoireList } from './pages/RepertoireList.tsx';
import { StudiesHome } from './pages/StudiesHome.tsx';
import { RepertoireEditor } from './pages/RepertoireEditor.tsx';
import { DrillSetup } from './pages/DrillSetup.tsx';
import { DrillSession } from './pages/DrillSession.tsx';
import { HealthCheckPage } from './pages/HealthCheck.tsx';
import { BrowseOpenings } from './pages/BrowseOpenings.tsx';
import { WalkerSession } from './pages/WalkerSession.tsx';
import { DailyDiet } from './pages/DailyDiet.tsx';
import { LineNavigator } from './pages/LineNavigator.tsx';
import { PrepareWizard } from './pages/PrepareWizard.tsx';
import { RashidLab } from './pages/RashidLab.tsx';
import { StudyBrowser } from './pages/StudyBrowser.tsx';
import { useRashidScan } from './store/rashidScan.ts';
import { Btn, ErrorBanner } from './components/ui.tsx';
import { attachOnlineFlush, flushQueue } from './lib/srs/sync.ts';
import { useHashRouting } from './lib/router.ts';

const VIEW_LABEL: Record<string, string> = {
  studies: 'Studies',
  list: 'Repertoires',
  browse: 'Browse openings',
  editor: 'Editor',
  'drill-setup': 'Classic drill setup',
  'drill-session': 'Classic drill',
  'walker-session': 'Session',
  daily: 'Today',
  'health-check': 'Health check',
  lines: 'Lines',
  prepare: 'Prepare',
  'rashid-lab': 'Rashid lab',
  'study-browser': 'Study',
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

  // Study S4: the Rashid scan outlives its view; keep it visible from anywhere.
  const scanRunning = useRashidScan((s) => s.running);
  const scanProgress = useRashidScan((s) => s.progress);
  const scanRepId = useRashidScan((s) => s.repertoireId);

  return (
    <div className="min-h-full p-4 md:p-8 flex flex-col items-center gap-6">
      <header className="w-full max-w-6xl flex items-center justify-between">
        <div className="flex items-baseline gap-4">
          <h1 className="text-2xl font-semibold">Chess Prep</h1>
          <nav className="flex gap-1 text-xs">
            {/* Study S3: Studies is the landing; hand-built repertoires keep
                their own page. Nav = Studies · Repertoires · Today · Prepare. */}
            <Btn
              variant={view.kind === 'studies' ? 'primary' : 'ghost'}
              onClick={() => go({ kind: 'studies' })}
            >
              Studies
            </Btn>
            <Btn
              variant={view.kind === 'list' ? 'primary' : 'ghost'}
              onClick={() => go({ kind: 'list' })}
            >
              Repertoires
            </Btn>
            {/* Flow F4: nav = Repertoires · Today · Prepare. Browse openings
                stops being a destination — it's the Prepare wizard's search
                step and stays reachable from there and from "New repertoire". */}
            <Btn
              variant={view.kind === 'daily' ? 'primary' : 'ghost'}
              onClick={() => go({ kind: 'daily' })}
            >
              Today
            </Btn>
            <Btn
              variant={view.kind === 'prepare' ? 'primary' : 'ghost'}
              onClick={() => go({ kind: 'prepare' })}
            >
              Prepare
            </Btn>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {scanRunning && scanRepId && (
            <button
              className="text-[10px] px-2 py-0.5 rounded border border-amber-800 bg-amber-950/40 text-amber-200 hover:bg-amber-900/40"
              title="Rashid scan running — open the study"
              onClick={() => {
                void (async () => {
                  const store = useAppStore.getState();
                  if (store.active?.id !== scanRepId) await store.loadRepertoire(scanRepId).catch(() => {});
                  useAppStore.getState().go({ kind: 'study-browser', repertoireId: scanRepId });
                })();
              }}
            >
              Rashid scan {scanProgress?.paused ? 'paused' : `${scanProgress?.done ?? 0}/${scanProgress?.total ?? '?'}`}
            </button>
          )}
          <span className="text-xs text-slate-500">{VIEW_LABEL[view.kind]}</span>
        </div>
      </header>

      <main className="w-full flex flex-col items-center">
        {view.kind === 'studies' && <StudiesHome />}
        {view.kind === 'list' && <RepertoireList />}
        {view.kind === 'browse' && <BrowseOpenings />}
        {view.kind === 'editor' && <RepertoireEditor />}
        {view.kind === 'drill-setup' && <DrillSetup />}
        {view.kind === 'drill-session' && <DrillSession />}
        {view.kind === 'walker-session' && (
          <WalkerSession seed={view.seed} scope={view.scope} guided={view.guided} />
        )}
        {view.kind === 'daily' && <DailyDiet />}
        {view.kind === 'health-check' && <HealthCheckPage />}
        {view.kind === 'lines' && <LineNavigator intent={view.intent} />}
        {view.kind === 'prepare' && <PrepareWizard />}
        {view.kind === 'rashid-lab' && <RashidLab />}
        {view.kind === 'study-browser' && <StudyBrowser fenKey={view.fenKey} />}
      </main>

      {error && <ErrorBanner message={error} onClose={clearError} />}
    </div>
  );
}
