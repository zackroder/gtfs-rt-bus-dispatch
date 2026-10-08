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
- [x] Phase 8 — Persistent intervention queue and fact integrity
- [x] Phase 9 — Vehicle detail card + block strip

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

> Note: the headway-pair rule described in this phase was **superseded by the
> triplet/EDT model (Phase 7)**. The current dispatch rule is the middle-bus
> even-headway hold in `dispatch.ts`; see Phase 7 below.

- [x] `server/src/engine/terminal.ts` — resolve a terminal: which trips
      depart/arrive at its `stop_id`s, per route (first/last stop detection).
- [x] `server/src/engine/headway.ts` — ordered outbound departures for a
      route/terminal in the lookahead window; assign vehicles via
      block trip chaining + realtime trip assignment; classify each as
      `layover` vs `incoming`; compute scheduled headway `H` per pair.
      *(Superseded: EDT + triplet hold replaced pair-headway math.)*
- [x] Predicted departure: from TripUpdate terminal stop prediction, else
      `max(predicted_arrival, now) + min_rest`.
- [x] `server/src/engine/interventions.ts` — unified headway rule using
      scheduled headway per pair: `P > gap_factor*H` -> hold leader;
      `P < bunch_factor*H` -> hold follower; plus gap alert + min-rest
      advisory. Emit `Intervention` DTOs with `hold_minutes`, `reason`,
      `expires_at`. *(Superseded: file removed in Phase 7; the gap/bunch
      factors no longer exist.)*
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
- [x] Wire `engine.ts` to call `decideTriplets`, emit persistent pending
      suggestions, and attach only applied holds + `restDelayed`/
      `expectedDeparture` on layovers.
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

## Phase 8 — Persistent intervention queue and fact integrity (complete)

- [x] Persist pending/applied/declined/canceled/expired/completed intervention
      state in SQLite.
- [x] Persist append-only view and transition events, including actor and
      request identifiers.
- [x] Require explicit approval before a hold affects dispatch calculations.
- [x] Use VehiclePositions only for recorded arrival/departure facts; retain
      TripUpdates for predictions and assignment.
- [x] Round holds to 30-second increments and suppress holds below one minute.
- [x] Add intervention REST actions, filtered WebSocket updates, and UI action
      controls.
- [x] Scope ledger/block chains by service date and serialize refreshes.
- [x] Persist observed run facts by service date and restore them on restart.
- [x] Add realtime request timeouts, stale snapshot cleanup, response schemas,
      and shared countdown timing.

---

## Phase 9 — Vehicle detail card + block strip (complete)

Selecting any bus card in a terminal view opens a read-only panel: a mini map
with the vehicle's live arrow and its upcoming stop dots, the upcoming-stops
list, and the run's block strip. Implemented per `.agents/FEATURE_VEHICLE_CARD.md`;
both projections are read-only over `latestRt` + the snapshot caches (never a
feed fetch, never `engine.refresh`).

### 9.1 Server
- [x] Shared DTOs + zod schemas: `VehicleDetail`, `UpcomingStop`, `PassedStop`,
      `BlockTimeline`, `BlockTrip` (`shared/types.ts`).
- [x] Extract `buildTripToVehicle`/`resolveVehicleForTrip` in `headway.ts` so
      `buildDepartures` and the card resolve the vehicle identically (TU
      assignment, else block predecessor, else VP tripId inversion).
- [x] New `server/src/engine/vehicleDetail.ts`: pure `buildVehicleDetail` +
      `buildBlockTimeline` (TU prediction window authority for upcoming stops,
      schedule-clock fallback with 120 s grace, 8-stop cap, passed dots,
      deterministic direction shading data, service-date-scoped block chains).
- [x] Thin `Engine.vehicleDetail` / `Engine.blockTimeline` wrappers using the
      existing caches (`tripEnds`, `blockChains`, `stopNames`, `stopCoords`,
      `routeStyles`, ledger) with the same discipline as `buildMapSnapshot`.
- [x] Endpoints `GET /api/terminals/:id/vehicles/:tripId` and
      `GET /api/blocks/:blockId` with zod boundary validation and 404s.

### 9.2 Web
- [x] `web/src/routeColor.ts` (`normalizeGtfsColor`, `relativeLuma`,
      `readableOn`, `shadeForDirection`); `RouteBadge` refactored to use it.
- [x] Shared rotated-SVG arrow (`web/src/components/VehicleArrow.ts`) extracted
      from `TerminalMap` and reused by the mini map.
- [x] Card selection in `TerminalView` (BusCard uses `nextTripId`, layover/
      departed use `tripId`); detail panel polls every 10 s and fetches the
      block strip once per selection. *(Presentation follow-up 2026-09-04: the
      panel renders as a bottom-sheet overlay with a click-to-close backdrop,
      not inline under the route group, so the selected run stays prominent.)*
- [x] `BlockStrip`: pure SVG with a prominent route number, direction shading,
      text contrast on the final shaded background, "now" line, and departure ticks.
      *(Superseded 2026-09-08 by the vertical `BlockList` manifest — see the
      "Block manifest replaces the strip" decision entry.)*

### 9.3 Verify
- [x] Engine unit tests (TU window with absolute times, mixed sources, current
      stop excluded, schedule fallback, 8-stop cap, unmatched/no-vehicle trips).
- [x] Block strip builder tests (ordering, state windows, departure fact + held
      propagation, unknown block).
- [x] API contract tests in `routes.test.ts` (200 + zod-valid bodies, 404s).
- [x] Color util unit tests (`shadeForDirection`, `readableOn`, `#`-less input).
- [x] `npm run typecheck`, `npm run lint`, `npm test` green, including a full
      suite run under `TZ=America/New_York`.

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
  across pairs computed independently for now. *(Superseded 2026-08-14 by the
  single triplet hold rule — see the "Triplet dispatch model" entry below.)*
- **2026-08-13 — Leader vs follower**: unified headway rule — hold leader when
  predicted headway > max_gap (gap); hold follower when < min_headway
  (bunching). Leader hold = split follower lateness; follower hold = restore
  min spacing. *(Superseded 2026-08-14 by the triplet model; there is no
  leader/follower pair rule anymore.)*
