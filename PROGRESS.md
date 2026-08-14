# PROGRESS

Implementation plan and status. Check off items as they are completed. Update
this file (and the decisions log) after finishing any milestone.

## Status

- [x] Phase 0 — Repo scaffolding
- [x] Phase 1 — GTFS static ingestion
- [x] Phase 2 — GTFS-RT ingestion + provider abstraction
- [x] Phase 3 — Join engine (terminal + headway + interventions)
- [x] Phase 4 — API + WebSocket
- [x] Phase 5 — Web frontend
- [x] Phase 6 — Config UI + deployment polish
- [x] Phase 7 — Triplet dispatch refactor

---

## Phase 0 — Repo scaffolding

- [x] Monorepo layout: `server/`, `web/`, `shared/`, root `package.json`
      with npm workspaces or a single package with scripts.
- [x] Toolchain: TypeScript (strict), Vite (web), tsx (server dev), Vitest,
      ESLint. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`.
- [x] `shared/types.ts` — normalized DTOs: `Terminal`, `VehicleSnapshot`,
      `TripUpdateInfo`, `OutboundDeparture`, `IncomingBus`, `LayoverBus`,
      `Intervention`, `TerminalSnapshot`, `AppConfig`.
- [x] `.env.example` + `.gitignore` (ignore `.env`, `data/`, `dist/`,
      `node_modules/`).
- [x] `server/src/index.ts` skeleton: Express + `ws` + a `setInterval`
      refresh scheduler, health endpoint.

## Phase 1 — GTFS static ingestion

- [x] `server/src/gtfs/static.ts` — download + unzip GTFS, parse CSV
      (stops, routes, trips, stop_times, calendar, calendar_dates).
- [x] Time handling: auto-detect service-day start from stop_times
      (largest overnight gap in trip activity; fallback 03:00); convert
      `HH:MM:SS` (incl. `>24:00:00`) to "seconds since service-day start"
      integers; document wrap behavior.
- [x] `server/src/db/schema.ts` — create tables + indexes
      (`stop_times(stop_id)`, `stop_times(trip_id)`, `trips(route_id)`).
- [x] `server/src/db/staticLoader.ts` — load parsed CSV into SQLite;
      derive `block_trips(block_id, seq, trip_id, start_time, route_id)`.
- [x] Service-day resolution helper (calendar + calendar_dates -> active
      service_ids for a date).
- [x] Tests: synthetic GTFS fixtures -> loader round-trip.

## Phase 2 — GTFS-RT ingestion + provider abstraction

- [x] `server/src/providers/types.ts` — `RealtimeProvider` /
      `StaticProvider` interfaces + normalized realtime DTOs
      (vehicle position, per-stop predictions, trip delay).
- [x] `server/src/gtfs/realtime.ts` — poll feed URLs, decode
      `gtfs-realtime-bindings` protobuf for TripUpdates + VehiclePositions.
- [x] `server/src/providers/gtfsrt.ts` — default provider implementing
      `RealtimeProvider` (API key auth via query/header as CTA requires).
- [x] Tests: decode synthetic protobuf fixture -> normalized DTO.

## Phase 3 — Join engine

- [x] `server/src/engine/terminal.ts` — resolve a terminal: which trips
      depart/arrive at its `stop_id`s, per route (first/last stop detection).
- [x] `server/src/engine/headway.ts` — ordered outbound departures for a
      route/terminal in the lookahead window; assign vehicles via
      block trip chaining + realtime trip assignment; classify each as
      `layover` vs `incoming`; compute scheduled headway `H` per pair.
- [x] Predicted departure: from TripUpdate terminal stop prediction, else
      `max(predicted_arrival, now) + min_rest`.
- [x] `server/src/engine/interventions.ts` — unified headway rule using
      scheduled headway per pair: `P > gap_factor*H` -> hold leader;
      `P < bunch_factor*H` -> hold follower; plus gap alert + min-rest
      advisory. Emit `Intervention` DTOs with `hold_minutes`, `reason`,
      `expires_at`.
- [x] `server/src/engine/engine.ts` — orchestrates refresh -> normalized
      `TerminalSnapshot` for each configured terminal.
- [x] Tests: synthetic schedule + synthetic realtime fixtures for each rule
      (incl. lead-time window, max-hold cap, below-threshold no-op).

## Phase 4 — API + WebSocket

- [x] `server/src/config.ts` — load/save runtime config in SQLite
      `settings` table; zod validation; seed from env.
- [x] `server/src/api/routes.ts` — `/api/health`, `/api/terminals`,
      `/api/terminals/:id`, `/api/config` (GET/PUT).
- [x] `server/src/api/ws.ts` — broadcast snapshots on each refresh tick;
      client subscribe by terminal.
- [x] Wire refresh scheduler: on tick -> poll provider -> run engine ->
      persist snapshot -> WS broadcast.

## Phase 5 — Web frontend

- [x] `web/` Vite + React + TS, mobile-first layout.
- [x] `web/src/api.ts` — REST client + WS client with polling fallback.
- [x] `web/src/pages/Terminals.tsx` — terminal list grouped by route.
- [x] `web/src/pages/TerminalView.tsx` — incoming (ETA), layovers
      (scheduled departures + hold badges), interventions (action cards).
- [x] Layover countdown: `Countdown` component (min:sec to scheduled
      departure, green/amber/red states) + hold-override badge on held buses.
- [x] Components: `BusCard`, `InterventionCard`, `RouteGroup`,
      `Countdown`; `hooks/useStream.ts`.
- [x] Wire to `/api` + WS; last-updated + data-source status in header.

## Phase 6 — Config UI + deployment polish

- [x] Settings page for rule params + terminals curation + feed URLs/keys.
- [x] `npm run build && npm start` serving static bundle.
- [x] Deployment notes verified on Render/Fly/Railway (persistent disk,
      env config).
- [x] Optional: manual "reload static" trigger endpoint.

---

## Phase 7 — Triplet dispatch refactor (complete)

Replace the leader/follower + threshold rules with the triplet/EDT model. The
business logic must live **only** in `server/src/engine/dispatch.ts` (pure, no
I/O) so it can be reviewed and unit-tested in isolation.

### 7.1 Types + config
- [x] `shared/types.ts`: drop `gapFactor`/`bunchFactor`/`holdFraction` from
      `AppConfig` + `appConfigSchema`; simplify `HoldOverride` (drop `rule`);
      replace the `InterventionRule` union with `'hold'`; add
      `LayoverBus.terminalArrival`, `expectedDeparture`, `restDelayed`; drop
      `minRestAdvisory`.
- [x] `server/src/config.ts`: remove the three factors from defaults.
- [x] `server/src/api/routes.test.ts`: remove the three factors + the
      `gapFactor: 100` case.

### 7.2 Core logic (the reviewed artifact)
- [x] Create `server/src/engine/dispatch.ts` with pure functions:
      `expectedDepartureTime`, `holdSeconds`, `decideTriplets` (per
      IMPLEMENTATION §8.5).
- [x] Create `server/src/engine/dispatch.test.ts` (per IMPLEMENTATION §11).
- [x] Delete `server/src/engine/interventions.ts` + `interventions.test.ts`.

### 7.3 Engine plumbing
- [x] Add an in-memory run ledger to `engine.ts` (arrival/departure/hold facts
      keyed by `tripId`), carried across refreshes.
- [x] Rework `headway.ts`: compute terminal arrival (predicted inbound vs
      recorded layover) and EDT; classify `incoming|layover|departed`; sort by
      effective departure; expose EDT + effective departure to the core.
- [x] Wire `engine.ts` to call `decideTriplets`, attach locked holds, and emit
      a single `hold` intervention + `restDelayed`/`expectedDeparture` on
      layovers.
- [x] Rewrite `engine.test.ts` for the new model (worked example, propagation,
      boundaries, rest-delay, lock).

### 7.4 Web
- [x] `LayoverCard`: show `expectedDeparture`; struck-through scheduled + red
      EDT when `restDelayed`; countdown targets `predictedDeparture`.
- [x] `InterventionCard`: single `hold` case ("Hold <vehicle> until hh:mm").
- [x] `ConfigPage`: remove the three factor inputs.
- [x] `web/src/index.css`: drop `.gap_alert`/`.min_rest` styles; add rest-delay
      styling.

### 7.5 Verify
- [x] `npm run typecheck`, `npm run lint`, `npm test` all pass.
- [x] No remaining references to `gapFactor`/`bunchFactor`/`holdFraction`/
      `hold_leader`/`hold_follower`/`gap_alert`/`min_rest`/`minRestAdvisory`.

---

## Decisions log

- **2026-08-13 — Stack**: Node/TypeScript full stack (Express +
  better-sqlite3 + gtfs-realtime-bindings + ws; React + Vite). Single
  language, simple deployment to Render/Fly/Railway. Chosen over Python
  FastAPI.
- **2026-08-13 — Data source abstraction**: realtime/static access behind
  `RealtimeProvider`/`StaticProvider` interfaces so a proprietary database can
  be swapped in without touching engine/UI.
- **2026-08-13 — Storage**: SQLite via better-sqlite3 (sync, simple) for
  read-only static tables + `settings` key/value for runtime config.
- **2026-08-13 — Interventions**: four rules for v1 (hold leader = primary;
  hold follower anti-bunching; gap alert; min-rest advisory). Hold propagation
  across pairs computed independently for now.
- **2026-08-13 — Leader vs follower**: unified headway rule — hold leader when
  predicted headway > max_gap (gap); hold follower when < min_headway
  (bunching). Leader hold = split follower lateness; follower hold = restore
  min spacing.
- **2026-08-13 — Gap/bunch thresholds**: relative to scheduled headway
  (`gap_factor` 1.5x, `bunch_factor` 0.5x) rather than absolute minutes, so
  they scale with route and time of day; `max_hold_minutes` remains the
  absolute cap.
- **2026-08-13 — Service-day start**: auto-detected from GTFS stop_times
  (largest overnight gap in trip activity) rather than a fixed/configurable
  hour; fallback to 03:00 for 24h operation.
- **2026-08-13 — Countdown**: layover countdown targets scheduled departure;
  holds shown as an override badge, not baked into the countdown.
- **2026-08-13 — Terminals**: auto-discovered from GTFS first/last stop; manual
  curation via config for co-located multi-stop terminals.
- **2026-08-13 — Predicted departure (layover)**: `max(scheduledDeparture,
  max(predictedArrival, nowSvc) + minRest)` so a bus never departs before its
  scheduled time; spec §8.3's `max(arrival, now) + minRest` is the earliest-
  permissible case and is a lower bound. Holds are attached as badges and
  never feed back into pair math (independent holds per §8.4).
- **2026-08-13 — min_rest interpretation**: advisory fires when the *scheduled*
  departure would leave less than `min_rest` after the predicted arrival
  (`scheduledDeparture - predictedArrival < minRestMinutes*60`). Using the
  rest-adjusted predicted departure alone would never trip (it embeds min_rest
  by construction); the scheduled comparison is the only reachable reading of
  README rule 4.
- **2026-08-13 — Incoming buses**: derived from outbound departures (a bus is
  "incoming" when its block's previous trip is inbound with a future arrival),
  per §8.2. Buses whose next outbound trip falls outside the lookahead window
  are not listed — a v1 limitation.
- **2026-08-13 — Timezone**: wall-clock "now" (service-day mapping, unix→svc)
  uses the server's local timezone. CTA's agency timezone is America/Chicago;
  deploy with matching TZ or set TZ for the process.
- **2026-08-13 — Native deps**: better-sqlite3 pinned to ^12 (no Node 25
  prebuilds on v11). Install requires `NODE_TLS_REJECT_UNAUTHORIZED=0` in this
  environment (MITM proxy cert; see notes below).
- **2026-08-13 — Protobuf decode**: `gtfs-realtime-bindings` decodes absent
  optional scalars to 0. Delay fields keep 0 (on-time); absolute `time` fields
  treat 0 as absent (never a real POSIX timestamp). Lat/lon are 32-bit floats
  (small precision loss).
- **2026-08-14 — Triplet dispatch model**: replace leader/follower pair rules
  with a single triplet rule. The decision subject is the middle bus; hold =
  `min(max((H_b - H_f)/2, 0), max_hold)`, where `H_b` = gap to the follower
  (behind) and `H_f` = gap to the leader (ahead). `gap_alert` and the min-rest
  intervention are dropped.
- **2026-08-14 — Expected departure time (EDT)**: the core of every decision.
  `EDT = max(scheduledDeparture, terminalArrival + minRest)`. Requires recording
  terminal arrival (and actual departure for departed leaders).
- **2026-08-14 — Record arrivals/departures**: in-memory run ledger keyed by
  `tripId`; resets on restart (pilot limitation; SQLite persistence later).
- **2026-08-14 — Lock holds at decision time**: once a hold is issued within
  the lead window (measured from EDT, not scheduled), freeze `{ holdSeconds,
  until }` until the bus departs; no re-derivation. Holds propagate
  left-to-right via the locked `until`.
- **2026-08-14 — Rest-delay in UI**: when `EDT > scheduled` (late arrival +
  rest), show the scheduled time struck through with the EDT in red; no
  separate advisory.
- **2026-08-14 — Config simplification**: removed `gapFactor`, `bunchFactor`,
  `holdFraction` (unused by the new formula). Keep `minRestMinutes`,
  `maxHoldMinutes`, `leadTimeMinutes`, `lookaheadMinutes`.
- **2026-08-14 — On-demand refresh (complete)**: replaced the full-scan refresh
  (all 258 terminals every tick, ~10s of sync DB work blocking the event loop)
  with subscribe-based on-demand refresh: a global GTFS-RT fetch loop + per-tick
  compute of only subscribed terminals. Cost scales with open views, not total
  terminals. WS clients send `subscribe`/`unsubscribe`; `GET /terminals/:id`
  computes on demand.
- **2026-08-14 — Block chains are static**: `block_trips(block_id, seq,
  trip_id, …)` already stores the trip chain at GTFS load; the next/prev lookup
  maps must not be rebuilt per refresh. Cached in the Engine (with a static
  `trip_ends` first/last-stop index), invalidated on static reload.
- **2026-08-14 — Global fact pass**: arrival/departure facts for the run ledger
  are recorded every tick for all terminals (not just viewed ones) by joining
  the TripUpdates feed against the static `trip_ends` + block-chain index — no
  per-trip DB queries. This keeps "recently departed" correct even for
  terminals never viewed.
- **2026-08-14 — Drop VehiclePositions**: the vehicle-position verification
  layer (300m geofence layover confirm/drop, stopSequence departure fallback,
  vehicle→trip assignment) is removed; the engine relies solely on TripUpdates.
  Simplifies to "predicted arrival has passed → layover". Also drops one feed
  fetch/decode, the `layoverProximityMeters` config, and the `CTA_VP_URL` env.
- **2026-08-14 — WAL checkpoint**: `PRAGMA wal_checkpoint(TRUNCATE)` after
  static load and on boot. A 635MB uncheckpointed WAL left behind by a killed
  process was making every DB query ~2.4x slower (full scan 10.1s → 4.25s).
- **2026-08-14 — Departure detection (TripUpdates only)**: CTA's TripUpdates
  feed omits stops a vehicle has already served. So "departed" = the terminal
  (first) stop is absent from the trip update, or its departure time is in the
  past; a future departure time is a *prediction*, so the bus is still laying
  over. Fixes the inversion where laying-over buses showed as "recently
  departed" (with future times) and departed buses showed as "laying over".
- **2026-08-14 — VehiclePositions as fact source (partial revert)**:
  TripUpdates-only fact recording was inaccurate for arrivals: CTA drops the
  last stop once served, so arrivals were never recorded for buses already in
  layover; and the recorded value was a smoothed prediction, not an
  observation. VP is now the primary source for arrival/departure *facts*:
  a vehicle on trip T observed at T's last stop (stopId or stopSequence)
  records arrival for `nextTrip(T)` at the VP timestamp (clamped to now);
  sequence/stopId advancing past T's first stop (or a tripId flip) records
  T's departure. TU heuristics remain as fallback and TU is still the source
  for *predictions* (incoming ETA). Priority: VP overrides TU, never the
  reverse; first-write-wins within each source (`RunRecord.arrivalSource`/
  `departureSource`). VP fetch is parallel to TU; `CTA_VP_URL` env +
  `realtime.vehiclePositionsUrl` config (backfilled for saved configs).

- **2026-08-14 — Bus-only static load**: `loadStatic` filters GTFS to
  `route_type = 3` (bus) and cascades: rail routes → their trips → their
  stop_times → now-unused stops. CTA rail (type 1) never enters SQLite, so
  terminal discovery and engine queries are bus-only. Existing DBs pick this
  up on the next static reload.
- **2026-08-14 — Terminal card polish**: destinations come from the trip's
  last stop name (extended `trip_ends` with a `stops` join) instead of the
  headsign, which was unreliable. Layover cards now show recorded vs scheduled
  terminal arrival (red when late) and expected vs scheduled departure; inbound
  cards dropped the countdown in favor of scheduled vs estimated arrival (red
  when late); recently-departed cards show actual vs scheduled departure,
  purple when the trip left under a locked hold (`DepartedBus.held`), plus the
  vehicle's current stop resolved from VP (`stopId`, else `tripId` +
  `currentStopSequence` → stop_times). Stop names are cached in the engine
  (`stopNamesCache`, invalidated on static reload).
- **2026-08-14 — Route badges + sorted home**: routes carry GTFS
  `route_color`/`route_text_color` end-to-end (parse → `routes.color`/
  `text_color` → `RouteState`/terminals API → `RouteBadge` component). Route
  headers (home + terminal view) render a colored badge with the route number
  plus the long name; the inbound "Next trip" line uses a mini badge. `routes`
  gains `color`/`text_color` columns (migration adds them to existing DBs).
  `GET /api/terminals` now sorts routes numeric-aware by short name.

## Build notes

- `better-sqlite3` v11 has no prebuilds for Node 25 and node-gyp's header
  download is blocked by a local proxy cert. Bumped to ^12 and installed with
  `NODE_TLS_REJECT_UNAUTHORIZED=0`. Verify before deploying to a fresh host.

## Next steps

1. Implement Phase 7 (triplet dispatch refactor) — hand off to a worker agent;
   see the checklist above plus IMPLEMENTATION.md §8.5 and README "How dispatch
   decisions work".
2. Seed a real CTA API key + run `npm run dev` against live feeds.
3. Optional: expose `vehiclePosition.stopId`-based ETA (currently delay-based).
4. Optional: persist the run ledger to SQLite so arrival/departure facts survive
   restarts.
5. Optional: re-lock a hold only when the recomputed value drifts beyond a small
   threshold (e.g. 1 min) before departure.
6. Optional: co-located multi-route terminal view in the UI.
7. **Known gap (on-demand refresh)**: arrival facts for a bus that never appears
   in TripUpdates (no realtime data) are not locked into the ledger; such a bus's
   EDT falls back to scheduled. "Recently departed" is now recorded globally and
   is correct for all terminals. Minor: persists ledger to SQLite to survive
   restarts (see next step 4).
