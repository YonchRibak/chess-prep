# Flow phases F1–F4 — what's left to do by hand

The four flow phases are implemented, tested, and committed on stacked branches
(`feat/flow-f1-session-scope` ⊂ `feat/flow-f2-guided-prepare` ⊂
`feat/flow-f3-explorer-snapshot` ⊂ `feat/flow-f4-smart-train`). Everything below
is the part only a human on the right network / in front of the UI can do.

---

## Why the explorer answers 401 (re-diagnosed 2026-08-23)

First theory (IP blocklist) is **dead**: the 401 is identical from the home
ISP, a phone hotspot, and NordVPN — over IPv4 and IPv6, on both hostnames
(`explorer.lichess.ovh` and the OpenAPI spec's documented
`explorer.lichess.org`, which resolve to the same nginx), and with
browser-imitating headers (User-Agent / Origin / Referer). Meanwhile
`lichess.org` itself answers 200 from the same machine, and curl demonstrably
completes TLS with lichess's real OVH servers — so nothing local (Avast,
firewall, proxy) is involved.

What the 401 actually says: `401 Authorization Required`, with
`Access-Control-Allow-Headers: …, Authorization` — the server is advertising
that it accepts an `Authorization` header. Conclusion: **the explorer host now
refuses anonymous requests and wants a lichess API token** (a change after the
app's docs were written; the public OpenAPI spec hasn't caught up).

The code is ready for this: the cache service and the snapshot generator both
send `Authorization: Bearer $LICHESS_TOKEN` when it's set, and the default
hostname is now the documented `explorer.lichess.org`.

---

## 0. Get a lichess token and confirm it unlocks the explorer

1. Log in at lichess.org → <https://lichess.org/account/oauth/token> →
   **New personal access token** → name it (e.g. `chess-prep`), leave **all
   scopes unchecked**, create, copy the `lip_…` string (shown once).
2. Test it:

   ```powershell
   curl.exe -sS -o NUL -w "%{http_code}`n" -H "Authorization: Bearer lip_YOURTOKEN" "https://explorer.lichess.org/lichess?variant=standard&fen=rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR%20w%20KQkq%20-%200%201"
   ```

   - `200` → solved; continue below.
   - Still `401` → the token theory is wrong too. Then check whether the
     opening explorer works at all on <https://lichess.org/analysis> (book
     icon): if it loads there, open devtools → Network and inspect what the
     browser's explorer request sends that we don't; if it doesn't load even
     there, the explorer is globally down and the only move is waiting (or
     asking in lichess Discord #api).
3. Put the token in `apps/api/.env` (never commit it — `.env` is gitignored):

   ```
   LICHESS_TOKEN=lip_xxxxxxxxxxxxxxxx
   ```

4. Verify end to end: `pnpm --filter @chess-prep/api probe:explorer` should
   print `tier: live` and real move stats.

No VPN or hotspot needed for any of this — the network was never the problem.

---

## 1. Generate the snapshot (one-time, mostly unattended)

With `LICHESS_TOKEN` in `apps/api/.env`, run it right here:

```powershell
pnpm --filter @chess-prep/api snapshot:build
```

Defaults: **cap of 5,000 positions**, best-first by game count (most-played
positions crawled first), within 12 plies, share ≥2%, and an absolute floor of
≥1,000 games per branch. The cap is the real size knob — a relative share
floor alone never converges, because a rare position's own top replies are
still above 2% *of that position*.

It's deliberately polite — one request at a time, ~0.8 s apart, 60 s backoff
on any 429 — so the default cap takes roughly **1½ hours**. Progress logs
every 50 positions. Output is **appended as it goes** and `meta.json` is
refreshed periodically, so **Ctrl+C keeps everything fetched so far** as a
valid, importable (smaller) snapshot; because the crawl is best-first, an
interrupted run still contains the *most popular* positions, which are the
ones that matter.

Want it shorter? `-- --max-positions 2000` (~30 min) is already a solid
floor. Check `apps/api/data/explorer-snapshot/meta.json` for the final count
and whether the run was `complete`.

(If you ever need to run it on another machine instead: the script imports the
API's env module, which demands a `DATABASE_URL` even though the generator
never touches the database — a dummy like
`DATABASE_URL=postgres://x:x@localhost:5432/x` satisfies it; no connection is
opened.)

---

## 2. Commit and import it

```powershell
git add apps/api/data/explorer-snapshot
git commit          # it's vendored data, like the ECO TSVs
pnpm --filter @chess-prep/api db:import-explorer-snapshot
```

The importer is drop-and-reload and validates every row — including that each
fenKey is exactly what `fenKey()` produces (a mis-keyed row would silently
never be hit by lookups). Then verify the tier actually answers:

```powershell
pnpm --filter @chess-prep/api probe:explorer
```

It now prints `tier: ...`. On this machine (live fetch fails, cache cold or
stale) you should see `tier: snapshot` for the starting position.

Full acceptance test from the plan, if you want it: truncate
`explorer_entries`, kill Wi-Fi, run the guided wizard — replies should still
rank by real frequency.

> Note: migration `0010_explorer_snapshot` is already applied to the dev
> database on this machine. Any **other** machine needs `pnpm db:migrate`
> before importing.

---

## 3. Manual UI pass (there is no component/E2E test layer)

Everything pure is covered by the automated tests (268 passing across the
workspace), but the session UIs need eyes. `pnpm dev`, then:

### F1 — line navigator & session scope

- Home → **Train** on a repertoire → line list: "All lines" first, named lines
  indented, badges (due / cards / to build / recent misses) per row. Starting
  a scoped session is two taps total.
- Mid-session, refresh the browser: the hash (`?scope=...`) must keep the
  session scoped.
- Afterwards, check the repertoire's drill rules in the editor and the Today
  count: **byte-identical to before**. That's the point — a one-night focus
  must no longer reshape tomorrow's daily diet.

### F2 — the guided prepare flow

- Nav → **Prepare** → type "Caro-Kann" → it should infer *White*, offer
  extend/create (extend pre-selected if a repertoire already contains the
  stem), target presets, then launch.
- In the session: opponent replies appear silently, each of your turns shows
  engine+popularity candidates, and playing a move directly on the board works
  at every prompt.
- After a line completes (or 5 new moves), the **lock-in** replay starts.
  Critical invariant: **the engine panel must vanish for the whole lock-in** —
  if an eval is visible before answering a lock-in card, that's a bug.
- Watch the header meter count down; at the end, the summary's
  "Drill these now" should start a drill scoped to what you just built.

### F3 — after the snapshot import

- `probe:explorer` prints which tier answered.
- With Wi-Fi off and `explorer_entries` truncated, the guided flow still ranks
  opponent replies by real frequency.
- The guided meter upgrades from structural counts to "% of games covered"
  when entries are warm.

### F4 — home & smart queue

- Home reads: Today → Prepare against… → repertoire cards with **Train/Grow**;
  nav is *Repertoires · Today · Prepare*.
- Train mixes due cards, then recent mistakes, then new cards; the
  "Advanced: queue mode" disclosure switches modes and restarts the queue.
- New-card budget is shared with the daily diet — running Today first should
  shrink Train's new-card tail accordingly.

---

## 4. Merging

**Done** — all four flow branches are merged into `main` (see
`git branch --merged main`). This section is kept for the record; the manual
UI pass in §3 is still the only verification the session UIs get.
