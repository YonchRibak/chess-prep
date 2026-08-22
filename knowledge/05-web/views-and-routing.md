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
  | { kind: 'drill-session'; repertoireId: string; mode: DrillMode; scope?: LineScope }
  | { kind: 'walker-session'; repertoireId: string; seed: 'build' | 'drill'; scope?: LineScope }
  | { kind: 'daily' }
  | { kind: 'health-check';  repertoireId: string }
  | { kind: 'lines';         repertoireId: string; intent: 'train' | 'grow' }
  | { kind: 'prepare' }
```

The optional `scope` on the two session views is the **Flow F1 session-scoped
override**: it narrows that one session and is never written back to the stored
`drillRules` (see [srs-drilling.md](../03-domain/srs-drilling.md#line-scopes-phase-9a)).
`walker-session` additionally takes `guided?: boolean` — the **Flow F2 guided-prepare
mode** ([walker](../03-domain/walker.md#guided-prepare-flow-f2)).

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
| `drill-setup` | [DrillSetup.tsx](../../apps/web/src/pages/DrillSetup.tsx) — mode, rules, and the Phase 9a **Line** picker; the live queue-length preview builds the real queue, so a scope that matches nothing shows `0` before the user starts |
| `drill-session` | [DrillSession.tsx](../../apps/web/src/pages/DrillSession.tsx) (classic) |
| `walker-session` | [WalkerSession.tsx](../../apps/web/src/pages/WalkerSession.tsx) |
| `daily` | [DailyDiet.tsx](../../apps/web/src/pages/DailyDiet.tsx) |
| `health-check` | [HealthCheck.tsx](../../apps/web/src/pages/HealthCheck.tsx) |
| `lines` | [LineNavigator.tsx](../../apps/web/src/pages/LineNavigator.tsx) — Flow F1: per-line due/toBuild badges; each row starts a session-scoped walker session |
| `prepare` | [PrepareWizard.tsx](../../apps/web/src/pages/PrepareWizard.tsx) — Flow F2: search target → infer color → extend/create (fenKey match decides) → prep target → launch a guided session. Commits the stem *before* launching, because a scoped build can't start a line that doesn't exist |

## Hash routing

[lib/router.ts](../../apps/web/src/lib/router.ts) — `useHashRouting()` is mounted once
and syncs both directions.

```
#/                     list (home)
#/browse               opening browser
#/daily                daily diet
#/editor/:id           repertoire editor
#/drill-setup/:id      classic drill setup
#/drill/:id/:mode      classic drill (mode ∈ due|walkthrough|weak|random|mistakes)
#/walker/:id/:seed     walker (seed ∈ build|drill)
#/health/:id           health check
#/lines/:id/:intent    line navigator (intent ∈ train|grow)
#/prepare              Prepare wizard (Flow F2)
```

Walker hashes also accept `guided=1` (`#/walker/:id/build?guided=1&scope=…`) —
anything other than exactly `1` parses as un-guided.

The drill and walker hashes accept an optional `?scope=kind:value` suffix
(URI-encoded; only the *first* colon separates kind from value, since book names
contain colons), e.g. `#/walker/abc/drill?scope=openingName:Caro-Kann%20Defense`.
The scope lives in the hash so a deep-linked or refreshed scoped session stays
scoped.

`viewToHash(v)` and `hashToView(hash)` are pure and total — `hashToView` returns `null`
for anything unrecognized (including an invalid drill mode or seed). A malformed
`scope` param is deliberately **not** unrecognized: it parses as *absent* (the session
falls back to the stored rules) rather than nulling out an otherwise valid route.
Round-trip tests: [router.test.ts](../../apps/web/src/lib/router.test.ts).

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
- Each card shows two primary actions (**Drill**, **Build**) — since Flow F1 both open
  the **line navigator** (`#/lines/:id/train|grow`) rather than jumping straight into a
  walker session, so per-line sessions are discoverable; "All lines" is the first,
  prominent row there. Edit, Classic drill, Health check, Export PGN, Rename, Delete
  live in an `OverflowMenu`.
- **One creation path:** "New repertoire" routes to the opening browser — pick a line on
  a real board, "Add to my repertoire" → create new → "Start building" jumps into the
  walker. Blank and Import PGN are secondary actions in the browser/list headers.