- **2026-08-13 — Gap/bunch thresholds**: relative to scheduled headway
  (`gap_factor` 1.5x, `bunch_factor` 0.5x) rather than absolute minutes, so
  they scale with route and time of day; `max_hold_minutes` remains the
  absolute cap. *(Superseded 2026-08-14: `gap_factor`/`bunch_factor` removed;
  the hold formula is now `min(max((H_b - H_f)/2, 0), max_hold)` around the
  middle bus.)*
- **2026-08-13 — Service-day start**: auto-detected from GTFS stop_times
  (largest overnight gap in trip activity) rather than a fixed/configurable
  hour; fallback to 03:00 for 24h operation.
- **2026-08-13 — Countdown**: layover countdown targets scheduled departure;
  holds shown as an override badge, not baked into the countdown.
  *(Superseded 2026-08-14: the countdown now targets the effective departure —
  the locked hold `until` when held, else EDT.)*
- **2026-08-13 — Terminals**: auto-discovered from GTFS first/last stop; manual
  curation via config for co-located multi-stop terminals.
- **2026-08-13 — Predicted departure (layover)**: `max(scheduledDeparture,
  max(predictedArrival, nowSvc) + minRest)` so a bus never departs before its
  scheduled time; spec §8.3's `max(arrival, now) + minRest` is the earliest-
  permissible case and is a lower bound. Holds are attached as badges and
  never feed back into pair math (independent holds per §8.4).
  *(Last sentence superseded 2026-08-14: an applied hold's `until` becomes the
  bus's effective departure and propagates left-to-right; see "Applied holds
  are locked".)*
- **2026-08-13 — min_rest interpretation**: advisory fires when the *scheduled*
  departure would leave less than `min_rest` after the predicted arrival
  (`scheduledDeparture - predictedArrival < minRestMinutes*60`). Using the
  rest-adjusted predicted departure alone would never trip (it embeds min_rest
  by construction); the scheduled comparison is the only reachable reading of
  README rule 4. *(Superseded 2026-08-14: the min-rest advisory was dropped with
  the four-rule model; min rest is now expressed only through EDT.)*
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
- **2026-08-14 — Applied holds are locked**: a generated suggestion is pending
  until explicitly applied. Once applied within the lead window, freeze
  `{ holdSeconds, until }` until the bus departs; no re-derivation. Holds
  propagate left-to-right via the locked `until`.
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
- **2026-08-14 — Global VP fact pass**: VehiclePositions record arrival and
  departure facts every tick for all terminals (not just viewed ones) by
  joining VP trip IDs against the static `trip_ends` + active block-chain index.
  TripUpdates remain predictions and are never promoted to recorded facts.
- **2026-08-14 — WAL checkpoint**: `PRAGMA wal_checkpoint(TRUNCATE)` after
  static load and on boot. A 635MB uncheckpointed WAL left behind by a killed
  process was making every DB query ~2.4x slower (full scan 10.1s → 4.25s).
- **2026-08-14 — VehiclePositions as sole fact source**: TripUpdates-only fact
  recording was inaccurate for arrivals because CTA drops the last stop once
  served, and the recorded value was a smoothed prediction rather than an
  observation. VP records arrival/departure *facts*:
  a vehicle on trip T observed at T's last stop (stopId or stopSequence)
  records arrival for `nextTrip(T)` at the VP timestamp (clamped to now);
  sequence/stopId advancing past T's first stop (or a tripId flip) records
  T's departure. TU remains the source for *predictions* (incoming ETA). VP
  fetch is parallel to TU; `CTA_VP_URL` env +
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
- **2026-08-16 — Geometry-based run facts (arrival/layover/departure)**: live CTA
  feed analysis (see `.agents/FEED_ANALYSIS.md`) showed the existing transition paths
  cannot fire on CTA: VP carries `stop_id` only ~8% of the time and never
  `current_stop_sequence`; TU carries no timing fields at all (0/6115 entities);
  `current_status` is always `IN_TRANSIT_TO`. The engine's stop-matched
  `at_last_stop`/`past_first_stop` and the TU "known arrival" path were starved,
  which is why buses stalled in `incoming`. Replaced with a **per-vehicle
  geometric tracker**: arrival arms when a bus is parked (stationary within the
  terminal buffer) — first parked ping timestamps the fact, `confirm_pings`
  consecutive parked pings commit it, and the VP trip flip upgrades/confirms;
  departure is recorded when a laid-over bus leaves the terminal buffer under
  motion, with the flip away from the outbound trip as the certain-but-late
  fallback. Terminal anchor = current trip's last stop (arrival) and stop-1 of
  the outbound trip (departure), matching observed staging geometry. A
  scheduled-arm fallback (`scheduled arrival + grace` passed while in buffer)
  prevents stuck-incoming when CTA omits TU terminal predictions. Static block
  chains predict the re-key target ~97% of the time, so the flip's only job is
  confirmation, not linkage. Config knobs: `arrivalRadiusMeters` (default 150,
  per-terminal `radiusMeters` override), `terminalMovementMeters` (default 75),
  `stationaryDisplacementMeters`, `confirmPings`/`departPings` (default 2),
-  `scheduleArmGraceSeconds`. Superseded for departure geometry by the
   2026-08-17 departure-trigger decision below.
- **2026-08-16 — Terminal movement allowance**: live testing showed a bus that
  pulled forward within the terminal could drop off the layover view (or be
  mis-recorded as departed), because the departure radius equaled the tight arm
  radius and the headway fallback quietly classified an untracked bus as
  `departed`. Added `terminalMovementMeters` (default 75): once a bus has an arm
  or committed layover, it stays layover while inside the hold zone (arm radius
  + movement allowance), and departure requires leaving that zone under motion
  for `departPings`. The headway fallback now keeps an ambiguous bus `incoming`
  rather than silently `departed`, so a tracked vehicle never disappears.
- **2026-08-17 — Append-only run events audit**: added `run_events` to store a
  durable timeline of every distinct observed arrival/departure fact (service
  date, trip, vehicle, terminal, route, source, value, and the classification +
  EDT at record time). `run_facts` is rewritten per observation for runtime
  restore, so it loses prior values on correction; `run_events` preserves the
  history for debugging and tuning the dispatch algorithm. Idempotent via
  `UNIQUE(service_date, trip_id, event_type, value_seconds)`; exposed read-only
  via `GET /api/run-events`.
- **2026-08-17 — Fresh VP terminal state**: terminal mechanics use static GTFS
  endpoint identity plus VP coordinates, not VP `stop_id` or `current_status`.
  Radius entry creates a UI-visible arrival candidate; fresh low-displacement
  samples confirm it. Trip flips confirm identity and preserve the earliest
  candidate timestamp. A trip flip is assignment/arrival confirmation only, not
  a departure signal. Cached, duplicate, out-of-order, and over-age VP samples
  cannot create new facts. Run-event evidence records whether a fact came from
  geofence dwell, trip flip, motion exit, or an out-of-buffer fallback.
- **2026-08-17 — Departure trigger and pending state**: arrival uses the inbound
  last-stop radius (default 150 m), while departure uses a separate 75 m trigger
  beyond the outbound first stop. `terminalMovementMeters` is arrival-side
  hysteresis and is not added to the departure trigger. The first moving sample
  starts `departurePending` (red UI indicator); `departPings` fresh moving samples
  confirm the departure. Trip flips never confirm departure.
- **2026-09-03 — Overdue layover flag**: after the review fixes removed the
  accidental (broken) overdue signal from the intervention queue, overdue is
  now surfaced deliberately: `LayoverBus.overdueSeconds` = seconds past EDT
  while still laying over (omitted when ≤ 0, and never applied to incoming or
  departed buses). EDT already includes the minimum-rest allowance, so a
  rest-delayed bus is only flagged past its genuinely expected departure. The
  layover card renders an amber `overdue N min` badge at ≥ 60 s — the same
  noise floor the hold rule uses. Buses only tracked via the scheduled-arm
  fallback are not flagged: their estimated arrival is "now", so their EDT
  stays current until an observed arrival anchors it.
- **2026-08-19 — Read-only debug terminal map**: added
  `GET /api/terminals/:id/map` returning a Zod-validated `TerminalMapSnapshot`
  (geofence circles + color-coded vehicle arrows) built by a new
  `Engine.buildMapSnapshot` from the cached terminal snapshot plus the retained
  raw VP feed (snapshot DTOs never carry lat/lon; vehicle coordinates come only
  from `providers/types.ts`). Buffer radii mirror `recordFacts`: arrival =
  per-terminal `radiusMeters` ?? `arrivalRadiusMeters` (150), movement/hysteresis
  = arrival + `terminalMovementMeters` (75), departure = `departureTriggerMeters`
  (75). Statuses derive from the snapshot: `RouteState.incoming` = inbound,
  `LayoverBus.arrivalPending` = arriving, plain layover = laying over,
  `LayoverBus.departurePending` = departing, `RouteState.departed` = departed.
  Arrow heading prefers the feed's `position.bearing` (now carried through
  `VehiclePositionInfo.bearing`) and otherwise falls back to a computed
  toward/away-from-center bearing. New web route `/terminal/:id/map` renders raw
  Leaflet (OSM tiles, `L.circle` buffers, rotated-SVG `L.divIcon` arrows) with a
  `MapLegend`, linked from `TerminalView`, polling every 10 s.
