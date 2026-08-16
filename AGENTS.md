# AGENTS.md

Instructions for coding agents working in this repository.

## Project overview

A mobile-friendly web app for a bus dispatching pilot at bus terminals. It
joins GTFS static (schedule) with GTFS-Realtime (vehicle positions + trip
updates) to detect when buses are off-schedule, then recommends simple hold
interventions so a manager can tell an operator to hold their bus and smooth
headways.

Primary intervention: recommend holding the middle bus in a triplet of
outbound departures for up to the configured maximum, so adjacent headways are
more even.

## Commands

Run from repo root.

```bash
npm install        # install all deps (server + web)
npm run dev        # run server + web concurrently (Vite + tsx watch)
npm run build      # typecheck + build web + build server
npm run lint       # eslint
npm run typecheck  # tsc --noEmit across server + web
npm test           # vitest
```

## Git hygiene

- Before making changes, run `git status --short --branch`, inspect the current
  branch, and check recent history with `git log --oneline -10`.
- Do not work directly on `main` or `master` for feature or fix work. Start
  from the repository's integration branch when one exists, then create a
  focused branch such as `feat/persistent-intervention-queue`.
- Do not assume an integration branch exists locally. Inspect
  `git branch --all` and `git remote -v`; if no suitable branch exists, do not
  create or switch branches without the owner's direction.
- Preserve pre-existing worktree and index changes. Never use destructive
  commands such as `git reset --hard` or `git checkout --` to discard them.
- Keep each branch focused. Do not mix unrelated cleanup, generated files,
  secrets, local databases, or environment files into a feature change.
- Before committing, inspect `git status`, `git diff`, `git diff --cached`, and
  `git log --oneline -10`; stage only the intended files and verify no secrets
  are included.
- Use concise, imperative commit messages that match the repository history.
  Do not amend commits or force-push unless explicitly requested.
- Do not commit, push, merge, or create a pull request unless explicitly
  requested. Report the recommended branch and base when work is ready.

## Environment

Copy `.env.example` to `.env` and fill in. Keys used at runtime:

```env
PORT=8080
CTA_STATIC_URL=https://www.transitchicago.com/downloads/sch_data/google_transit.zip
CTA_VP_URL=https://transitdata.transitchicago.com/GtfsRealtime/VehiclePositions.pb
CTA_TU_URL=https://transitdata.transitchicago.com/GtfsRealtime/TripUpdates.pb
CTA_API_KEY=          # required; put your key in .env (gitignored)
DB_PATH=./data/dispatch.db
STATIC_GTFS_PATH=./data/gtfs.zip   # cached download
```

See README.md for the full list of config values (most are editable at runtime
via `PUT /api/config` and persisted in SQLite).

## Architecture

```
server/                     # Node + TypeScript backend
  src/
    index.ts                # entry: express + ws + refresh scheduler
    config.ts               # load/save runtime config (SQLite settings table)
    db/
      schema.ts             # SQLite schema + indexes
      staticLoader.ts       # GTFS static CSV -> SQLite tables
      interventions.ts      # persistent intervention queue + audit events
    gtfs/
      static.ts             # parse GTFS zip/CSV
      time.ts               # service-day detection + time normalization
      realtime.ts           # poll + decode GTFS-RT protobuf (gtfs-realtime-bindings)
    providers/
      types.ts              # RealtimeProvider / StaticProvider interfaces + normalized DTOs
      gtfsrt.ts             # default GTFS-RT provider implementation
    engine/
      terminal.ts           # terminal resolution: incoming vs layover buses
      headway.ts            # ordered outbound departures + terminal arrival/EDT inputs
      dispatch.ts           # CORE dispatch logic: EDT + triplet headway hold (single source of truth)
      engine.ts             # orchestrates refresh + run ledger -> normalized snapshot
    api/
    routes.ts             # REST endpoints
      ws.ts                 # websocket broadcast of snapshots
web/                        # React + Vite frontend (mobile-first)
  src/
    main.tsx / App.tsx
    api.ts                  # fetch + WS client
    pages/Terminals.tsx     # terminal list, grouped by route
    pages/TerminalView.tsx  # incoming, layovers, interventions
    components/             # BusCard, InterventionCard, RouteGroup, Countdown, ...
    hooks/useStream.ts
shared/
  types.ts                  # types shared by server + web
```

## Conventions

- TypeScript strict mode. No `any` except at provider boundaries (already
  normalized into `shared/types.ts` DTOs).
- Comment all non-trivial work. Add module/function comments and focused inline
  comments that explain business rules, data-source assumptions, persistence
  boundaries, state transitions, performance safeguards, and other reasoning a
  maintainer would not recover from the code alone.
- Do not write comments that merely restate a variable assignment or obvious
  control flow. Keep comments adjacent to the code they explain and update or
  remove stale comments when behavior changes.
- Validate external input with `zod` (config + API bodies).
- Times: internally store "seconds since service-day start" as integers; the
  start is auto-detected from stop_times (overnight lull). GTFS allows
  `24:00:00`+ which wraps to next day. See `gtfs/time.ts`.
- Prefer `better-sqlite3` (sync, simple) for the read-only static tables.
- Keep the `RealtimeProvider` interface clean so a proprietary data source can
  be swapped in later (see README "Data source abstraction").

## Data model (SQLite)

Static (loaded from GTFS, read-only):
- `stops(stop_id, stop_code, stop_name, parent_station, lat, lon)`
- `routes(route_id, agency_id, short_name, long_name, type, color, text_color)` — `color`/`text_color` are GTFS 6-digit hex, used for the route badge
- `trips(trip_id, route_id, service_id, block_id, direction_id, headsign)`
- `stop_times(trip_id, stop_sequence, stop_id, arrival_time, departure_time, pickup_type, drop_off_type)` — indexed on `stop_id` and `trip_id`
- `calendar(service_id, monday..sunday, start_date, end_date)`
- `calendar_dates(service_id, date, exception_type)`
- `block_trips(block_id, seq, trip_id, start_time, route_id, service_id)` — active-service-aware trip chains per block

Config (runtime, editable):
- `settings(key TEXT PRIMARY KEY, value_json TEXT)`

Operational:
- `interventions` — persistent recommendation state and applied holds
- `intervention_events` — append-only intervention interaction audit log
- `config_events` — append-only configuration audit log
- `run_facts` — persisted observed arrival/departure facts by service date

Diagnostics:
- `GET /api/diagnostics/vp` reports the latest VP observations, transition
  candidates, recorded fact events, and feed freshness/errors without mutating
  dispatch state.

## How to verify your work

1. `npm run typecheck` must pass.
2. `npm run lint` must pass.
3. `npm test` must pass.
4. For engine logic, add unit tests under `server/src/engine/*.test.ts` using
   synthetic GTFS fixtures (small hand-written trips/stop_times).

## Context files

- `README.md` — product overview, architecture, configuration, deployment.
- `IMPLEMENTATION.md` — detailed build spec (types, schema, engine algorithm,
  API/WS contract, testing, definition of done). Source of truth for builders.
- `PROGRESS.md` — implementation plan, task status, decisions log. Update it
  after completing any milestone or making a significant decision.
