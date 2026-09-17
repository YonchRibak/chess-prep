/**
 * Minimal hash router: keeps the Zustand `view` union in sync with
 * `location.hash` so browser back/forward work, refresh restores your place,
 * and views are bookmarkable — without pulling in a router library.
 *
 * Mapping:
 *   #/                      → studies home (Study S3; also #/studies)
 *   #/repertoires           → hand-built repertoire list
 *   #/browse                → opening browser
 *   #/daily                 → daily diet
 *   #/editor/:id            → repertoire editor
 *   #/drill-setup/:id       → classic drill setup
 *   #/drill/:id/:mode       → classic drill session
 *   #/walker/:id/:seed      → walker session (build | drill)
 *   #/health/:id            → repertoire health check
 *   #/lines/:id/:intent     → line navigator (train | grow)
 *   #/prepare               → "Prepare against…" wizard (Flow F2)
 *   #/rashid-lab            → Rashid dev harness (no nav entry; type the hash)
 *
 * Flow F2: walker hashes also accept `guided=1`, marking a guided-prepare
 * session (line-first traversal + lock-in; see WalkerSession).
 *
 * Flow F1: drill/walker hashes accept an optional `?scope=kind:value` suffix
 * (e.g. `#/walker/:id/drill?scope=openingName:Caro-Kann%20Defense`) carrying a
 * session-scoped line scope. It lives in the hash — not only in store state —
 * so a deep-linked or refreshed scoped session stays scoped. A malformed scope
 * param is treated as ABSENT (the session falls back to the stored rules),
 * keeping `hashToView` total.
 */
import { useEffect } from 'react';
import { parseLineScope, type DrillMode, type LineScope } from '@chess-prep/shared';
import { useAppStore, type View } from '../store/app.ts';

const DRILL_MODES: DrillMode[] = ['due', 'walkthrough', 'weak', 'random', 'mistakes'];

/**
 * `?scope=kind:value&guided=1` suffix, or '' — 'all' and valueless scopes
 * encode as nothing, `guided` only when set (Flow F2).
 */
function sessionParams(scope: LineScope | undefined, guided?: boolean): string {
  const params = new URLSearchParams();
  if (scope && scope.kind !== 'all' && scope.value?.trim()) {
    params.set('scope', `${scope.kind}:${scope.value}`);
  }
  if (guided) params.set('guided', '1');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function parseScopeParam(query: string): LineScope | undefined {
  const raw = new URLSearchParams(query).get('scope');
  if (!raw) return undefined;
  const sep = raw.indexOf(':');
  // The value may itself contain ':' ("Caro-Kann Defense: Advance Variation"),
  // so only the FIRST colon separates kind from value.
  const kind = sep >= 0 ? raw.slice(0, sep) : raw;
  const value = sep >= 0 ? raw.slice(sep + 1) : undefined;
  try {
    const scope = parseLineScope({ kind, value });
    return scope?.kind === 'all' ? undefined : scope;
  } catch {
    return undefined; // malformed → session falls back to stored rules
  }
}

/** Spreadable `{ scope }` — empty when absent, so unscoped views stay key-free. */
function scopeProp(query: string): { scope?: LineScope } {
  const scope = parseScopeParam(query);
  return scope ? { scope } : {};
}

export function viewToHash(v: View): string {
  switch (v.kind) {
    case 'studies':
      return '#/';
    case 'list':
      return '#/repertoires';
    case 'browse':
      return '#/browse';
    case 'daily':
      return '#/daily';
    case 'editor':
      return `#/editor/${v.repertoireId}`;
    case 'drill-setup':
      return `#/drill-setup/${v.repertoireId}`;
    case 'drill-session':
      return `#/drill/${v.repertoireId}/${v.mode}${sessionParams(v.scope)}`;
    case 'walker-session':
      return `#/walker/${v.repertoireId}/${v.seed}${sessionParams(v.scope, v.guided)}`;
    case 'health-check':
      return `#/health/${v.repertoireId}`;
    case 'lines':
      return `#/lines/${v.repertoireId}/${v.intent}`;
    case 'prepare':
      return '#/prepare';
    case 'rashid-lab':
      return '#/rashid-lab';
  }
}

export function hashToView(hash: string): View | null {
  const qIdx = hash.indexOf('?');
  const path = qIdx >= 0 ? hash.slice(0, qIdx) : hash;
  const query = qIdx >= 0 ? hash.slice(qIdx + 1) : '';
  const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'studies' };
  const [head, id, arg] = parts;
  switch (head) {
    case 'studies':
      return { kind: 'studies' };
    case 'repertoires':
      return { kind: 'list' };
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
        ? {
            kind: 'drill-session',
            repertoireId: id,
            mode: arg as DrillMode,
            ...scopeProp(query),
          }
        : null;
    case 'walker':
      return id && (arg === 'build' || arg === 'drill')
        ? {
            kind: 'walker-session',
            repertoireId: id,
            seed: arg,
            ...scopeProp(query),
            ...(new URLSearchParams(query).get('guided') === '1' ? { guided: true } : {}),
          }
        : null;
    case 'health':
      return id ? { kind: 'health-check', repertoireId: id } : null;
    case 'lines':
      return id && (arg === 'train' || arg === 'grow')
        ? { kind: 'lines', repertoireId: id, intent: arg }
        : null;
    case 'prepare':
      return { kind: 'prepare' };
    case 'rashid-lab':
      return { kind: 'rashid-lab' };
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
        // Repertoire gone (deleted / wrong link) — land on home instead.
        useAppStore.getState().go({ kind: 'studies' });
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