- **2026-09-03 — Code review fixes (branch `fix/engine-review-findings`)**:
  six findings from a full engine review, each committed atomically.
  1. *Backward headway symmetry*: `decideTriplets` measured the forward gap
     from the leader's `effectiveDeparture` (actual departure when departed)
     but the backward gap from the follower's raw EDT. A follower that
     departed while the center was still laying over produced a fictional gap
     and could recommend holding the center past a follower that was already
     gone. Both gaps now use `effectiveDeparture`; because the hold is half
     the difference, the recommended `until` is always strictly before the
     follower's real departure.
  2. *Stale suggestion expiry*: `expiresAt` was computed as
     `generatedAt + ((until - nowSvc + 86400) % 86400)`. A degenerate decision
     with `until` already in the past wrapped the negative delta into a
     ~24-hour expiry, keeping an impossible recommendation pending for a day.
     Replaced with `suggestionExpiresAt` (plain difference clamped at 0); the
     existing apply-time expiry gate now rejects such rows with a conflict.
  3. *Pending suggestions stay current*: `createSuggestion` was insert-once,
     so the first decision locked in even as predictions moved the EDT. New
     `InterventionStore.refreshSuggestion` reconciles pending rows every
     refresh and appends a `new 'updated'` audit action (the
     `intervention_events` CHECK constraint is rebuilt once for older DBs).
     Revisions are hysteresis-gated: hold length change, >= 30 s move of
     `until`, or vehicle reassignment — prediction jitter no longer spams the
     audit log. Applied/resolved rows are never touched.
  4. *REST compute-on-miss*: `GET /api/terminals/:id` served an empty shell
     unless a WS subscriber had already triggered a refresh. The handler now
     awaits `ensureTerminal`, which computes the snapshot on demand from the
     retained feed (`engine.refresh` is synchronous and the fact pass is
     idempotent) and 500s on engine failure instead of hanging.
  5. *Refresh-path SQLite cost*: added `db/prepare.ts`, a per-connection
     statement memoizer, applied to the hot queries (terminal trips, arrival
     lookups, run-event inserts, intervention lists); route display styles are
     cached per static load. Worker-thread offload remains deferred until
     measurements justify it.
  6. *Agency timezone*: schedule clocks were evaluated in the server's local
     timezone, silently shifting all math on a UTC host. New
     `agencyTimezone` config (default `America/Chicago`, env
     `AGENCY_TIMEZONE`, backfilled for saved configs) is threaded through
     `nowServiceSeconds`/`unixToServiceSeconds`/`activeServiceDate` and the
     TU prediction conversions; offsets are resolved via `Intl` and memoized
     per (zone, UTC hour) so DST transitions cannot straddle a bucket. The
     test suite now passes with the host in any timezone (verified under
     `TZ=America/New_York`); engine fixtures pin the agency zone to UTC.
