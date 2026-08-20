/**
 * Minimal hash router: keeps the Zustand `view` union in sync with
 * `location.hash` so browser back/forward work, refresh restores your place,
 * and views are bookmarkable — without pulling in a router library.
 *
 * Mapping:
 *   #/                      → repertoire list (home)
 *   #/browse                → opening browser
 *   #/daily                 → daily diet
 *   #/editor/:id            → repertoire editor
 *   #/drill-setup/:id       → classic drill setup
 *   #/drill/:id/:mode       → classic drill session
 *   #/walker/:id/:seed      → walker session (build | drill)
 *   #/health/:id            → repertoire health check
 */
import { useEffect } from 'react';
import type { DrillMode } from '@chess-prep/shared';
import { useAppStore, type View } from '../store/app.ts';

const DRILL_MODES: DrillMode[] = ['due', 'walkthrough', 'weak', 'random'];

export function viewToHash(v: View): string {
  switch (v.kind) {
    case 'list':
      return '#/';
    case 'browse':
      return '#/browse';
    case 'daily':
      return '#/daily';
    case 'editor':
      return `#/editor/${v.repertoireId}`;
    case 'drill-setup':
      return `#/drill-setup/${v.repertoireId}`;
    case 'drill-session':
      return `#/drill/${v.repertoireId}/${v.mode}`;
    case 'walker-session':
      return `#/walker/${v.repertoireId}/${v.seed}`;
    case 'health-check':
      return `#/health/${v.repertoireId}`;
  }
}

export function hashToView(hash: string): View | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'list' };
  const [head, id, arg] = parts;
  switch (head) {
    case 'browse':
      return { kind: 'browse' };
    case 'daily':
      return { kind: 'daily' };
    case 'editor':
      return id ? { kind: 'editor', repertoireId: id } : null;
    case 'drill-setup':
      return id ? { kind: 'drill-setup', repertoireId: id } : null;
    case 'drill':
      return id && arg && (DRILL_MODES as string[]).includes(arg)
        ? { kind: 'drill-session', repertoireId: id, mode: arg as DrillMode }
        : null;
    case 'walker':
      return id && (arg === 'build' || arg === 'drill')
        ? { kind: 'walker-session', repertoireId: id, seed: arg }
        : null;
    case 'health':
      return id ? { kind: 'health-check', repertoireId: id } : null;
    default:
      return null;
  }
}

/** Views that need a loaded `active` repertoire before they can render. */
function repertoireIdOf(v: View): string | null {
  return 'repertoireId' in v ? v.repertoireId : null;
}

// While an async applyView (repertoire load) is in flight, the store→hash
// effect must not rewrite the hash — the store still shows the OLD view and
// would clobber the deep link the user just navigated to.
let applying = false;

async function applyView(v: View): Promise<void> {
  applying = true;
  try {
    const store = useAppStore.getState();
    const repId = repertoireIdOf(v);
    if (repId && store.active?.id !== repId) {
      try {
        await store.loadRepertoire(repId);
      } catch {
        // Repertoire gone (deleted / wrong link) — land on the list instead.
        useAppStore.getState().go({ kind: 'list' });
        location.hash = '#/';
        return;
      }
    }
    useAppStore.getState().go(v);
  } finally {
    applying = false;
  }
}

export function useHashRouting(): void {
  // Hash → store (initial load + back/forward).
  useEffect(() => {
    const initial = hashToView(location.hash);
    if (initial && viewToHash(initial) !== viewToHash(useAppStore.getState().view)) {
      void applyView(initial);
    }
    const onHashChange = () => {
      const v = hashToView(location.hash);
      if (!v) return;
      const cur = useAppStore.getState().view;
      if (viewToHash(cur) === viewToHash(v)) return; // our own write — ignore
      void applyView(v);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Store → hash (every in-app navigation becomes a history entry).
  const view = useAppStore((s) => s.view);
  useEffect(() => {
    if (applying) return;
    const target = viewToHash(view);
    if (location.hash !== target) location.hash = target;
  }, [view]);
}
