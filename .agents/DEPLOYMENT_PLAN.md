# Deployment Plan — Dispatch Pilot

Status: approved plan, ready for execution. Decisions are final; do not
re-litigate them without the owner. Work phase by phase in order; each phase
lands as its own PR (see "Git flow"). Update PROGRESS.md after each phase.

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
| Host | Fly.io, single app, `ord` region, 512 MB machine, 1 GB volume (first 10 GB free) |
| Environments | One production instance only; `dev` branch runs CI, does not deploy |
| Deploy trigger | Push to `main` (merged PR) → CI → auto `fly deploy` |
| Access control | Optional `DISPATCH_TOKEN` env: mutating routes require `x-dispatch-token`; all reads stay open |
| Cost target | ~$2–4/month total |

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
  `chore/github-ci`), PR into `dev`.
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
  - Remote (Phase 7): Fly's remote builder performs the actual first image
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
persistence, and `[static] reuse` are verified at first deploy (Phase 7).

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
- Secrets: `FLY_API_TOKEN` (repo secret, created by owner — see Phase 7).
- `concurrency: group: deploy, cancel-in-progress: false` (serialize deploys).
- Deploy does **not** rerun tests — it is gated on the same commit's CI via
  branch protection on `main` (require `ci` check before merge). Note this in
  the workflow file comment.

### Branch protection (owner task — needs GitHub web UI or `gh`; `gh` is not
installed on the dev machine)

- `main`: require PR, require status check `ci` (lint/typecheck/test job),
  no force push, no direct push. `dev`: same minus "require PR" is optional —
  keep identical to keep the main line uniform.
- Set default branch to `dev` (new PRs target `dev` automatically).

**Acceptance:** a PR into `dev` shows CI checks and blocks merge on failure;
a merged PR `dev`→`main` auto-deploys (verify after Phase 7).

## Phase 7 — First deploy (owner-assisted)

Owner-only steps (account/billing/secrets — do not attempt these without the
owner): create the Fly account, register a card (pay-as-you-go; total spend
capped by the 512 MB + 1 GB volume sizing), then:

1. `fly auth login`, `fly launch --no-deploy --name dispatch-pilot --region
   ord` (adopts the repo's `fly.toml` + Dockerfile).
2. `fly volumes create data --size 1 --region ord`.
3. `fly secrets set CTA_API_KEY=<from local .env>
   AGENCY_TIMEZONE=America/Chicago DISPATCH_TOKEN=<generated random>` —
   never commit these; `.env` is already gitignored and stays that way.
4. `fly tokens create deploy -a dispatch-pilot` → add as GitHub repo secret
   `FLY_API_TOKEN`.
5. Merge `dev` → `main` via PR → watch the deploy workflow.

Verify (worker, ~15 min after deploy):

- The first deploy is also the **first image build** (no local Docker — see
  Phase 5): watch the remote-builder output (in the deploy workflow log or
  `fly deploy` stream). On failure the fix is almost certainly in the
  Dockerfile (prod install with workspaces, runtime-stage file copies) —
  fix, PR into `dev`, and redeploy.
- `https://dispatch-pilot.fly.dev/api/health` → `ready`.
- `fly logs` shows `[static] ready`, `[refresh] complete snapshots=N` with
  N > 0 even though nobody is watching (Phase 2 working).
- Browser: WS live-updates on a terminal view; token field in Settings
  unlocks apply/decline.
- `GET /api/terminals` reflects time-of-day: 104 Vincelles vs 95 Beverly at
  the appropriate clock times (spot-check morning vs midday).
- Restart the machine (`fly machine restart`): boots straight to `[static]
  reuse` — volume persistence confirmed.
- Within `staticRefreshHours` + the check interval of runtime, `fly logs`
  shows a scheduled `[static] load` with a fresh download (not `reuse`) —
  Phase 3 working on the always-on machine.

## Phase 8 — T+24 h data review (the actual point)

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
```

(`sqlite3` CLI via `fly ssh console`, or copy `data/dispatch.db` out with
`fly ssh sftp`. Alternatively add read-only JSON endpoints later — **not** in
this plan's scope.)

Record findings in PROGRESS.md: row counts, refresh wall-time on the machine
(`fly logs` `[refresh] complete` lines), any anomalies.

## Non-goals (explicitly out of scope — do not build)

- No vehicle-ping logging, no per-poll snapshot persistence, no feed-sample
  capture in production (the `data/*_capture_*.csv` files are local dev
  artifacts; the volume only carries `dispatch.db` + the cached GTFS zip).
- No auth beyond the mutating-route token; reads stay public for easy
  testing.
- No staging instance, no multi-machine, no Postgres, no Litestream backups
  (Fly snapshots volumes on deploy; revisit if the data becomes precious).
- No hold re-solving after apply; no co-located multi-route views (existing
  known limitations stand).
- No logging of config values or API keys beyond the existing redacted
  `config_events`.

## How to verify every phase (per `.agents/AGENTS.md`)

1. `npm run typecheck` — pass.
2. `npm run lint` — pass.
3. `npm test` — pass, including the new tests each phase requires.
4. `git status`/`git diff --cached` clean of scratch files, secrets, DBs.