- **2026-09-04 — Vehicle detail card + block strip**: selecting a bus card opens
  a read-only panel over `latestRt` + the snapshot caches — never a feed fetch
  and never `engine.refresh`. The TU prediction window is the authority for
  upcoming stops (its first entry is the next stop; the current stop is excluded
  even if the feed includes it; the exact terminus is usually missing anyway).
  Schedule-clock windowing (120 s grace) is only the no-TU fallback. Vehicle
  resolution reuses `buildDepartures`' chain via new shared helpers
  (`buildTripToVehicle`/`resolveVehicleForTrip`). The block strip is
  service-date scoped like the queue reads, and the block is looked up from
  `VehicleDetail.blockId` so the strip can be cached/refetched separately. The
  strip layers three identifiers because GTFS colors repeat: a prominent bold
  route number, a deterministic direction shade of the route color
  (`shadeForDirection`: ~40% toward white, or ~25% toward black above luma
  200), and text contrast recomputed on the final shaded background. The GTFS
  `trip_id` is never shown to operators — route number + destination label each
  segment.
- **2026-09-08 — Block manifest replaces the strip (branch `feat/vehicle-card-block-viewer`)**:
  the horizontal SVG strip was unreadable on the mobile-first UI — a typical ~10-hour block
  needs ~1,400 px of width, times are implicit in x-positions, and its hover-only `<title>`
  tooltips do not exist on touch. The block view is now a vertical, full-width list
  (`web/src/components/BlockList.tsx`, pure DOM): one row per trip in block order showing the
  route badge + direction glyph + destination, the scheduled window as explicit `HH:MM – HH:MM`
  clocks, and — when the run ledger recorded them — the observed terminal arrival and departure
  with a derived on-time/late tag. `BlockTrip` renamed `start`/`end` to
  `scheduledDeparture`/`scheduledArrival` and gained `arrivedSeconds` (from `record.arrivalSeconds`)
  alongside the existing `departedSeconds`/`held`. Facts only exist at configured terminals, so
  legs between non-terminal endpoints stay schedule-only rather than implying events. The
  direction-shade encoding and its legend are gone with the strip; `shadeForDirection` remains
  exported/tested but now has no production consumer. *(Follow-up on the same branch: rows now
  show `origin → destination` (new `BlockTrip.origin` from `TripEnd.firstStopName`), a cardinal
  `directionLabel` inferred from the first→last stop bearing via `compassLabel` in geometry.ts
  (GTFS `directions.txt` is optional and rarely shipped; the `direction_id` chevron is the
  fallback when an endpoint lacks coordinates), and a denser divider-based layout instead of card
  chrome.)*

## Build notes

- `better-sqlite3` v11 has no prebuilds for Node 25 and node-gyp's header
  download is blocked by a local proxy cert. Bumped to ^12 and installed with
  `NODE_TLS_REJECT_UNAUTHORIZED=0`. Verify before deploying to a fresh host.

## Next steps

1. Live smoke-test the geometric fact detection against CTA feeds; tune the
   default radius (150 m) and per-terminal overrides using
   `/api/diagnostics/vp` (`dist_to_terminal_m`, parked/armed/flip reasons).
2. Add browser-level tests for queue actions and WebSocket reconnect behavior.
3. Add co-located multi-route terminal view improvements.

---

# Deployment plan execution

Tracks execution of `.agents/DEPLOYMENT_PLAN.md` (phases 0–6). Each phase lands
as its own focused PR into `dev`; the owner handles the Phase 6 owner tasks
(branch protection, default branch, `FLY_API_TOKEN`) and Phases 7–8.

## Deployment Phase 0 — Hygiene (complete)

- Removed the untracked scratch file `server/src/_vpStatus.ts` (unreferenced
  duplicate of the `gtfs/realtime.ts` decode logic; it also failed lint). No
  tracked files changed.
- Baseline verified on `dev`: `npm run typecheck`, `npm run lint`, and
  `npm test` (162 tests) all green; working tree clean of untracked files.

## Deployment Phase 1 — Time-of-day terminal discovery + active-only display (complete)

Branch `feat/terminal-time-variants` → PR into `dev`.

- Discovery (`engine/terminal.ts`) now keeps **every** distinct first/last stop
  served by ≥ `DISCOVERY_MIN_TRIPS` (2) trips per `route:direction` instead of
  only the modal endpoint, so minority time-of-day variants survive; one-off
  deadheads/short-turns are filtered.
- Discovery unions `activeServiceIds` over the next 7 service dates
  (`discoveryServiceIds`), so weekend-only variants are found.
- `config.ts` persists `terminalsSource: 'auto' | 'manual'` (absent → auto).
  `discoverTerminals()` re-runs on every static load in auto mode and replaces
  `config.terminals` only when it changes; a successful `PUT /api/config` marks
  the terminals manual and discovery never touches them again.
- New windowed activity query `activeRoutesByStop` / `activeRoutesAtTerminal`:
  a route is active at a terminal when it has an endpoint event (first-stop
  departure or last-stop arrival) in `[now − 30 min, now + lookahead]`. The
  inbound-arrival side makes a terminal that currently only receives buses show
  as active.
- `GET /api/terminals` splits each route's `terminalIds` (active) from
  `inactiveTerminalIds` (off-duty); the shared Zod schema and `web/src/api.ts`
  DTO carry the new field.
- `web/src/pages/Terminals.tsx` renders active links, tucks inactive ones into a
  collapsed `<details>` "Off-duty" disclosure, polls every 60 s, and refetches on
  `visibilitychange`.
- `engine.ts` intersects an auto terminal's whole-day `routeIds` with the
  windowed route list (union with queued intervention routes unchanged), so a
  route with no departures in the window produces no empty route state while
  queued work stays visible.
- README "Terminals are auto-discovered…" paragraph updated for variants, 7-day
  scope, and re-discovery.

Measurements (CTA full feed: 10,695 stops, 100k trips, 6.0M stop_times; 485
discovered terminals):

