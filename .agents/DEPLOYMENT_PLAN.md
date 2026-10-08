# Deployment Plan — Dispatch Pilot

Status: Phases 0–8 complete — **deployed 2026-10-08** (see PROGRESS.md for run
reports; the Phase 7 deviations — the baked copy carries both static
markers (`serviceDayStartSeconds` + `loadedAt`), and `terminalsSource`
flips to `manual` only on an actual terminal-list change — are
owner-approved). **Phase 10 complete and released** (`main` at `a4dafae`, deployed).
**Phase 11 complete on `dev`** (merged `04a3293`, 212 tests, awaiting the
owner's next release PR): basic-auth gate over the whole site — SPA, all
`/api` routes, WS handshake — with `GET /api/health` exempt and
`x-dispatch-token` still accepted. Known follow-up for the next batch:
the mutating-route gate should also accept basic auth (basic-only browser
users can read but cannot apply/decline until they set the Settings
token). **Phase 12 added** (owner-reported quirks, root-caused:
session-baseline facts, flip-geometry corroboration, terminal-scoped
ledger facts). Remaining: the owner's `dev` → `main` release PR, then Phase 9
(data review) after ~24 h of runtime. Decisions are final; do not
re-litigate them without the owner. Update PROGRESS.md after each phase.

## Goal

Run the dispatch pilot continuously on Fly.io, collecting two historical
datasets for later review, auto-deployed from GitHub on merge to `main`:

1. Every recorded terminal arrival/departure (`run_events`), for **all**
   active terminals — not just terminals a user happens to have open.
2. Every hold recommendation the engine generates (`interventions` +
   `intervention_events`), for all active terminals, with enough context
   (headway gaps, neighbors) to analyze quality later.

Secondary goals shipped alongside, because they block the two above:

- Fix terminal discovery so time-of-day terminal variants are all found (e.g.
  #9 southbound: 104 Vincennes in the morning, 95 Beverly midday) and the UI
  shows only the terminals active **at the current moment**.
- Evaluate and log recommendations for every **active** terminal on every
  refresh, regardless of viewership.

## Decisions (already made with the owner)

| Decision | Choice |
| --- | --- |
| Host | Fly.io, single app, `ord` region, **1 GB machine** (512 MB measured too thin for the baked-table copy; downsize later if metrics allow), **10 GB volume** — the full free allowance; ≥2 GB is required (see the WAL-spike note in 7b) |
| Environments | One production instance only; `dev` branch runs CI, does not deploy |
| Deploy trigger | Push to `main` (merged PR) → CI → bake + auto `fly deploy`; **plus a scheduled daily cron deploy** that refreshes the baked static data |
| Access control | Basic-auth gate over the entire site (SPA + all endpoints + WS) with `DISPATCH_TOKEN` as the password (Phase 11); `GET /api/health` exempt (Fly's check); `x-dispatch-token` still accepted for scripts; unset token = open (local dev) |
| Static data | **Baked into the image by CI** — the GTFS parse (~3.5 GB peak) never runs on the Fly machine; runtime copies the baked static tables into the volume DB when the image is newer |
| Route focus | `focusRouteIds` config (env `FOCUS_ROUTES` seed, default = all routes): the pilot tracks a subset of routes end-to-end — menu, facts, recommendations, logs — runtime-adjustable, no restart |
| Refresh ticks | Facts at 10 s; decisions flat every 30 s (`DECISION_INTERVAL_SECONDS`) over the focused active terminals |
| Branch protection | `main`: PR + `ci` check, no direct push. `dev`: stays open to direct merges (matches how agents integrate; retroactive PRs unnecessary). **Default branch stays `main`** — GitHub scheduled workflows only run from the default branch, so `dev` as default would make the nightly cron deploy unreleased code |
| Cost target | ~$6.40/month total (1 GB machine; volume free) |

## Verified baseline findings (do not re-research)

- 162 tests pass; lint has one error only in the untracked throwaway
  `server/src/_vpStatus.ts` (never referenced; like `server/src/_diag.ts` it is
  a diagnostic scratch file). No `.github/`, no Dockerfile, no `dev` branch.
- Terminal discovery (`server/src/engine/terminal.ts:150-289`) picks only the
  **modal** first/last stop per `route:direction` (`modal()` at 218-234), so a
  minority time-of-day variant terminal (104 Vincennes vs 95 Beverly) is
  dropped entirely. Discovery runs only when `config.terminals` is empty
  (`server/src/index.ts:66`), only for the current date's service IDs
  (`index.ts:69`), and persists into config, which permanently disables
  re-discovery.
- Auto-discovered terminals bake whole-day `routeIds` into config, so
  `buildRouteStates` (`server/src/engine/engine.ts:978-986`) bypasses the
  time-windowed `outboundRoutesAtTerminal` route resolution that manual
  terminals get.
- The 10 s refresh loop builds snapshots/decisions/log only for **subscribed**
  terminals: `wanted = new Set(subscriptions.keys())` (`index.ts:247`). With
  zero WS subscribers nothing is evaluated — no recommendations, no
  `run_events`. The user's suspicion is confirmed.
- `run_facts` (arrival/departure ledger upserts) **is** global — `recordFacts`
  runs against all `config.terminals` before the wanted filter
  (`engine.ts:294-303`). But the append-only `run_events` audit is written only
  from `buildRouteStates` (`engine.ts:1048`), i.e. only for evaluated
  terminals. Both gaps close automatically once evaluation is global.
- `intervention_events.metadata_json` exists in schema but is never populated;
  the only numeric decision context (forward/backward headway) lives inside
  the human `reason` string (`server/src/engine/dispatch.ts:126-128`).
- Static GTFS is **not** auto-refreshed while running. `ensureStaticLoaded`
  runs only at startup and via manual `POST /api/static/reload`; the realtime
  loop never re-checks `staticRefreshHours` staleness. Worse, the stale-reload
  path re-reads the cached zip: `downloadStatic` (`server/src/gtfs/static.ts:56-70`)
  returns a valid cache without ever re-fetching, and only `force` (manual
  reload) bypasses it — but that path skips writing the cache
  (`static.ts:205-207`). On a persistent volume the static feed would freeze
  at day-0 bytes forever, even across restarts and deploys. CTA republishes
  the zip regularly, so this must be fixed for a long-running collector.
- Mutating routes (token-gate targets): `POST /api/interventions/:id/view|apply|decline|cancel`
  (`routes.ts:188-199`), `PUT /api/config` (`routes.ts:314`), `POST /api/static/reload`
  (`routes.ts:331`). All GETs and the WS stream are reads.
- Logging today is correctly focused (no vehicle-ping logging, no per-poll
  dumps; `config_events` redacts the API key). Keep it that way — see
  Non-goals.

## Git flow for all phases

Owner created `dev` off `main` before handoff (verify: `git branch --all`).
Repo conventions in `.agents/AGENTS.md` apply (focused branches, imperative
commits, no direct pushes to `main`/`dev`).

- Feature/fix work: branch off `dev` (`feat/terminal-time-variants`,
  `feat/global-recommendations`, `fix/static-auto-refresh`,
  `feat/dispatch-token-gate`, `chore/docker-fly-packaging`,
  `chore/github-ci`, `feat/baked-static`), PR into `dev`. Direct `--no-ff`
  merges into `dev` are acceptable when no PR tooling is available (the
  Phase 0–6 precedent); `main` stays PR-gated after the owner sets
  protection.
- Release: PR `dev` → `main`. Merge = CI + auto-deploy.
- CI runs on every PR (to `dev` or `main`) and on every push to `dev`.
- Deploy workflow runs on push to `main` only.

---

## Phase 0 — Hygiene

1. `git switch dev` and confirm baseline: `npm run lint`, `npm run typecheck`,
   `npm test` all pass after 2 below.
2. Remove the scratch file `server/src/_vpStatus.ts` (untracked, unreferenced;
   it also fails lint). Do not commit it. Alternatively add it to
   `.gitignore` next to `_diag.ts` — deleting is preferred since it duplicates
   decode logic from `gtfs/realtime.ts`.

**Accept:** lint/typecheck/test green on `dev` with no untracked files.

## Phase 1 — Time-of-day terminal discovery + active-only display

Branch: `feat/terminal-time-variants` → PR into `dev`.

### 1a. Discovery keeps every variant, not the modal endpoint

`server/src/engine/terminal.ts` `autoDiscoverTerminals`:

- Replace modal selection: for each `route:direction`, keep **every** distinct
  first-stop and last-stop that appears as an endpoint of at least
  `DISCOVERY_MIN_TRIPS` trips (constant, set to 2, comment why: filters
  one-off deadheads/short-turns while keeping scheduled variants like the #9
  morning/midday split).
- Keep the existing per-stop terminal assembly (one terminal per distinct
  stop id, co-located stops merged by route union) — unchanged behavior
  otherwise.
- Widen the service-ID scope: union of `activeServiceIds` over the **next 7
  days** instead of only today, so weekend-only variants are discovered. Loop
  `activeServiceDate` per day and union the sets (cheap; runs only on static
  load/refresh).

### 1b. Re-discovery replaces auto terminals on static refresh

`server/src/config.ts` + `server/src/index.ts`:

- Persist a new setting `terminalsSource: 'auto' | 'manual'`.
  - Absent key → default `'auto'` (today the only way terminals got populated
    is discovery; this preserves existing deployments).
  - `PUT /api/config` with a `terminals` payload → `'manual'` (owner override
    wins, forever, exactly like today).
- `discoverTerminals()` (`index.ts:64-74`): when source is `'auto'`, re-run on
  every static load (fresh or reuse — i.e. also on the 24 h refresh cycle and
  restart) and replace `config.terminals` when the result differs. When
  `'manual'`, never touch it (current behavior).

### 1c. Active-terminal computation at request time

`server/src/engine/terminal.ts` — add a windowed activity query (mirror the
existing `outboundRoutesAtTerminal` SQL at 97-120). A terminal is **active**
for route R in window `[now − 30 min, now + lookaheadMinutes]` iff any trip of
R either **departs** from one of its stopIds as first stop (`pickup_type != 1`)
or **arrives** at one as last stop (`drop_off_type != 1`) in the window. The
inbound-arrival side is what makes 104 Vincelles morning-active and 95 Beverly
midday-active.

`GET /api/terminals` (`server/src/api/routes.ts:201-233`): for each route
entry, keep `terminalIds` filtered to active ones, and add
`inactiveTerminalIds` (the rest) so deep links to inactive terminals still
work and the UI can offer a collapsed section.

### 1d. UI shows only active terminals, at the current moment

`web/src/pages/Terminals.tsx`:

- Render only active terminal links per route group. Render inactive ones in
  a collapsed "off-duty" disclosure per route (default closed), labeled with
  the terminal name/id as today.
- The page currently fetches once on mount; make it poll every 60 s and
  refetch on `visibilitychange` → visible, so the list reflects "the moment".
- `web/src/api.ts`: extend `TerminalsResponse` with `inactiveTerminalIds`
  (shared types too if the DTO moves through `shared/types.ts` — follow the
  existing response typing pattern).

### 1e. Engine uses the windowed route list for auto terminals

`server/src/engine/engine.ts:978-986`: intersect `terminal.routeIds` (when
present) with `outboundRoutesAtTerminal(...)` for the current window, instead
of using the static whole-day list verbatim. Keep the existing union with
queued intervention route ids (a route with pending work stays visible).
Manual terminals without `routeIds` keep the current path unchanged. This
prevents empty route groups in snapshots and wasted per-refresh work, and it
composes with Phase 2's all-terminal evaluation.

### Tests

- `terminal.test.ts`: fixture route, direction 1: morning trips ending at
  stop A, midday trips ending at stop B, single deadhead ending at C →
  terminals A and B discovered, C filtered by `DISCOVERY_MIN_TRIPS`; a
  variant served only by a weekend service id is discovered via the 7-day
  scope.
- Activity query: same fixture at 07:00 → A active / B inactive; at 12:00 →
  B active / A inactive; at 23:00 → neither.
- `routes.test.ts`: `/api/terminals` returns active + inactive split for a
  fixed clock (follow the existing `activeServiceDate` fixture pattern at
  `routes.test.ts:234`).
- `engine.test.ts`: a terminal whose `routeIds` includes a route with no
  departures in the window produces no route state for it, but a queued
  intervention keeps it visible.

**Acceptance:** with local GTFS loaded, `GET /api/terminals` at ~07:00 lists
104 Vincelles (not 95 Beverly) for #9 and the reverse at midday; both appear
in config `terminals` after discovery; lint/typecheck/test green; README
"Terminals are auto-discovered…" paragraph updated to describe variants,
7-day scope, and re-discovery.

## Phase 2 — Recommendations + logging for every active terminal

Branch: `feat/global-recommendations` → PR into `dev`. Depends on Phase 1's
activity query.

### 2a. Evaluate all active terminals every poll

`server/src/index.ts` `refreshInternal` (244-252):

- `wanted` = active terminals (Phase 1c activity query across all
  `config.terminals` for the current window) ∪ `subscriptions.keys()` (a user
  manually watching an off-duty terminal still gets a snapshot).
- Engine already handles the rest: `engine.refresh` builds states per wanted
  terminal, `decideTriplets` → `refreshSuggestion` queues interventions, and
  `recordRunEvents` runs per departure in `buildRouteStates` — so arrivals/
  departures and recommendations become global automatically.
- Broadcast stays viewer-scoped: only push snapshots for terminals in
  `subscriptions` (unchanged — `broadcaster.broadcast(fresh)` receives all;
  filter to subscribed before sending, or keep sending the array and let the
  WS layer filter per client — follow `server/src/api/ws.ts`'s per-client
  model and keep payloads small).
- Guard the 10 s cadence: after the switch, log a warning when a refresh
  cycle exceeds `refreshIntervalSeconds / 2` wall time (the `[refresh]`
  duration log already exists at `index.ts:255`; add the conditional warn).
  If all-terminal evaluation is materially slower than ~2–3 s on a dev
  machine, do not re-architect — report the measurement in PROGRESS.md and
  proceed (512 MB Fly machine is sized for the load; measure, don't guess).

### 2b. Record decision context numbers on recommendation events

`server/src/db/interventions.ts` `refreshSuggestion` (77-152):

- Populate `intervention_events.metadata_json` for `created` and `updated`
  events with the machine-readable decision context: `forwardHeadwaySeconds`,
  `backwardHeadwaySeconds`, `leaderEdt`/`followerEdt` at decision time,
  `centerEdt`, `maxHoldSeconds`, `leadTimeSeconds`. The values are already on
  the `TripletDecision` inputs in `engine.ts:1022-1039` — thread them through
  `refreshSuggestion`. Store as a JSON object; redact nothing (no secrets
  exist in decision context). The `reason` string stays for humans.

### 2c. Confirm logging is complete and focused (audit pass)

Verify, and fix only if broken:

- Every recommendation generated while nobody is watching lands in
  `interventions` (`status='pending'`) with a `created` event, and gets
  `expired`/`completed` events at end of life (`expirePending` /
  `completeTrip` already do this).
- `run_events` rows appear for arrivals/departures at never-viewed terminals.
- No new per-poll logging is introduced: no VP pings, no snapshot dumps, no
  feed-sample persistence. `run_events` stays dispatch-window-bound
  (`buildDepartures` window ~ now−30 min … now+90 min) — that is the intended
  focus; document it in README's known-limitations so future analysis knows
  the horizon.

### Tests

- `engine.test.ts` (pattern exists at 467-475, "records departures globally…"):
  refresh with `wanted = active set` where terminal T was **never** subscribed
  → after the refresh, `interventions` has the queued suggestion for T and
  `run_events` has T's arrival/departure rows.
- `interventions.test.ts`: `created`/`updated` events carry `metadata_json`
  with the headway fields.

**Acceptance:** with the app running locally for a few minutes and no browser
open, `run_events` and `interventions` rows accumulate across all active
terminals; PROGRESS.md records the measured full-refresh wall time; README
logging section updated.

## Phase 3 — Scheduled static GTFS refresh from the hosted feed

Branch: `fix/static-auto-refresh` → PR into `dev`. Small and self-contained;
see the findings above for why this is required, not optional.

### 3a. Stale reloads actually re-download

`server/src/gtfs/static.ts`:

- `downloadStatic(url, cachePath, opts?)`: add `opts.force` — when true, skip
  reading the existing cache (always fetch from the URL) but **still write the
  fresh bytes back to the cache**. Non-force behavior is unchanged: a valid
  cache short-circuits, so restarts within the freshness window keep their
  zero-download boot.
- `GtfsStaticProvider.load()` (`static.ts:199-207`): the `force` path passes
  `cachePath` + force (so manual reloads refresh the cache) instead of
  downloading with no cache path.
- `ensureStaticLoadedInternal` (`server/src/index.ts:102-139`): the stale
  branch (and only it) downloads with force semantics — staleness means "the
  cached bytes are what's stale, get new ones." The fresh-reuse branch stays
  byte-identical.

### 3b. Staleness check while running

`server/src/index.ts`: alongside `scheduleRefresh`, add a self-scheduling
timer (same pattern) that calls `void ensureStaticLoaded(false)` on an
interval — hourly by default, tunable via env `STATIC_CHECK_SECONDS`
(default 3600; documented in `.env.example` as an operations knob so the
acceptance test below can run in minutes). The call no-ops unless
`staticRefreshHours` staleness is exceeded (the guard is one COUNT + a
loadedAt read). This covers weeks-long uptime; deploys restart the machine
onto the same fixed boot path.

Notes:

- A reload mid-service cancels pending/applied interventions
  (`cancelForStaticReload`) and re-runs terminal discovery (Phase 1b) —
  existing intended behavior; keep it.
- A ~daily re-download of the static zip is trivial egress; no conditional
  GET / ETag support needed now.

### Tests

- New `server/src/gtfs/static.test.ts` (or extend `staticLoader.test.ts`)
  with a temp cache dir and a mocked `fetch`: with a valid cached zip present,
  non-force → cache hit, no fetch; force → fetches and **replaces** the cache
  bytes.

**Acceptance:** locally, set `STATIC_CHECK_SECONDS=60` and
`staticRefreshHours` to `0.02` via `PUT /api/config`; confirm within ~2
minutes the logs show a `[static] load` (fresh download, not `reuse`), the
cache zip's mtime advances, and pending interventions get canceled on the
reload; lint/typecheck/test green.

## Phase 4 — Dispatch token gate

Branch: `feat/dispatch-token-gate` → PR into `dev`.

- Env `DISPATCH_TOKEN` (`.env.example` entry with a comment). **Unset →
  behavior identical to today** (local dev friction-free).
- Set → middleware before the mutating routes (`routes.ts`): the 5
  intervention POSTs, `PUT /api/config`, `POST /api/static/reload` require
  header `x-dispatch-token: <value>`; mismatch → `401`
  `{"error":"token required"}`. Constant-time compare (`crypto.timingSafeEqual`).
- `GET /api/health` gains `tokenRequired: boolean` so the UI can tell.
- Web: `web/src/api.ts` mutating fetch wrapper adds the header from
  `localStorage.dispatchToken`; `web/src/pages/ConfigPage.tsx` gains a small
  token field (set/test/clear). Reads and WS never send it.
- Tests: `routes.test.ts` with `DISPATCH_TOKEN` set — POST without header 401,
  with header succeeds; without the env, all pass unchanged.

**Acceptance:** mutating endpoints blocked in production build with the token
set; all reads incl. `/api/health`, `/api/run-events`, WS open.

## Phase 5 — Docker + Fly packaging

Branch: `chore/docker-fly-packaging` → PR into `dev`.

### Dockerfile (repo root, multi-stage)

- Builder `node:22-slim` + `build-essential` + `python3` (better-sqlite3
  source-build fallback): `npm ci`, `npm run build` (typecheck + web + server
  bundle), then `npm ci --omit=dev` into a clean prod `node_modules` (or copy
  the full install if omit-dev misbehaves with workspaces — verify
  `better-sqlite3` loads in the runtime stage).
- Runtime `node:22-slim`: copy prod `node_modules`, `server/dist/index.js`,
  `web/dist`, root `package.json` files needed by workspaces resolution.
- `ENV PORT=8080 DB_PATH=/data/dispatch.db STATIC_GTFS_PATH=/data/gtfs.zip`.
- `CMD ["node", "server/dist/index.js"]`. Note: `dotenv.config` resolves
  `../../.env` from `server/dist` — absent in the image, harmless; Fly
  provides env directly.
- No Docker Desktop on the dev machine — the image is never built locally.
  Verification happens in two parts:
  - Local (no Docker): replicate the image's command sequence in a fresh
    clone in a temp dir: `npm ci` → `npm run build` → prod-install step →
    `CTA_API_KEY=… node server/dist/index.js` → `/api/health` ready after
    static load, WS connects, a terminal snapshot renders. This proves every
    step the Dockerfile encodes, without building the image.
  - Remote (Phase 8): Fly's remote builder performs the actual first image
    build at `fly launch`/first deploy — watch that build; Dockerfile errors
    surface there, not before. Record the deferral in PROGRESS.md.

### fly.toml (repo root)

- `app = "dispatch-pilot"` (owner confirms the name is free at launch),
  `primary_region = "ord"`.
- `internal_port = 8080`, `force_https = true`, `min_machines_running = 1`
  (never autostop — the collector must stay up).
- `[[mounts]] source = "data", destination = "/data"` (1 GB).
- Health check: `[[checks]]` http on `/api/health` port 8080, interval 10 s,
  timeout 5 s. `/api/health` returns 200 even while static is loading
  (`phase` communicates detail), which is fine for keep-alive.
- Machine: `size = "shared-cpu-1x"`, `memory = 512mb`. **Measure first:** peak
  RSS during static GTFS load + a full all-terminal refresh locally
  (e.g. Task Manager / `process.memoryUsage()` log line during
  `npm start`). If peak exceeds ~400 MB, use 1 GB (~$6.4/mo — still cheap;
  record the measurement in PROGRESS.md).
- `kill_timeout = 30` (let the refresh loop settle; no data-loss risk — facts
  are committed synchronously to SQLite).

**Acceptance:** Dockerfile + fly.toml committed per spec; the fresh-clone
command sequence runs green locally (the substitute for an image build, since
the dev machine has no Docker); PROGRESS.md records that the image build
itself is deferred to Fly's remote builder. Serving over TLS, volume
persistence, and `[static] reuse` are verified at first deploy (Phase 8).

## Phase 6 — GitHub CI/CD

Branch: `chore/github-ci` → PR into `dev`. (Requires Phase 5's Dockerfile +
fly.toml to be merged first; the deploy workflow is inert until the app and
`FLY_API_TOKEN` secret exist.)

### `.github/workflows/ci.yml`

- Triggers: `pull_request` (branches: `dev`, `main`), `push` (branch: `dev`).
- One job, `ubuntu-latest`, Node 22 via `actions/setup-node@v4` with
  `cache: npm`: `npm ci` → `npm run lint` → `npm run typecheck` →
  `npm run build` → `npm test`. (better-sqlite3 ships Linux x64 prebuilds;
  no apt packages needed.)
- Target: green in ≤ ~5 min. Commit message/PR must reference this plan.

### `.github/workflows/deploy.yml`

- Trigger: `push` (branch: `main`) + `workflow_dispatch` (manual redeploy).
- Steps: checkout → `superfly/flyctl-actions@master` setup →
  `flyctl deploy --remote-only` (remote builder; Windows contributors don't
  need Docker).
- Secrets: `FLY_API_TOKEN` (repo secret, created by owner — see Phase 8).
- `concurrency: group: deploy, cancel-in-progress: false` (serialize deploys).
- Deploy does **not** rerun tests — it is gated on the same commit's CI via
  branch protection on `main` (require `ci` check before merge). Note this in
  the workflow file comment.

### Branch protection (owner task — needs GitHub web UI or `gh`; `gh` is not
installed on the dev machine)

- `main`: require PR, require status check `ci` (lint/typecheck/test job),
  no force push, no direct push. `dev`: stays open to direct merges (the
  workers integrate with `--no-ff` merges; retroactive PRs unnecessary).
- Keep the default branch as `main`. GitHub scheduled workflows run only
  from the default branch's workflow file — a `dev` default would make the
  nightly cron deploy unreleased dev code. Feature PRs are rare (direct
  merges are the norm); the one PR that matters (the `dev`→`main` release)
  wants base `main`, which GitHub preselects when `main` is default.

**Acceptance:** a PR into `dev` shows CI checks and blocks merge on failure;
a merged PR `dev`→`main` auto-deploys (verify after Phase 8).

## Phase 7 — Baked static data + refresh cadence (pre-launch)

Added after the Phase 0–6 report; supersedes Phase 5's machine-sizing note.
Branch: `feat/baked-static` → merge into `dev`. Fixes the two launch blockers
the report measured:

- Static load peak RSS ~3.5 GB (parse) / ~2.6 GB (persist) on 96 k trips /
  5.9 M stop_times — the 1 GB machine OOMs at first load; persist alone
  took ~27 min on a dev machine.
- Full refresh with ~290 active terminals takes 40–60 s per cycle — over the
  10 s cadence (slow warning every cycle), and it delays arrival/departure
  detection (confirm pings are poll-counted).
- Steady-state RSS after a reuse boot: ~368 MB (informs machine sizing).

Design: **the GTFS parse never runs on the Fly machine.** CI bakes a
static-only SQLite file during the deploy build; at runtime the server
copies the baked static tables into the volume DB when the image carries
newer data than the volume. Static refreshes arrive via the scheduled daily
deploy (seconds of downtime; volume data survives).

### 7a. Bake script

`server/scripts/bake-static.ts`, run with `npx tsx` in CI (no server start):
download the static zip (public URL — no `CTA_API_KEY` needed), reuse the
existing parse + `loadStatic` against a throwaway DB path, producing
`baked.db` at the repo root (gitignored). It must contain only the static
tables (`stops`, `routes`, `trips`, `stop_times`, `calendar`,
`calendar_dates`, `block_trips`) plus the static `loadedAt` marker
(`createDatabase` + `loadStatic` produce the schema; operational tables
stay empty). The ~3.5 GB peak is fine on a GitHub runner (~16 GB).

### 7b. Runtime baked mode (env `BAKED_STATIC_DB`)

`server/src/index.ts` + a small `db/` helper. If the baked file exists →
baked mode; local dev without it keeps the existing download path unchanged.

- On boot and in the Phase 3 hourly check, compare the baked `loadedAt`
  against the volume DB's. Baked newer → refresh: `ATTACH` the baked file
  read-only, and in one transaction drop/recreate the static tables in the
  volume DB (schema.ts definitions) and fill each via
  `INSERT INTO main.<t> SELECT * FROM baked.<t>`, update only the volume's
  static `loadedAt` marker, then run the existing post-load steps
  (`engine.invalidateStaticCaches()`, `cancelForStaticReload`,
  re-discovery, WAL checkpoint). Copy strictly the static tables — never
  the baked `settings` or other operational tables (the volume's config and
  logs live there). SQL-level copy, no JS row materialization: memory stays
  near steady state; target < 5 min on shared-cpu-1x. Volume sizing
  follows from this: the copy is one transaction and the WAL cannot
  checkpoint past an open transaction, so peak disk during each daily
  copy is DB (~640 MB) + WAL (~500–650 MB) ≈ 1.2 GB — a 1 GB volume
  would hit SQLITE_FULL on the second day (day 1 on a fresh volume
  squeaks by, the nasty part). Size the volume ≥ 2 GB; the eventual
  code-level alternative is batching the copy so the WAL checkpoints
  between transactions.
- In baked mode the runtime must **never** download/parse the zip: if both
  DBs are older than `staticRefreshHours`, log it and surface
  `staticStale: true` on `/api/health` (awaiting the next scheduled deploy).
  Without this gate the Phase 3 hourly check would OOM-loop the machine the
  first day the volume data aged past `staticRefreshHours`.

### 7c. Route focus + flat decision tick

Simplified at the owner's call from an earlier tiered/staggered design.
With ~290 active terminals a flat 30 s pass cannot fit one shared vCPU (a
full pass measured 40–60 s, single-threaded — extra cores or memory would
not shrink a serial pass). Instead of scheduling complexity, shrink the
scope: the pilot focuses on a configurable subset of routes, and facts,
recommendations, logging, and the terminal menu all run globally on those
routes at a flat 30 s.

The focus is principled, not a cop-out: the triplet rule needs three
consecutive departures close together, which happens on high-frequency
corridors — infrequent routes rarely form triplets and produce almost no
recommendations — so full coverage spends most of its CPU on terminals
that log nothing useful. Focus gives denser data where the rule bites, and
the dataset is cleanly "complete for focused routes."

- New config `focusRouteIds: string[]` (default empty = all routes, local
  dev and today's behavior unchanged; seeded once from optional env
  `FOCUS_ROUTES`, comma-separated). Runtime-editable via `PUT /api/config`
  like every other key. When set (with `terminalsSource: auto`), discovery
  produces terminals for focused routes only, and `applyConfig` recomputes
  the persisted terminal list on change — no restart (the volume DB
  already holds an all-routes terminal list from earlier runs; setting the
  focus must recompute it, not just filter future discovery). Scoping
  discovery scopes everything downstream automatically: facts, decisions,
  `run_events`, interventions, `/api/terminals`. Manual terminal config
  still wins as today.
- Fact tick at `refreshIntervalSeconds` (10 s): global fact pass over the
  focused terminals (arrivals/departures → ledger, `run_facts`, fact
  events) + cheap intervention expiry.
- Decision tick at `DECISION_INTERVAL_SECONDS` (default 30, flat):
  `buildRouteStates` for focused active terminals ∪ subscriptions
  (recommendations, `run_events`, snapshots/broadcast). At ~10–20 focused
  routes (≈20–60 terminals) a pass is ~3–12 s — comfortably inside 30 s.
  Keep the slow-cycle warning when a decision pass exceeds the interval:
  that is the signal the focus list has outgrown the machine (ceiling
  ≈ 75–100 terminals ≈ 35–45 routes on shared-cpu-1x).
- Picking the list (owner, runtime-adjustable): start with ~10
  high-frequency corridors (include the #9); after Phase 9, the
  `run_events`/interventions counts show which focused routes never
  produce recommendations — swap them for denser ones.

Deferred (do not build now): if coverage ever needs to exceed ~40 routes,
the answer is the tiered/staggered scheduler previously drafted here (hot
set by imminent EDT + rotating warm buckets + fact-triggered evaluation)
or cheaper per-terminal evaluation — decide then, with the data.

Add `FOCUS_ROUTES` and `DECISION_INTERVAL_SECONDS` to `.env.example`.

### 7d. CI wiring (deploy.yml + Dockerfile + fly.toml)

- `deploy.yml`: add `schedule:` (daily, e.g. `0 9 * * *` UTC = 04:00
  Chicago) alongside push-to-`main`; the job gains a bake step before
  `flyctl deploy --remote-only` (`npm ci` → `npx tsx
  server/scripts/bake-static.ts`). These are file edits only — `flyctl`
  runs inside the Actions runner and the image builds on Fly's remote
  builder, so neither local `flyctl` nor Docker is ever needed; the
  workflow stays inert until the owner's Phase 8 secrets exist.
  `baked.db` rides the build context —
  make sure `.dockerignore` does not exclude it. Deploys now take ~30–40
  min (the bake's persist dominates) — acceptable for cron + merges. If
  the repo is private, watch Actions minutes (~40 min/day ≈ 1 200/mo of
  the 2 000 free); weekly cron is the fallback.
- Dockerfile: `COPY baked.db` mandatory — fail the build when missing, so a
  deploy without baking fails loudly instead of shipping a parse-capable
  runtime.
- fly.toml: env adds `BAKED_STATIC_DB=/app/baked.db` and
  `DECISION_INTERVAL_SECONDS=30`; keep `memory = "1gb"` (decision cadence is
  CPU-bound, not memory-bound — no memory change for the faster tick).

### Tests

- Baked-refresh helper with fixture DBs: baked newer → static tables
  replaced, `loadedAt` updated, engine-invalidation path invoked, volume
  `settings` untouched; volume newer → no-op; both stale → `staticStale`
  surfaced and no download attempted (mock the provider and assert).
- Tick split + focus: focus filters discovery, the persisted terminal
  list, and the engine's wanted set; a fact-only refresh records facts but
  writes no `run_events`/interventions, a decision refresh does both;
  empty focus keeps all routes (back-compat).

**Acceptance:** local boot with a newer `baked.db` copies the tables with
logged peak RSS well under 1 GB; fact ticks (~10 s) complete in seconds; a
full decision pass over the focused active terminals completes well inside
30 s without the interval warning; setting `focusRouteIds` at runtime
filters the menu and the engine without a restart; with no `baked.db` the
download path still works (local dev); lint/typecheck/test green.

## Phase 8 — First deploy (owner, via the Fly website)

The dev machine has neither `flyctl` nor Docker, and none are required: the
deploy workflow runs flyctl inside the GitHub Actions runner and builds
remotely on Fly's builder. The owner configures everything through the Fly
dashboard (CLI equivalents in parentheses; a one-time `flyctl` install —
`irm https://fly.io/install.ps1 | iex` — is optional, needed only if the
website cannot mint a deploy token).

Owner-only steps (account/billing — workers do not attempt these):

1. Create the Fly account, register a card (pay-as-you-go; spend capped by
   the 1 GB machine + free ≤10 GB volume).
2. Create the app (dashboard → create app): name `dispatch-pilot`, region
   `ord` — do **not** deploy from the dashboard; the first deploy comes
   from the release PR via GitHub Actions, which adopts the repo's
   `fly.toml` (port 8080, HTTPS forced, 1 GB machine, `/data` mount).
3. Create the volume **before** the first deploy (app → Volumes → new):
   name `data`, **10 GB** (the free-allowance maximum — $0; do not exceed
   10 GB, that is where billing starts), region `ord` — the `fly.toml`
   mount requires it (≥2 GB is the hard floor: the daily baked copy is one
   transaction and the WAL spikes to ~1.2 GB peak — see 7b).
   (`fly volumes create data --size 10 --region ord`.)
4. Set secrets (app → Secrets): `CTA_API_KEY=<from local .env>`,
   `AGENCY_TIMEZONE=America/Chicago`, `DISPATCH_TOKEN=<generated random>`.
   Never commit these; `.env` stays gitignored. (Optional:
   `FOCUS_ROUTES=9,79,…` seeds the route focus on the volume's first boot —
   otherwise set it after launch via `PUT /api/config`.)
5. Mint a deploy token (account → access tokens; CLI:
   `fly tokens create deploy -a dispatch-pilot`) → add it as the GitHub
   repo secret `FLY_API_TOKEN` (repo Settings → Secrets and variables →
   Actions).
6. Complete the Phase 6 owner tasks if not done: branch protection on
   `main` (PR + `ci` check, no direct push); keep the default branch as
   `main` (GitHub web UI — `gh` is not installed; a `dev` default would
   break the nightly cron, which runs from the default branch's
   workflow file).
7. Merge `dev` → `main` via PR → watch the Actions deploy run.

Verify (worker, ~15 min after deploy — all doable in a browser):

- The first deploy is also the **first image build** (no local Docker — see
  Phase 5): watch the remote-builder output in the GitHub Actions run log.
  On failure the fix is almost certainly in the Dockerfile (prod install
  with workspaces, runtime-stage file copies) — fix, merge into `dev`, and
  redeploy.
- `https://dispatch-pilot.fly.dev/api/health` → `ready` (expect ~2–3 min
  from deploy to ready: the baked copy runs synchronously at boot; the
  health check's 5 m grace period covers the window — a longer freeze
  means the copy is slow on shared-cpu, not that the app is down).
- Dashboard → Monitoring shows `[static] ready`, `[refresh] complete
  snapshots=N` with N > 0 even though nobody is watching (Phase 2 working).
- Browser: WS live-updates on a terminal view; token field in Settings
  unlocks apply/decline.
- `GET /api/terminals` reflects time-of-day: 104 Vincelles vs 95 Beverly at
  the appropriate clock times (spot-check morning vs midday).
- Restart the machine (dashboard → machine → restart): boots straight to
  `[static] reuse` — volume persistence confirmed.
- First deploy runs the CI bake step (~30–40 min total) and the logs show
  the baked refresh (`[static]` copy path, not a download/parse) — Phase 7
  working; `/api/health` shows no `staticStale`.
- Within `staticRefreshHours` + the check interval of runtime, the scheduled
  daily deploy keeps `/api/health` `staticStale` absent; if the cron breaks,
  `staticStale: true` is the signal.

## Phase 9 — T+24 h data review (the actual point)

After ~24 h of runtime, pull the data and confirm the two datasets:

```sql
-- Volume of each dataset (sanity: run_events ≈ distinct facts, NOT per-poll
-- rows; if it's growing by ~8k/day/terminal something started logging pings)
SELECT event_type, COUNT(*) FROM run_events GROUP BY 1;
SELECT status, COUNT(*) FROM interventions GROUP BY 1;
SELECT action, COUNT(*) FROM intervention_events GROUP BY 1;

-- Never-viewed terminals are logging (the fix from Phase 2):
SELECT terminal_id, COUNT(*) FROM run_events GROUP BY 1 ORDER BY 2 DESC;
SELECT terminal_id, COUNT(*) FROM interventions WHERE status != 'pending' OR
  id IN (SELECT intervention_id FROM intervention_events WHERE
  action NOT IN ('created','updated')) GROUP BY 1;

-- Decision context is machine-readable now:
SELECT json_extract(metadata_json,'$.backwardHeadwaySeconds'),
       json_extract(metadata_json,'$.forwardHeadwaySeconds'), hold_seconds
FROM intervention_events ie JOIN interventions i USING (intervention_id)
WHERE action = 'created' LIMIT 20;

-- Arrival punctuality by terminal/route (schedule adherence analysis):
SELECT terminal_id, route_id, COUNT(*),
       AVG(value_seconds - scheduled_arrival) AS avg_late_s
FROM run_events WHERE event_type='arrival' GROUP BY 1, 2;

-- Day-part scoping happens HERE, not at collection time: `value_seconds` is
-- seconds since service-day start, so a WHERE clause on it scopes any query
-- to dispatcher hours (e.g. AM peak, PM peak, midday base, owl) without the
-- engine ever gating collection. The un-held baseline across all hours is
-- the comparison the analysis needs.
```

(Pull the volume DB with a one-time `flyctl` install —
`irm https://fly.io/install.ps1 | iex`, `fly auth login`, then
`fly ssh sftp` — or add read-only JSON endpoints later, **not** in this
plan's scope. Dashboard Monitoring works in a browser for the log checks.)

Record findings in PROGRESS.md: row counts, refresh wall-time on the machine
(dashboard logs' `[refresh] complete` lines), any anomalies.

## Phase 10 — Post-launch performance fixes (first production-day findings)

Branch: `fix/post-launch-perf` → merge into `dev`, release to `main`.
**Owner requirement: the decision cadence stays at 30 s** (`DECISION_INTERVAL_SECONDS`
in `fly.toml` is back at 30; do not slow the tick — if passes outgrow it, report).

State: the interim health-check removal is deployed; `DECISION_INTERVAL_SECONDS`
is restored to 30 on `dev` with this phase. Shipped same-day on `dev` (the
worker continues from these starting points): the emergency liveness
watchdog (`server/src/watchdog.ts` + test, wired in `index.ts`,
`WATCHDOG_STALE_SECONDS`, default 180) is complete, and
`server/src/refreshLoop.ts` — the 10e loop module — is written but unwired
and untested; finishing it is 10e's work.

Found on the first production day: the decision pass is single-threaded SQLite
work measuring **~10–18 s per pass on shared-cpu-1x** (vs ~2–3 s on the dev
machine). While a pass runs, every concurrent request queues (`/api/terminals`
served in 12–20 s), and Fly's HTTP health check (5 s timeout) marked the
machine unhealthy, which **unrouted the app at the edge** — the intermittent
browser 503s. Interim mitigations already shipped: the health check removed
and `DECISION_INTERVAL_SECONDS=60` (now superseded — 30 s restored).

### 10a. Chunked decision pass

`server/src/index.ts` + `engine.ts`: run the decision pass in slices —
evaluate a bounded set of terminals, yield to the event loop
(`await setImmediate()` or a ~250 ms work budget per slice), repeat. A pass
may take the same wall time, but no request ever waits past a slice boundary.
Cadence semantics: the interval measures pass *ends*; skip a tick if the
previous pass is still running. Fact ticks are unchanged (sub-second).

### 10b. Memoize GET /api/terminals

The batched activity query measured 0.9–2.4 s per request in production, the
UI polls it every 60 s, and the response changes slowly — memoize the
computed response for ~30 s; invalidate on config change and static refresh.
Sub-second p95 thereafter, even during a pass.

### 10c. Re-add a tolerant health check

With 10a/10b in place: `[[http_service.checks]]` interval 10 s, timeout 25 s
(covers any residual slice stall), grace 1 m — and return
`DECISION_INTERVAL_SECONDS` to 30.

### 10e. Structural fix for the wedged tick loops (watchdog is the stopgap)

The 2026-10-08 production wedge: a refresh hung inside `provider.fetch()` past
the 15 s AbortController (the abort signal cannot interrupt a fetch stuck in
DNS/connect resolution), and because every tick coalesces onto the in-flight
promise (`runRefresh`) and each loop reschedules only in that promise's
`.finally`, one hung refresh froze both loops at zero CPU until a manual
restart. The emergency liveness watchdog (exits after `WATCHDOG_STALE_SECONDS`,
default 180, without a completed tick) shipped as the stopgap; this is the
structural fix:

- Reschedule the tick loops on unconditional timers rather than in the
  refresh promise's `.finally` — a hung promise can never stop a loop again.
- Race each refresh against a hard outer timeout (~25 s: above the fetch
  timeout, below the watchdog). A losing refresh is abandoned — clear
  `refreshInFlight` and write `lastRefreshAt` only through a generation guard,
  so a late-settling zombie cannot clobber live state.
- Keep the watchdog as belt-and-braces.

Tests: a never-settling refresh cannot stop the loop (the next tick still
runs); the abandoned generation never clears the new in-flight flag or updates
`lastRefreshAt`; the watchdog still fires if both layers somehow fail.

### 10d. Focus field in the Settings UI

`focusRouteIds` is runtime-editable but has no Settings-page field (found
post-launch: the owner had to hand-roll a GET/modify/PUT round-trip). Add a
comma-separated text field to `web/src/pages/ConfigPage.tsx` that edits it
like every other knob (string in, trimmed-split array out; render the
current list as `route1, route2`). Test: edit round-trips through
`PUT /api/config` and recomputes the terminal list with no restart.

### Tests

- Chunked pass: with a large active-terminal fixture, interleaved requests
  are served while the pass runs; pass output identical to the unchunked
  engine result; a slow pass skips the next tick rather than piling.
- Memoization: a second call within the window serves the cached body; a
  config change invalidates it.

**Acceptance:** in production, `/api/terminals` p95 < 1 s even during a
decision pass; no health-check flapping with the check re-added; 30 s decision
cadence restored.

## Phase 11 — Basic-auth gate over the whole site (post-launch)

Branch: `feat/site-auth-gate` → merge into `dev`, release to `main`. Owner
approved option 1 ("conceal everything with the token"): one gate in front
of the SPA, every `/api` route, and the WS handshake. Motivation: the pilot
lives on the public internet at a guessable URL (`dispatch-pilot.fly.dev`),
and today only mutations are gated — every read (schedules, recorded
arrivals/departures, recommendations) is public.

### 11a. Server gate middleware

A small module (e.g. `server/src/api/authGate.ts`) with the gate plus
unit-tested helpers, registered in `index.ts` after the `[http]` logging
middleware and BEFORE `createApi`, `express.static`, and the SPA fallback
route — so it covers every inbound path.

- `DISPATCH_TOKEN` unset → no-op (local dev unchanged; same rule as the
  mutating-route gate).
- Accepts EITHER:
  - `Authorization: Basic <b64(user:password)>` with password ===
    `DISPATCH_TOKEN` — any username; constant-time compare
    (`crypto.timingSafeEqual`), malformed header → 401; or
  - `x-dispatch-token: <DISPATCH_TOKEN>` — existing scripts (curl /
    PowerShell recipes) keep working unchanged.
- Failure → 401. Distinguish the two shapes:
  - non-`/api` paths (SPA, assets): include
    `WWW-Authenticate: Basic realm="dispatch"` so the browser shows its
    native prompt once and caches credentials for the session;
  - `/api` paths: plain `{"error":"authentication required"}` JSON, no
    `WWW-Authenticate` (fetch/XHR must not trigger browser dialogs).
- Exempt exactly one route: `GET /api/health` — Fly's health check probes
  it without credentials, and gating it would mark the machine unhealthy
  and unroute the app (the exact failure mode Phase 10 fixed). It exposes
  liveness/timing only; that trade is deliberate.

### 11b. WS handshake gate

`server/src/api/ws.ts`: express middleware never sees HTTP `upgrade`
events, so the identical check runs inside the ws upgrade handler — accept
the basic-auth header or a `?token=` query parameter; otherwise respond 401
and destroy the socket. Browsers attach cached basic credentials to
same-origin WS upgrades (primary path); the query param is the reliable
cross-browser fallback.

### 11c. Web client

- The WS connect URL appends `?token=` from localStorage when the dispatch
  token is set in Settings.
- A 401 from any API call surfaces a clear message ("Authentication
  required — refresh to log in, or set the dispatch token in Settings")
  instead of a generic error. Most users never see it: the browser's native
  prompt handles login.

### 11d. Docs

README access-control section + this plan's Decisions table: access is now
"basic-auth gate over everything except `GET /api/health`;
`x-dispatch-token` still accepted for scripts" — replacing "reads stay
open for easy testing".

### Tests

- Gate: no credentials → 401 on a GET API route, on `/` (SPA), and on an
  asset; correct basic password (any username) → 200; wrong password → 401;
  `x-dispatch-token` → 200; `DISPATCH_TOKEN` unset → everything open
  (back-compat; existing tests must keep passing unchanged).
- `GET /api/health` → 200 with and without credentials.
- WS: an upgrade without credentials → 401 and socket closed; with
  `?token=` (and separately with a basic header) → handshake completes
  (raw `http.request` upgrade against the test server).

### Acceptance

Locally with `DISPATCH_TOKEN` set: the browser prompts once, then the app
works end-to-end (pages, terminal views, WS live updates); curl without
credentials → 401; curl with `x-dispatch-token` → 200; `/api/health` open.
After release: same on the deployed site, and the Fly health check stays
green through a deploy boot.

### Notes / non-goals

- No brute-force throttling — the token is a long random string; revisit if
  logs show attempts.
- The app remains discoverable by name; auth is the barrier, not obscurity.
- No per-user accounts or identity — one shared token.

## Phase 12 — Fact fidelity fixes (boot fabrications + wrong-terminal layover)

Branch: `fix/fact-baseline-and-flip-geometry` → merge into `dev`, release to
`main`. Two owner-reported production quirks, both root-caused in code, plus
one related defect found while tracing.

**Quirk 1 — boot fabricates event times.** A bus already laying over at
boot gets an "arrival" stamped ~boot (STOPPED_AT at a terminal stop is
treated as an immediate observed arrival — `engine.ts` recordFacts,
~line 745); a bus mid-trip at boot gets a "departure" stamped ~boot (the
in-transit departure path, ~line 786). The same happens at the ~02:40
service-day rollover (ledger + vehicleTracks both clear). Owner's rule:
an unobserved transition is unknowable — leave it blank.

**Quirk 2 — wrong-terminal layover.** `buildDepartures` classifies a
vehicle as laying over at T when VP says its current trip is the outbound
trip from T (`onOutboundLeg`, `headway.ts:460`) — trip_id trusted with no
geometric check. CTA flips a vehicle's trip_id to its next trip while it
is still at the FAR terminal (the documented flip-window behavior); when
the flip lands on the outbound trip early, the bus renders as "laying
over" at T counting down to a departure a whole trip + layover away (the
"65 minutes" symptom).

**Related defect — cross-terminal ledger reads.** The ledger is keyed by
`trip_id`, but an outbound trip's ARRIVAL fact belongs to the terminal
where that trip ends (the far one). T reads it as "arrived here"
(`terminalArrival = record?.arrivalSeconds`, `headway.ts:443`; the
disjunct at `:466`) and `recordRunEvents` can write cross-terminal
arrival rows for short trips whose far-end arrival lands inside T's
30-minute past window.

### 12a. Session-baseline facts (quirk 1)

`engine.ts` recordFacts: the FIRST fresh observation of a vehicle in a
session (boot or service-day rollover — both clear vehicleTracks)
establishes its posture baseline only — no fact, arm, or confirmation
fires from it. From the second observation on, the existing logic runs
unchanged, making every recorded fact an observed transition by
construction. Effects: a bus already parked at boot keeps a blank
(unobserved) arrival — EDT falls back to schedule per the existing EDT
rule — and its later STOPPED→IN_TRANSIT transition still records a true
departure; a bus mid-trip at boot gets no fabricated departure.
Restored `run_facts` are unaffected (ledger already-recorded checks
still gate re-recording).

Tests (engine.test.ts, existing synthetic-fixture patterns): a first
observation of a vehicle already STOPPED_AT a terminal stop → no arrival
fact or run_event (blank), EDT = scheduled; a mid-trip first observation
→ no departure fact; the same vehicle's later live transitions record
normally (INCOMING_AT→STOPPED_AT arrival at the stop instant,
parked→motion departure); the geometric arm/confirm path still records
after its baseline; a service-date rollover re-baselines.

### 12b. Geometric corroboration for trip-flip layover (quirk 2)

`headway.ts` buildDepartures: `onOutboundLeg` contributes to
`arrivedAtTerminal` only when corroborated at THIS terminal — the vehicle
is in T's buffer (`terminalState.inBuffer` for the (vehicle, T) key) or
has a T-scoped posture for the trip. An ob-assigned vehicle elsewhere
falls through to the existing ambiguous-posture 'incoming' catch-all
(`headway.ts:474`): the card then shows the predecessor trip's predicted
arrival at T (honest: arrives ~X, departs ~Y), never a phantom layover.

Tests: VP carries the vehicle on the outbound trip while positioned at
the far terminal → state 'incoming' with the predecessor trip's ETA, not
layover; the same flip with the vehicle inside T's buffer → 'layover'
with the outbound EDT (existing behavior preserved).

### 12c. Terminal-scope the ledger's arrival/departure facts (hardening)

Add the terminal id to arrival/departure facts: the in-memory
`RunRecord` (headway.ts) gains arrival/departure terminal ids, persisted
via additive `run_facts` columns using the existing `ensureColumn`
migration pattern (schema.ts). Everywhere a fact is read *at* a terminal
— `buildDepartures`' `terminalArrival`/`arrivedAtTerminal`
(`headway.ts:443`, `:466`) and `recordRunEvents` — require the fact's
terminal to match. This closes the cross-terminal class for display and
for the run_events audit.

Tests: a short-trip block whose far-end arrival lands inside T's past
window → no arrival row at T for the outbound trip; facts recorded at
the correct terminal only.

**Acceptance:** boot the local server against the live feed mid-service:
no arrival/departure rows stamped within each vehicle's first
observation (spot-check `GET /api/run-events` before/after); the
"65-minute layover at the wrong terminal" class renders as incoming with
the predecessor ETA; all 212 existing tests green plus the new ones.

## Non-goals (explicitly out of scope — do not build)

- No vehicle-ping logging, no per-poll snapshot persistence, no feed-sample
  capture in production (the `data/*_capture_*.csv` files are local dev
  artifacts; the volume only carries `dispatch.db` + the cached GTFS zip).
- No auth beyond the Phase 11 basic-auth gate + the shared `DISPATCH_TOKEN`
  (no per-user accounts or identity; no brute-force throttling).
- No staging instance, no multi-machine, no Postgres, no Litestream backups
  (Fly snapshots volumes on deploy; revisit if the data becomes precious).
- No prebuilt-image registry split (GHCR) yet — the baked.db rides the
  deploy build context; revisit if deploys feel slow.
- No hold re-solving after apply; no co-located multi-route views (existing
  known limitations stand).
- No collection-time day-part windows (quiet overnight, peak-only, etc.):
  the machine bills flat whether the engine is idle or not, owl rows are few
  and filterable, and the un-held baseline across all hours is what the
  Phase 9 analysis compares against. Scope day-parts in the review queries
  instead (see Phase 9). Revisit only if cost or noise demands it — the
  lever then is Fly machine stop/start on cron schedules, not engine
  gating.
- No logging of config values or API keys beyond the existing redacted
  `config_events`.

## How to verify every phase (per `.agents/AGENTS.md`)

1. `npm run typecheck` — pass.
2. `npm run lint` — pass.
3. `npm test` — pass, including the new tests each phase requires.
4. `git status`/`git diff --cached` clean of scratch files, secrets, DBs.
