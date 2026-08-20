# Views & routing

There is **no router library**. The app shell is a switch over a discriminated union,
kept in sync with `location.hash` by a small custom hook.

## The `View` union

[apps/web/src/store/app.ts](../../apps/web/src/store/app.ts):

```ts
type View =
  | { kind: 'list' }
  | { kind: 'browse' }
  | { kind: 'editor';        repertoireId: string }
  | { kind: 'drill-setup';   repertoireId: string }
  | { kind: 'drill-session'; repertoireId: string; mode: DrillMode }
  | { kind: 'walker-session'; repertoireId: string; seed: 'build' | 'drill' }
  | { kind: 'daily' }
  | { kind: 'health-check';  repertoireId: string }
```

Navigate with `useAppStore.getState().go(view)` — never by setting the hash directly.

## Shell

[App.tsx](../../apps/web/src/App.tsx) renders a top nav (Repertoires / Daily / Browse
openings), an `ErrorBanner` bound to `store.error`, and one page per `view.kind`.
Adding a view means touching four places: the union, `viewToHash`, `hashToView`, and the
`App` switch.

| `kind` | Page |
|---|---|
| `list` | [RepertoireList.tsx](../../apps/web/src/pages/RepertoireList.tsx) |
| `browse` | [BrowseOpenings.tsx](../../apps/web/src/pages/BrowseOpenings.tsx) |
| `editor` | [RepertoireEditor.tsx](../../apps/web/src/pages/RepertoireEditor.tsx) |
| `drill-setup` | [DrillSetup.tsx](../../apps/web/src/pages/DrillSetup.tsx) |
| `drill-session` | [DrillSession.tsx](../../apps/web/src/pages/DrillSession.tsx) (classic) |
| `walker-session` | [WalkerSession.tsx](../../apps/web/src/pages/WalkerSession.tsx) |
| `daily` | [DailyDiet.tsx](../../apps/web/src/pages/DailyDiet.tsx) |
| `health-check` | [HealthCheck.tsx](../../apps/web/src/pages/HealthCheck.tsx) |

## Hash routing

[lib/router.ts](../../apps/web/src/lib/router.ts) — `useHashRouting()` is mounted once
and syncs both directions.

```
#/                     list (home)
#/browse               opening browser
#/daily                daily diet
#/editor/:id           repertoire editor
#/drill-setup/:id      classic drill setup
#/drill/:id/:mode      classic drill (mode ∈ due|walkthrough|weak|random)
#/walker/:id/:seed     walker (seed ∈ build|drill)
#/health/:id           health check
```

`viewToHash(v)` and `hashToView(hash)` are pure and total — `hashToView` returns `null`
for anything unrecognized (including an invalid drill mode or seed).

### Two subtleties worth knowing before editing this file

1. **Deep links load data first.** `applyView` checks `repertoireIdOf(v)` and awaits
   `store.loadRepertoire(id)` before `go(v)`, so refreshing on `#/walker/abc/build` works.
   If the repertoire is gone (deleted or a bad link) it lands on the list instead of
   erroring.
2. **An `applying` module flag suppresses the store→hash effect** while that async load
   is in flight. Without it, the store still holds the *old* view and would clobber the
   deep link the user just navigated to.

## Navigation UX (Phase 8c)

- **Daily-first home:** the repertoire list opens with a "Today" banner (total due →
  start daily) and per-repertoire badges (due / cards / to-build) computed offline from
  IndexedDB via [lib/repStats.ts](../../apps/web/src/lib/repStats.ts).
- Each card shows two primary actions (**Drill**, **Build**); Edit, Classic drill, Health
  check, Export PGN, Rename, Delete live in an `OverflowMenu`.
- **One creation path:** "New repertoire" routes to the opening browser — pick a line on
  a real board, "Add to my repertoire" → create new → "Start building" jumps into the
  walker. Blank and Import PGN are secondary actions in the browser/list headers.