- `GET /api/terminals` wall time: **~1.4 s** (after optimization).
- Static **reuse** boot (discovery included): **~4.4 s** (was ~18.6 s).

Deviations / notes:

- The plan's per-terminal `activeRoutesAtTerminal` SQL (correlated `MIN`/`MAX`
  subqueries) made `/api/terminals` take **~66 s** on the full feed. Replaced the
  endpoint's batch path with a single `trip_bounds` CTE query
  (`activeRoutesByStop`), reducing it to ~1.4 s. `activeRoutesAtTerminal` now
  delegates to it (tests unchanged in intent).
- The engine route intersection uses `now − 30 min … now + lookahead` (the same
  window `buildDepartures` uses), not `now … now + lookahead`; otherwise active
  layovers and recently-departed routes dropped out of the snapshot and broke
  the vehicle-detail projection.
- `autoDiscoverTerminals` was rewritten to return only each active trip's
  first/last stop (bounds CTE) rather than every `stop_time`; the original query
  with the new 7-day union took ~18.6 s per static load.
- `PUT /api/config` marks `terminalsSource = 'manual'` on any successful write
  (the config schema always carries a `terminals` array), matching the
  pre-Phase-1 behavior where any persisted terminal list disabled discovery.

Acceptance: both #9 southbound variants (`Vincennes & 104th Street` and
`Ashland & 95th Street`) are discovered and present in config `terminals`, and
the live `/api/terminals` response splits route 9 into active vs off-duty
terminals; the exact 07:00/midday flip is covered by unit tests against a fixed
window. `npm run typecheck`, `npm run lint`, `npm test` (167 tests) all green.

## Deployment Phase 2 — Recommendations + logging for every active terminal (complete)

Branch `feat/global-recommendations` → PR into `dev`.

- `refreshInternal` now evaluates `wanted = active terminals ∪ subscriptions`
  every poll, so recommendations (`interventions`), run facts, and `run_events`
  are produced for the whole active board with no viewer. The active set comes
  from the Phase 1 windowed activity query (`activeTerminalIds`).
- Broadcast stays viewer-scoped: only snapshots for terminals in `subscriptions`
  are pushed over WS; snapshots for every active terminal are still cached for
  REST reads.
- The `[refresh]` finally block now warns when a cycle exceeds
  `refreshIntervalSeconds / 2` (5 s at the 10 s default).
- `TripletDecision` carries `centerEdt`/`leaderEdt`/`followerEdt` and
  `forward`/`backwardHeadwaySeconds`; the engine threads these plus
  `maxHoldSeconds`/`leadTimeSeconds` into `refreshSuggestion`, which writes them
  to `intervention_events.metadata_json` on `created` and `updated` events.
- Audit pass: recommendations resolve through the existing
  `expirePending`/`completeTrip` paths; no per-poll VP/snapshot logging was
  added. README "Known limitations" now documents that `run_events` is
  dispatch-window-bound (roughly now − 30 min … now + 90 min) while covering all
  active terminals.

Measurements (CTA full feed, fresh static: 96,025 trips, 5.9 M stop_times;
288–296 active terminals; ~1,950 TU / ~1,440 VP per poll):

- Full all-terminal refresh wall time: **~2.8–3.5 s** steady state while the
  loaded static did not match the live feed (trip join short-circuits), but
  **~40–60 s** once the live feed matched static and the engine did real
  per-terminal work (all active terminals). The slow-cycle warning fires every
  cycle in that state.
- Accumulation with no browser open (~10 min): `run_events` 1,063 rows across
  220 terminals for the service date; `interventions` 237 rows across 96
  terminals (19 pending); `intervention_events.metadata_json` populated on 101
  `created` + 56 `updated` events.
- Sample decision context:
  `{"forwardHeadwaySeconds":656,"backwardHeadwaySeconds":1830,"leaderEdt":48994,"followerEdt":51480,"centerEdt":49650,"maxHoldSeconds":600,"leadTimeSeconds":300}`.

Risk / deviation (reported, not re-architected, per the plan):

- The 40–60 s refresh exceeds the plan's ~2–3 s expectation. Per the plan's
  Phase 2a instruction ("do not re-architect — report the measurement and
  proceed"), no engine rework was done; the hotspot is the per-terminal
  schedule/route work now run for every active terminal (`outboundRoutesAtTerminal`
  plus `buildDepartures`). This is the main thing to watch at first deploy
  (Phase 7); the 10 s cadence cannot keep up on a machine of this speed.
- The local cached `gtfs.zip` was ~27 days stale and the pre-Phase-3 stale-reload
  path reused it, so the live feed's trip IDs matched nothing until a manual
  `POST /api/static/reload` fetched fresh static. This is exactly the Phase 3
  bug; it also explains the "fast" ~3 s refreshes before the reload (no facts
  were being recorded).

Acceptance: with the app running and no browser open, `run_events` and
`interventions` accumulated across hundreds of terminals, and decision context is
machine-readable. `npm run typecheck`, `npm run lint`, `npm test` (169 tests) all
green.

## Deployment Phase 3 — Scheduled static GTFS refresh (complete)

Branch `fix/static-auto-refresh` → PR into `dev`.

- `downloadStatic(url, cachePath, opts?)` gained `opts.force`: a forced load skips
  the cache read but still writes the freshly downloaded bytes back, so a
  persistent volume no longer freezes on the day-0 artifact. Non-force behavior
  is unchanged.
- `GtfsStaticProvider.load()` passes `cachePath` + `force` for forced loads
  (manual reloads now refresh the cache instead of downloading with no cache).
- `ensureStaticLoadedInternal` computes `refreshCache = force || stale`, so the
  stale branch re-downloads with force semantics (the cached bytes are what is
  stale); the fresh-reuse branch is byte-identical.
- New self-scheduling `scheduleStaticCheck()` runs alongside `scheduleRefresh()`
  and calls `ensureStaticLoaded(false)` every `STATIC_CHECK_SECONDS` (default
  3600, env-tunable and documented in `.env.example`). The call no-ops unless
  `staticRefreshHours` has elapsed.
- New `server/src/gtfs/static.test.ts` (mocked `fetch`, temp cache dir): a valid
  cache short-circuits non-force; force fetches and replaces the cache bytes;
  a missing cache downloads and writes.

Acceptance evidence (with `STATIC_CHECK_SECONDS=60` and `staticLoadedAt` aged in
the DB, since `staticRefreshHours` is integer-only so the plan's `0.02` cannot be
set through `PUT /api/config`):

- Logs: `[static] inspect … stale=true` → `[static] load … force=true`.
- Cached `gtfs.zip` replaced: 99,567,748 bytes (Aug 14) → 68,738,293 bytes
  (fresh, mtime advanced).
- Pending interventions dropped from 51 to 0 on the reload and were re-created
  afterward (30 `canceled` events for the service date).

Deviations / measurements:

- Raised the static download timeout (`fetchZip`) from 30 s to 120 s: the CTA zip
  exceeded 30 s on this network, so every scheduled refresh aborted
  (`error=This operation was aborted`). The realtime feeds keep their own short
  timeouts.
- Static reload on this dev machine was very slow: **persist ~27 min**,
  **total ~35 min**, with **peak RSS ~2.2–2.5 GB** during parse/persist (likely
  memory pressure/swap). This is a strong signal that the plan's 512 MB (even
  1 GB) machine is undersized for the static-load step — flagged for Phase 5's
  memory measurement and first deploy.
- The acceptance used DB aging rather than `staticRefreshHours=0.02` because the
  config schema requires integer hours; the stale code path is identical.

`npm run typecheck`, `npm run lint`, `npm test` (171 tests) all green.

## Deployment Phase 4 — Dispatch token gate (complete)

Branch `feat/dispatch-token-gate` → PR into `dev`.

- New env `DISPATCH_TOKEN` (documented in `.env.example`). Unset → behavior
  identical to before (friction-free local dev).
- A `requireToken` middleware guards every mutating route: the four intervention
  POSTs (`view|apply|decline|cancel`), `PUT /api/config`, and
  `POST /api/static/reload`. A missing/wrong `x-dispatch-token` → `401`
  `{"error":"token required"}`; comparison is constant-time
  (`crypto.timingSafeEqual`).
- `GET /api/health` now includes `tokenRequired: boolean` (schema updated).
- Web: `web/src/api.ts` attaches `x-dispatch-token` from
  `localStorage.dispatchToken` to mutating requests only (reads and WS never send
  it); `testDispatchToken()` probes a mutating route with no side effects.
  `ConfigPage` gains an Operator-token field with Save/Test/Clear.
- `routes.test.ts`: with `dispatchToken` set, mutating routes 401 without the
  header and succeed with it; reads stay open. Without the token, the whole
  suite passes unchanged.

Acceptance evidence (local server with `DISPATCH_TOKEN=test-token-123`):

- `GET /api/health` → `tokenRequired: true`; reads `/api/run-events`,
  `/api/terminals`, `/api/config` all 200; WS `/api/ws` connects.
- `POST /api/static/reload` and `POST /api/interventions/__token-test__/view`
  and `PUT /api/config` → `401` without the header; the intervention probe
  returns `409` (unknown id, i.e. it cleared the gate) with the header.

`npm run typecheck`, `npm run lint`, `npm test` (172 tests) all green.

## Deployment Phase 5 — Docker + Fly packaging (complete, with a sizing blocker)

Branch `chore/docker-fly-packaging` → PR into `dev`.

- `Dockerfile` (repo root, multi-stage): `node:22-slim` + `build-essential`
  + `python3` builder runs `npm ci` → `npm run build` (typecheck + web +
  server bundle) → `npm ci --omit=dev`; the runtime stage copies the prod
  `node_modules`, `server/dist`, `web/dist`, and the workspace manifests.
  `ENV PORT=8080 DB_PATH=/data/dispatch.db STATIC_GTFS_PATH=/data/gtfs.zip`;
  `CMD ["node", "server/dist/index.js"]`.
- `fly.toml` (repo root): `app = "dispatch-pilot"`, `primary_region = "ord"`,
  `internal_port = 8080`, `force_https = true`, `min_machines_running = 1`
  (never autostop), `[[mounts]] data → /data`, an `/api/health` HTTP check
  (10 s / 5 s), `kill_timeout = 30`, `[[vm]] shared-cpu-1x`.
- `.dockerignore` added so the build context excludes `node_modules`, `data/`,
  `.env`, and `.git` (the Dockerfile copies explicit paths, but the daemon would
  otherwise upload the 736 MB local DB and secrets).

Verification (no Docker Desktop — the image build is deferred to Fly's remote
builder at first deploy; the plan's substitute is the fresh-clone sequence):

- Fresh `git clone` of `dev` → `npm ci` → `npm run build` → `npm ci --omit=dev`
  all green; `require('better-sqlite3')` loads and queries.
- `node server/dist/index.js` (production bundle) boots; `/api/health` → `ready`;
  `/api/ws` connects; `GET /api/terminals/:id` returns a snapshot; `/` serves the
  built web index.

**Memory measurement (blocker):**

- Full CTA static load on the production bundle: **peak RSS ~3.5 GB during
  parse**, ~2.6 GB during persist (96,025 trips / 5.9 M stop_times). Steady-state
  after a `[static] reuse` boot: **~368 MB RSS**.
- The plan's rule is ">400 MB → 1 GB", so `fly.toml` is set to `memory = "1gb"`,
  but the measured peak is ~3.5 GB — the 1 GB (indeed 512 MB) machine will very
  likely OOM on the first static load. Fixing this needs either a larger machine
  (breaks the $2–4/mo target) or a streaming/memory-efficient GTFS parse, which
  is a re-architecture outside this plan. **Flagged for the owner before Phase 7.**
- The image build itself (Dockerfile correctness under the remote builder) is
  deferred to Phase 7, as the plan specifies.

`npm run typecheck`, `npm run lint`, `npm test` (172 tests) all green.

## Deployment Phase 6 — GitHub CI/CD (complete; owner tasks remain)

Branch `chore/github-ci` → PR into `dev`.

- `.github/workflows/ci.yml`: triggers on `pull_request` (dev, main) and `push`
  (dev); one `ci` job on `ubuntu-latest`, Node 22 via `actions/setup-node@v4`
  (`cache: npm`), running `npm ci` → `npm run lint` → `npm run typecheck` →
  `npm run build` → `npm test`. The job is named `ci` so branch protection can
  require that exact check.
- `.github/workflows/deploy.yml`: triggers on `push` (main) and
  `workflow_dispatch`; checkout → `superfly/flyctl-actions/setup-flyctl@master`
  → `flyctl deploy --remote-only` (remote builder). Uses the `FLY_API_TOKEN`
  repo secret; `concurrency: group: deploy, cancel-in-progress: false`. A header
  comment notes it intentionally does not rerun tests — it is gated on the same
  commit's `ci` check via branch protection.
- Both files validated as parseable YAML.

Owner tasks deferred (per the task scope — not done here): configure branch
protection on `main`/`dev` (require PR, require the `ci` status check, no force
push/direct push), set the default branch to `dev`, and create the
`FLY_API_TOKEN` repository secret. The deploy workflow is inert until the Fly app
and that secret exist (Phase 8).

## Deployment Phase 7 — Baked static data + refresh cadence (complete)

Branch `feat/baked-static` → merge into `dev`. Fixes the two launch blockers the
Phase 0–6 report measured: the ~3.5 GB parse OOMs the 1 GB machine, and a
full-board decision pass (40–60 s) overran the 10 s cadence.

### 7a — Bake script

- `server/scripts/bake-static.ts` (run `npx tsx server/scripts/bake-static.ts`)
  downloads the public static zip, reuses `parseStatic` + `loadStatic` against a
  fresh throwaway DB, and writes `baked.db` at the repo root (gitignored). The
  file carries the full schema with only the static tables filled plus the static
  markers; operational tables stay empty. No `CTA_API_KEY` needed.

### 7b — Runtime baked mode

- New `server/src/db/bakedStatic.ts` `refreshStaticFromBaked`: `ATTACH`es the
  baked file, and when its `staticLoadedAt` is newer than the volume's, in one
  transaction drops/recreates the static tables (shared `STATIC_SCHEMA_SQL` from
  `schema.ts`) and fills each via `INSERT INTO main.<t> SELECT * FROM baked.<t>` —
  SQL-level, no JS row materialization. Volume config/operational tables are
  untouched.
- `BAKED_STATIC_DB` gates baked mode in `index.ts`. On boot and in the Phase 3
  hourly check the runtime copies newer baked tables, or reuses the volume; it
  **never downloads/parses the zip**. When the volume static is older than
  `staticRefreshHours` and the image is not newer, it logs and surfaces
  `staticStale: true` on `/api/health` (`bakedStaticIsStale`), awaiting the next
  scheduled deploy. Local dev (no `BAKED_STATIC_DB`) is unchanged.

### 7c — Route focus + flat decision tick

- New config `focusRouteIds` (optional; empty = all routes), seeded once from env
  `FOCUS_ROUTES` (`parseFocusRoutes`, backfilled only while never persisted).
  Discovery filters to focused routes (`filterTerminalsByFocus`), so facts,
  recommendations, `run_events`, and the menu all scope automatically. A focus
  change via `PUT /api/config` recomputes the persisted terminal list immediately
  (`terminalsSource: auto`), no restart.
- Ticks split: a **fact tick** every `refreshIntervalSeconds` (10 s) runs the
  global fact pass + expiry only (`engine.refresh(..., new Set())`); a **decision
  tick** every `DECISION_INTERVAL_SECONDS` (default 30) builds route states,
  queues recommendations, writes `run_events`, and broadcasts over the focused
  active terminals ∪ subscriptions. Serialized with coalescing so a decision is
  never dropped. The slow warning now compares a decision pass to its flat
  interval.

### 7d — CI wiring (file edits only)

- `deploy.yml`: added the daily `schedule` cron (`0 9 * * *`), Node setup, and the
  `npm ci` → `npx tsx server/scripts/bake-static.ts` bake step before
  `flyctl deploy --remote-only`. `.dockerignore` does not exclude `baked.db`.
- `Dockerfile`: mandatory `COPY baked.db ./baked.db` in the runtime stage (build
  fails without it).
- `fly.toml`: env adds `BAKED_STATIC_DB=/app/baked.db` and
  `DECISION_INTERVAL_SECONDS=30`; `memory = "1gb"` kept (baked mode removes the
  parse; steady state ~368 MB).

### Measurements (CTA full feed; production bundle)

- Bake: **~8.9 min** total (95 s download+parse, then persist), `baked.db` =
  636,739,584 bytes (~637 MB).
- Baked copy on a fresh volume: `[static] ready` **~104 s**, **peak RSS ~346 MB**
  (well under 1 GB), no download (`[static] baked copy`).
- Fact ticks: **~80–880 ms**, every 10 s.
- Decision pass, all routes (229 active terminals): ~12.8 s.
- Runtime focus (15 routes incl. #9): `/api/terminals` **124 → 15 routes**,
  **485 → 98 terminals** with no restart; decision passes **~2.2–2.9 s** (42
  active terminals), **zero slow warnings**.
- Baked stale (both DBs aged): `staticStale: true`, **0 download attempts**, the
  hourly check no-ops.
- Non-baked path (tiny local GTFS over HTTP): `[static] load` → parsed →
  persisted → ready, cache written — local dev unchanged.

### Deviations / notes

- Baked mode carries `serviceDayStartSeconds` alongside `staticLoadedAt`. The plan
  said "update only the loadedAt marker", but the CTA feed's detected service-day
  start is **9600 s (02:40)**, not the 10800 s default; copying stop_times without
  it would shift every schedule clock by 20 min. Both are static-derived markers
  (the volume's `appConfig`/operational tables stay untouched), and the unit test
  asserts the volume config/logs survive.
- `PUT /api/config` now marks `terminalsSource = 'manual'` only when the submitted
  terminal list actually changes (not on any write, the Phase 1 interpretation).
  Required by 7c: a runtime focus edit must keep `auto` and recompute terminals
  without a restart. This also matches the plan's literal "PUT with a terminals
  payload" wording.
- Added `DECISION_INTERVAL_SECONDS`/`FOCUS_ROUTES`/`BAKED_STATIC_DB` to
  `.env.example`; `baked.db*` added to `.gitignore`.

Acceptance: all of the above verified locally with the real CTA feed.
`npm run typecheck`, `npm run lint`, `npm test` (**179 tests**) all green.

Remaining owner work: Phase 8 (Fly website — app `dispatch-pilot` in `ord`,
volume `data` 1 GB created before first deploy, secrets incl. optional
`FOCUS_ROUTES` seed, deploy token → GitHub `FLY_API_TOKEN`, branch protection,
default branch `dev`, then the `dev`→`main` release PR) and Phase 9 (~24 h data
review).

## Deployment Phase 10 — Post-launch performance fixes (complete)

Branch `fix/post-launch-perf` → merge into `dev`. Fixes the first production-day
findings: single-threaded 10–18 s decision passes blocked concurrent requests and
tripped Fly's 5 s health check (edge unrouting), and a fetch wedged past its
abort froze both tick loops. **The decision cadence stays at 30 s**
(`DECISION_INTERVAL_SECONDS = "30"` in `fly.toml` untouched throughout).

### 10a — Chunked decision pass

- `Engine.refreshChunked` shares the exact preparation and per-terminal builder as
  `refresh` but evaluates terminals in bounded slices, yielding to the event loop
  after `sliceSize` (8) terminals or `sliceBudgetMs` (250 ms), whichever comes
  first; `shouldContinue` lets an abandoned pass stop early. `index.ts` decision
  ticks use it. Fact ticks stay synchronous (sub-second). The ledger mutates only
  in whole-terminal units, so an interleaved read/compute-on-miss never sees a
  half-built terminal.

### 10b — Memoized GET /api/terminals

- The route caches its computed body for 30 s, keyed on `getTerminalsVersion()`
  (bumped on every config write and completed static load), so config changes and
  static refreshes invalidate immediately. Sub-second p95 thereafter, even during
  a pass.

### 10c — Tolerant health check re-added

- `fly.toml`: `[[http_service.checks]]` interval 10 s, timeout 25 s, grace 1 m on
  `/api/health`, restored only after 10a/10e landed.

### 10d — Focus field in the Settings UI

- `web/src/pages/ConfigPage.tsx` gains a comma-separated **Focus routes** field
  backed by pure `formatFocusRoutes`/`parseFocusRoutes` helpers; it round-trips
  through `PUT /api/config` and the server recomputes the terminal list with no
  restart (existing 7c path).

### 10e — Structural tick-loop fix

- `index.ts` now runs on `server/src/refreshLoop.ts`: unconditional tick
  rescheduling, a hard per-cycle abandon (`REFRESH_ABANDON_SECONDS`, default 25 —
  above the 15 s fetch timeout, below the watchdog), coalesced decisions, and
  generation guards. `refreshInternal(runDecisions, isCurrent)` gates every shared
  write (`latestRt`, snapshots, `lastRefreshAt`/`lastRefreshError`/
  `lastRefreshDurationMs`, broadcasts, watchdog touch) and skips engine work when
  its generation was abandoned. `requestDecision` settles within one cycle or the
  abandon bound, so HTTP callers can never hang on a wedged loop. The liveness
  watchdog stays as belt-and-braces. `runRefresh`/`decisionRequested`/
  `scheduleFactTick`/`scheduleDecisionTick` removed; `loops.isRunning()` feeds the
  health `refreshInFlight` flag.

### Tests (182 → 197)

- `refreshLoop.test.ts` (6): never-settling cycle cannot stop the loops; abandon
  frees the slot; a late zombie cannot clear a newer slot/drain waiters/requeue;
  a decision requested during a fact cycle runs immediately after and resolves its
  waiters; cycle errors never stop the loops; `stop()` halts and resolves waiters.
- `refreshChunked.test.ts` (4): identical output to the unchunked pass;
  interleaved work served between slices; time budget bounds a slice;
  `shouldContinue` abandons early.
- `routes.test.ts` (2): memoization within the window + version invalidation;
  `focusRouteIds` round-trips through `PUT /api/config` and recomputes terminals.
- `focus.test.ts` (3): format/parse/round-trip.

### Measurements (local, production-like baked mode from the repo `baked.db`)

- Fresh-volume baked copy: `[static] ready` in **147.7 s**, then the real CTA
  feeds.
- Focus `9,49,79`: **3 routes / 24 terminals**, **19 active**.
- Decision passes: **4.7 s cold**, **1.34 s warm** — comfortably inside 30 s with
  room; fact passes 1.6 s cold / 0.18 s warm. No slow-cycle warnings.
- `GET /api/terminals`: **815 ms cold → 3 ms cached**.
- Hung-cycle demo (feed URLs repointed at a non-routable host,
  `REFRESH_ABANDON_SECONDS=10` to make the bound observable): logs show
  `[refresh] abandoned generation=4 decisions=true waited_ms=10007` and
  `generation=6 decisions=false waited_ms=10006`; `[refresh] begin` kept firing,
  and `/api/health` stayed `ready=true refreshInFlight=true` throughout — a hung
  refresh is now a bounded gap, not a freeze.

### Deviations / notes

- Runtime acceptance used the repo's baked `baked.db` to avoid the ~27 min
  dev-machine parse measured in Phase 3/5; baked mode is the production shape.
- The hung-cycle demo lowered `REFRESH_ABANDON_SECONDS` to 10 s only to observe the
  abandon on the dev machine (the default remains 25). The 15 s provider abort
  settles the zombie fetch; its post-abandon `AbortError` is suppressed by the
  generation guard.
- `[[http_service.checks]]` replaces fly.toml's interim "no health check" comment.

`npm run typecheck`, `npm run lint`, `npm test` (**197 tests**) all green; branch
merged into `dev` with `--no-ff` and deleted. Remaining owner work: the
`dev`→`main` release PR (watch the deploy + first boot), then Phase 9's ~24 h data
review.
