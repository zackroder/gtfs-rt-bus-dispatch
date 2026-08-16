# Implementation Specification

Detailed build spec for the bus dispatch pilot. A coding agent should treat
this as the source of truth; `README.md` is the human-facing summary,
`PROGRESS.md` tracks status, `AGENTS.md` has the commands/conventions.

## 1. Scope

Build the app end-to-end (Phases 0-6 in `PROGRESS.md`):

1. Ingest CTA GTFS static into SQLite.
2. Poll + decode GTFS-RT (VehiclePositions + TripUpdates) behind a provider
   abstraction.
3. Join realtime to schedule; compute per-terminal snapshots (incoming,
   layovers, interventions).
4. Serve REST + WebSocket; render a mobile-first React UI with a live
   min:sec layover countdown and hold recommendations.

Do **not** implement auth, multi-user roles, or the proprietary-DB adapter.
Leave the provider interface ready for it, but only ship the GTFS-RT adapter.

## 2. Tooling

- Node 18+ (LTS), npm.
- TypeScript **strict** everywhere. No `any` except at the GTFS-RT protobuf
  boundary (wrap and normalize into `shared/types.ts`).
- npm workspaces: `shared/`, `server/`, `web/`.
- Server: `express`, `better-sqlite3`, `gtfs-realtime-bindings`, `ws`, `zod`,
  `dotenv`, `adm-zip`, `csv-parse` (or `fast-csv`), `node-fetch` (or global
  `fetch`).
- Web: `react`, `react-dom`, `react-router-dom`, Vite.
- Dev/test: `tsx` (server watch), `vitest`, `eslint` + `@typescript-eslint`.

Root scripts (also in `AGENTS.md`): `dev`, `build`, `lint`, `typecheck`,
`test`.

## 3. Repository layout

```
shared/types.ts            # all DTOs + AppConfig + zod schemas (see §4)
server/src/
  index.ts                 # express + ws + static serving + scheduler
  config.ts                # load/save AppConfig (SQLite settings), zod validate, env seed
  db/schema.ts             # DDL (§5)
  db/staticLoader.ts       # parse -> SQLite, derive block_trips
  gtfs/static.ts           # download/unzip/parse GTFS CSVs
  gtfs/time.ts             # service-day time helpers (§6)
  gtfs/realtime.ts         # HTTP fetch + protobuf decode
  providers/types.ts       # RealtimeProvider interface (§7)
  providers/gtfsrt.ts      # GTFS-RT adapter (§7)
  engine/terminal.ts       # terminal resolution (§8.1)
  engine/headway.ts        # departures, vehicle assignment, EDT inputs (§8.2–8.3)
  engine/dispatch.ts       # CORE dispatch logic: EDT + triplet hold (§8.5)
  engine/engine.ts         # orchestrator + run ledger -> TerminalSnapshot[] (§8.4, §8.6)
  api/routes.ts            # REST (§9)
  api/ws.ts                # WebSocket broadcast (§9)
web/src/
  main.tsx, App.tsx, api.ts
  pages/Terminals.tsx, pages/TerminalView.tsx
  components/BusCard.tsx, LayoverCard.tsx, InterventionCard.tsx,
             RouteGroup.tsx, Countdown.tsx
  hooks/useStream.ts, hooks/useCountdown.ts
```

## 4. Shared types

Authoritative DTOs. Server and web import from `shared/types.ts`.

```ts
export interface Terminal {
  id: string;
  name: string;
  stopIds: string[];          // GTFS stop_id(s); co-located terminals use >1
  routeIds?: string[];        // optional filter; undefined = all routes at stop
}

export interface Stop {
  stopId: string;
  stopCode?: string;
  stopName: string;
  lat: number;
  lon: number;
}

export interface VehiclePosition {
  vehicleId: string;
  tripId?: string;
  routeId?: string;
  stopId?: string;
  stopSequence?: number;
  lat?: number;
  lon?: number;
  timestamp: number;          // unix seconds
}

export interface StopTimePrediction {
  stopId: string;
  stopSequence: number;
  arrivalDelay?: number;      // seconds (signed)
  departureDelay?: number;    // seconds (signed)
  arrivalTime?: number;       // unix seconds
  departureTime?: number;     // unix seconds
}

export interface TripUpdateInfo {
  tripId: string;
  vehicleId?: string;
  routeId?: string;
  delay?: number;             // trip-level seconds (signed)
  stopTimeUpdates: StopTimePrediction[];
  timestamp: number;          // unix seconds
}

export interface IncomingBus {
  routeId: string;
  routeShortName: string;
  tripId: string;             // current inbound trip
  vehicleId?: string;
  scheduledArrival: number;   // service-day seconds
  predictedArrival: number;   // service-day seconds
  etaSeconds: number;         // predictedArrival - nowSvc (>= 0)
  delaySeconds: number;       // predictedArrival - scheduledArrival
  nextTripId: string;         // outbound trip the vehicle will operate next
  nextDestination: string;    // last stop name of the next trip (not headsign)
  scheduledDeparture: number; // service-day seconds of the next trip
  expectedDeparture: number;  // EDT of the next trip
  restDelayed?: boolean;      // true when EDT > scheduledDeparture
}

export interface HoldOverride {
  holdSeconds: number;        // additional seconds
  effectiveDeparture: number; // service-day seconds (EDT + hold)
  reason: string;
}

export interface LayoverBus {
  routeId: string;
  routeShortName: string;
  tripId: string;             // next outbound trip (from block chain)
  vehicleId?: string;
  scheduledDeparture: number; // service-day seconds
  scheduledArrival: number;   // scheduled terminal arrival of previous trip in block
  terminalArrival?: number;    // observed arrival from VehiclePositions
  terminalArrivalSource?: 'observed' | 'estimated';
  expectedDeparture: number;  // EDT = max(scheduled, arrival + minRest)
  predictedDeparture: number; // effective: held time if held, else EDT
  countdownSeconds: number;   // predictedDeparture - nowSvc (timer target)
  hold?: HoldOverride;
  restDelayed?: boolean;      // true when EDT > scheduledDeparture
}

export interface DepartedBus {
  routeId: string;
  routeShortName: string;
  tripId: string;
  vehicleId?: string;
  headsign?: string;          // last stop name of the departed trip (not headsign)
  scheduledDeparture: number; // service-day seconds
  departureSeconds: number;   // recorded actual departure
  held?: boolean;             // departure left under a locked hold
  currentStop?: string;       // stop name the vehicle is at now (from VP)
}

export type InterventionRule = 'hold';

export interface Intervention {
  id: string;
  serviceDate: string;
  terminalId: string;
  routeId: string;
  rule: InterventionRule;
  tripId: string;
  vehicleId?: string;         // the center bus to hold
  leaderVehicleId?: string;
  followerVehicleId?: string;
  holdSeconds: number;
  reason: string;
  until?: number;             // service-day seconds
  generatedAt: number;        // unix seconds
  expiresAt?: number;
  status: 'pending' | 'applied' | 'declined' | 'canceled' | 'expired' | 'completed';
  appliedAt?: number;
  resolvedAt?: number;
}

export interface RouteState {
  routeId: string;
  routeShortName: string;
  routeLongName?: string;
  color?: string;       // GTFS 6-digit hex, for the route badge
  textColor?: string;   // GTFS 6-digit hex
  incoming: IncomingBus[];
  layovers: LayoverBus[];
  departed: DepartedBus[];
  interventions: Intervention[];
}

export interface TerminalSnapshot {
  terminalId: string;
  generatedAt: number;        // unix seconds
  routes: RouteState[];
}

export interface AppConfig {
  realtime: {
    vehiclePositionsUrl: string;
    tripUpdatesUrl: string;
    apiKey?: string;
  };
  staticGtfsUrl: string;
  refreshIntervalSeconds: number;   // 10
  staticRefreshHours: number;       // 24
  minRestMinutes: number;           // 5  (mandatory rest in EDT)
  maxHoldMinutes: number;           // 10 (ceiling on any hold)
  leadTimeMinutes: number;          // 5  (evaluate before expected departure)
  lookaheadMinutes: number;         // 90
  terminals: Terminal[];            // auto-discovered, then editable
}
```

Config is validated with `zod` (a single schema in `shared/types.ts` or
`server/src/config.ts`). Env vars (`CTA_STATIC_URL`, `CTA_VP_URL`,
`CTA_TU_URL`, `CTA_API_KEY`, `PORT`, `DB_PATH`, `STATIC_GTFS_PATH`) seed the
initial defaults only.

## 5. SQLite schema

`DB_PATH` (default `./data/dispatch.db`). WAL mode. `better-sqlite3` sync.

```sql
CREATE TABLE IF NOT EXISTS stops (
  stop_id TEXT PRIMARY KEY,
  stop_code TEXT,
  stop_name TEXT,
  parent_station TEXT,
  lat REAL,
  lon REAL
);

CREATE TABLE IF NOT EXISTS routes (
  route_id TEXT PRIMARY KEY,
  agency_id TEXT,
  short_name TEXT,
  long_name TEXT,
  type INTEGER,
  color TEXT,        -- GTFS 6-digit hex (route_color), used for the badge
  text_color TEXT    -- GTFS 6-digit hex (route_text_color)
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id TEXT PRIMARY KEY,
  route_id TEXT,
  service_id TEXT,
  block_id TEXT,
  direction_id INTEGER,
  headsign TEXT
);
CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
CREATE INDEX IF NOT EXISTS idx_trips_block ON trips(block_id);

CREATE TABLE IF NOT EXISTS stop_times (
  trip_id TEXT,
  stop_sequence INTEGER,
  stop_id TEXT,
  arrival_time INTEGER,   -- service-day seconds (§6)
  departure_time INTEGER, -- service-day seconds (§6)
  pickup_type INTEGER,
  drop_off_type INTEGER,
  PRIMARY KEY (trip_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS idx_st_trip ON stop_times(trip_id);
CREATE INDEX IF NOT EXISTS idx_st_stop ON stop_times(stop_id);

CREATE TABLE IF NOT EXISTS calendar (
  service_id TEXT PRIMARY KEY,
  monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER,
  friday INTEGER, saturday INTEGER, sunday INTEGER,
  start_date TEXT, end_date TEXT
);

CREATE TABLE IF NOT EXISTS calendar_dates (
  service_id TEXT,
  date TEXT,
  exception_type INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cd_date ON calendar_dates(date);

CREATE TABLE IF NOT EXISTS block_trips (
  block_id TEXT,
  seq INTEGER,
  trip_id TEXT,
  start_time INTEGER,   -- service-day seconds of trip's first departure
  route_id TEXT,
  service_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_bt_block ON block_trips(block_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT
);
```

Operational state is stored separately from static/config data in persistent
`interventions`, append-only `intervention_events`, `config_events`, and
service-date-scoped `run_facts` tables.
An intervention identity is stable for a service date, terminal, route, trip,
and rule. Pending suggestions do not enter dispatch calculations; only
`applied` suggestions hydrate the active hold ledger.

`stop_times` holds **normalized** service-day seconds (not raw `HH:MM:SS`).
Only rows for the active service day are needed by the engine, but load the
whole feed into SQLite (read-only reference).

## 6. Time model (critical)

GTFS times are `HH:MM:SS` and may exceed `24:00:00` (trips running past
midnight belong to the *previous* calendar day's service).

We normalize everything to **seconds since service-day start**, where the
start is **auto-detected from the GTFS stop_times** (not configured).

### 6.1 Detect service-day start (`gtfs/time.ts`)

1. For every trip, take its first `departure_time` and last `arrival_time`
   (raw seconds, may exceed `86400`) and reduce modulo 86400 to a
   `[start, end)` active interval on a 24h circle; if `end <= start` the trip
   crosses midnight (covers `[start, 86400)` + `[0, end)`).
2. Bucket the circle into minutes; mark buckets covered by any trip's active
   interval.
3. Find the longest run of zero-coverage minutes (the overnight lull).
   Service-day start = the first minute after the lull.
4. Fallback: no zero-coverage gap (24h operation) -> use the least-covered
   minute as the lull; still ambiguous -> default `03:00`.

Store `serviceDayStartSeconds` in `settings` at load. Derived, not
user-editable; keep an emergency override key for troubleshooting.

### 6.2 Normalization

```
svcSeconds(raw) = raw - serviceDayStartSeconds
if svcSeconds < 0: svcSeconds += 86400
```

Apply to every stop_time at load. At runtime:

```
nowSvc = localSecondsSinceMidnight(now) - serviceDayStartSeconds
if nowSvc < 0: nowSvc += 86400
```

Late-night trips (e.g. `25:30` -> `81000`) land near the *end* of the same
service day as "now" shortly after midnight, so ordering, `departure -
nowSvc`, and countdowns need no date/wrap special-casing.

All engine math uses service-day seconds. `unix` timestamps appear only in
DTOs for display/debugging.

### 6.3 Active service day

Map `nowSvc` to a calendar date: if `now` (wall clock) precedes the service-
day start, the active service day is *yesterday's* calendar date; otherwise
today's. Active `service_id`s = calendar (weekday flag true AND date in
`[start_date, end_date]`) ∪ calendar_dates(`exception_type=1`) −
calendar_dates(`exception_type=2`).

## 7. Realtime provider abstraction

```ts
// providers/types.ts
export interface RealtimeSnapshot {
  timestamp: number;                 // unix seconds
  vehicles: VehiclePosition[];
  tripUpdates: TripUpdateInfo[];
}

export interface RealtimeProvider {
  fetch(): Promise<RealtimeSnapshot>;
}
```

`providers/gtfsrt.ts` implements it:

- GET `vehiclePositionsUrl` and `tripUpdatesUrl`, appending
  `?key=<apiKey>` (the CTA `transitdata` endpoints require the key). Load the
  key from `.env` (`CTA_API_KEY`); never log or expose it.
- Decode `FeedMessage` via `gtfs-realtime-bindings`.
- VehiclePositions: `entity.vehicle` -> `vehicle.id`, `vehicle.trip.trip_id`,
  `vehicle.trip.route_id`, `vehicle.position` (lat/lon/bearing),
  `vehicle.current_stop_sequence`, `vehicle.stop_id`, `vehicle.timestamp`.
- TripUpdates: `entity.trip_update` -> `trip_update.trip.trip_id`,
  `trip_update.vehicle.id`, `trip_update.delay` (signed seconds),
  `trip_update.stop_time_update[]` -> `stop_id`, `stop_sequence`,
  `arrival.delay/time`, `departure.delay/time`.
- Drop entities lacking `trip_id` or `vehicle_id`. Convert all `delay`/`time`
  to seconds. Note `time` in GTFS-RT is POSIX time (seconds).
- Never throw the whole poll; return what parsed and log skipped entities.

The `fetch()` is called by the scheduler; a provider swap only changes this
file.

## 8. Engine algorithm

`engine/engine.ts` exposes `refresh(rt, now): TerminalSnapshot[]`. On each tick
it: computes `nowSvc`; builds the ordered departures per terminal/route; updates
the in-memory run ledger with arrival/departure facts; calls the pure dispatch
core; and assembles snapshots.

### 8.0 Where the business logic lives (review this first)

All decision math is centralized in **`server/src/engine/dispatch.ts`** — pure
functions with no DB, realtime, or network I/O. It is the single source of
truth for:

- `expectedDepartureTime` — the EDT formula (§8.3).
- `holdSeconds` — the headway-equalization formula with floor + cap (§8.5).
- `decideTriplets` — the left-to-right pass over an ordered departure list.

No other file may compute a hold or an EDT. To audit "why did we recommend this
hold?", read `dispatch.ts` and its tests (`dispatch.test.ts`) — nothing else is
needed.

### 8.1 Terminal resolution (`terminal.ts`)

For a `Terminal` (stopIds S) and route R:

- **Outbound trips** (departures): trips of R whose *first* `stop_times` row
  (min `stop_sequence`) has `stop_id ∈ S` and `pickup_type != 1`.
- **Inbound trips** (arrivals): trips of R whose *last* `stop_times` row (max
  `stop_sequence`) has `stop_id ∈ S` and `drop_off_type != 1`.

Auto-discovery (run once after static load, then stored as `terminals`
config): for every route, its first stop and last stop are terminal
candidates; group by `stop_id` (name from `stop_name`, coordinates from
`stops`). A candidate terminal lists the routes that originate there. The
user can later merge multiple `stop_id`s into one terminal and filter by
route.

### 8.2 Departures + vehicle assignment (`headway.ts`)

For each terminal route in the lookahead window `[nowSvc, nowSvc +
lookaheadMinutes*60]`, produce ordered outbound departures. For each
departure trip T:

1. `scheduledDeparture = stop_times.departure_time` at S for T.
2. **Assign vehicle**: build `tripId -> vehicleId` from realtime tripUpdates
   + vehiclePositions. Walk the block chain: `block_trips` gives, for each
   trip, its next trip (same `block_id`, `seq+1`). A vehicle currently on
   trip X will operate `nextTrip(X)`. So the vehicle for outbound T =
   vehicle currently on `prevTrip(T)`, or vehicle already assigned to T by
   realtime (rare).
3. **Classify** the vehicle:
   - `incoming`: vehicle's current trip is `prevTrip(T)` and its predicted
     arrival at S is still in the future.
   - `layover`: the vehicle has arrived at the terminal but not yet departed.
   - `departed`: an actual departure has been recorded (§8.4).

Sort the list chronologically by **effective departure** (actual departure if
`departed`, else the locked `until` if held, else EDT), not by scheduled time.

### 8.3 Terminal arrival + expected departure (EDT)

`terminalArrival` for a departure's vehicle:

- **incoming**: predicted arrival at the terminal from TripUpdates — prefer
  `arrivalTime` (absolute), else `scheduledArrival + arrivalDelay`, else
  trip-level `delay` (exactly today's `arrivalAtTerminal`).
- **layover**: the observed actual arrival from VehiclePositions, when
  available. A TripUpdates arrival prediction may be used as an estimated EDT
  input but is never written as a recorded arrival fact.

```
EDT = max(scheduledDeparture, terminalArrival + minRestMinutes*60)
```

A bus is **rest-delayed** when `EDT > scheduledDeparture`.

ETA for an incoming bus = `predictedArrival - nowSvc`.

### 8.4 Run ledger (in-memory)

A per-process map keyed by the active service date and `tripId`, carried across
refreshes, that records terminal-arrival and departure **facts**. Applied hold
state is persisted separately and restored into this ledger:

- `arrivalSeconds` — frozen once VehiclePositions observes a vehicle at/past
  the terminal.
- `departureSeconds` — the actual departure once observed (§8.5 detection).
- `hold` — the locked `{ holdSeconds, until }` only after a pending suggestion
  is explicitly applied.

Observed arrival/departure facts are restored from `run_facts` on process
restart. Only `layover`/`departed` facts come from the ledger; `incoming` buses
get fresh predictions each tick.

### 8.5 Dispatch core (`dispatch.ts`)

Pure, side-effect-free. Input: the chronologically ordered departure list (each
with `state`, `terminalArrival`, `scheduledDeparture`, `EDT`, and any locked
hold), plus `nowSvc`, `leadTimeMinutes`, `maxHoldMinutes`.

For each center at index `i` in `[1, n-2]`:

1. Skip if the center has already departed or already has a locked hold.
2. **Trigger**: only if `nowSvc >= center.EDT - leadTimeMinutes*60`.
3. Leader reference = effective departure of `i-1` (actual if departed, else
   held `until`, else EDT). Follower reference = `EDT` of `i+1`.
4. `H_f = center.EDT - leader`, `H_b = follower - center.EDT`.
5. `holdSeconds = min(max((H_b - H_f)/2, 0), maxHoldMinutes*60)`.
6. Round the hold to the nearest 30 seconds. If the unrounded hold is less than
   60 seconds, emit no suggestion. If the resulting hold is positive, create a
   persistent `pending` suggestion with `until = center.EDT + holdSeconds`.
   It does not become the center's effective departure until the manager applies
   it. An applied hold's `until` becomes the center's effective departure for
   subsequent triplets and for the countdown.

Properties: the `max(…, 0)` floor means a bus is never dispatched early; the
`min(…, maxHold)` ceiling bounds every hold. The first and last departures have
no neighbor on one side and are never held. Holds propagate left-to-right
because each center's locked `until` feeds the next triplet's leader reference.

### 8.6 Snapshot assembly

For each terminal: group by route; build `RouteState`:

- `incoming` = `state === 'incoming'` — `scheduledArrival`, `predictedArrival`,
  `etaSeconds`, `delaySeconds`, plus the next outbound trip (`nextTripId`,
  `nextDestination` = last stop name, `scheduledDeparture`, `expectedDeparture`).
- `layovers` = `state === 'layover'`, with `scheduledArrival` (previous trip's
  scheduled terminal arrival), `terminalArrival` (recorded), `expectedDeparture`
  (EDT), `predictedDeparture` (held `until` if held, else EDT), `restDelayed`
  flag, and `hold`.
- `departed` = `state === 'departed'` within the recent window (30 min), with
  `scheduledDeparture`, recorded `departureSeconds`, `held` (left under a locked
  hold), `headsign` (last stop name), and `currentStop` (from VP when available).
- `countdownSeconds = predictedDeparture - nowSvc` (targets the effective
  departure: held time if held, else EDT).

## 9. API + WebSocket

- `GET /api/health` -> `{ ok, lastRefreshAt, staticLoadedAt }`.
- `GET /api/terminals` -> `{ terminals: Terminal[], routes: {routeId, shortName, longName?, color?, textColor?, terminalIds[]}[] }`, sorted by route number (numeric-aware).
- `GET /api/terminals/:id` -> latest `TerminalSnapshot` (optionally
  `?route=R` filters to one route).
- `GET /api/config` -> `AppConfig` (redact `apiKey`).
- `PUT /api/config` -> validate (zod) + persist to `settings` + apply.
- `POST /api/static/reload` -> re-download + reload static (manual trigger).
- `GET /api/interventions?terminalId=T` -> persistent active-service-day queue.
- `GET /api/interventions/:id` -> intervention detail.
- `POST /api/interventions/:id/view|apply|decline|cancel` -> audited interaction/state transition.
- `GET /api/diagnostics/vp` -> read-only VP observations, transition candidates,
  recorded fact events, and feed freshness/errors.
- `WS /api/ws` -> sends subscribed terminal snapshots on refresh and after queue actions.

## 10. Frontend

Mobile-first (max-width container, large tap targets). `react-router-dom`:

- `/` -> `Terminals.tsx`: list terminals grouped by route (sorted by route
  number, numeric-aware, server-side); tap to open.
- `/terminal/:id` -> `TerminalView.tsx`: sections per route — **Inbound
  vehicles** (scheduled + estimated arrival, estimated red when late, next-trip
  destination and departure), **Laying over** (recorded vs scheduled arrival
  with late arrival red, expected vs scheduled departure, `Countdown`, hold
  badge if held), **Recently departed** (recorded vs scheduled departure,
  purple when held, destination and current stop from VP), and **Interventions**
  (`InterventionCard`: persistent status with Apply, Decline, and Cancel actions).

Every route header (home + terminal view) and the inbound "Next trip" line
render a `RouteBadge` — a rounded pill with the route number on the GTFS
`route_color` background (text `route_text_color`, else auto-contrast
black/white). Headers put the route long name next to the badge.

`hooks/useCountdown(seconds)` uses a shared page clock and renders `MM:SS`
(color: green > 2 min, amber 0-2 min, red < 0).

`hooks/useStream.ts`: open WS, fall back to 10s polling of
`GET /api/terminals/:id` if WS fails.

Header shows last-updated time and data-source status.

## 11. Testing (vitest)

- `gtfs/time.test.ts`: `24:00:00+` wrap, service-day start offset, midnight
  rollover.
- `staticLoader` round-trip with a tiny synthetic GTFS (hand-written
  `routes`, `trips`, `stop_times`, `calendar`).
- `block_trips` derivation: chaining across a 2-trip block.
- Realtime decode: synthetic `FeedMessage` protobuf -> normalized DTO.
- `dispatch.test.ts` (pure, no DB):
  - EDT: on-time (`scheduled` when `arrival + rest <= scheduled`) and
    rest-delayed (`arrival + rest` when it exceeds scheduled).
  - hold formula: floor at 0 and cap at `maxHoldMinutes`.
  - triplet pass: the README worked example (holds 2 min then 0), left-to-right
    propagation, first/last never held.
  - trigger window measured from EDT; no fire before it opens.
  - pending suggestions do not change effective departures;
  - applied holds hydrate after restart and are not re-derived;
  - declined, canceled, and expired suggestions do not affect dispatch;
  - hold rounding and the one-minute minimum.
- Engine (synthetic schedule + synthetic realtime):
  - rest-delayed flag set when a late arrival pushes EDT past scheduled.
  - departed leader uses its actual (recorded) departure in the triplet.
  - incoming bus uses its predicted arrival in EDT.
  - countdownSeconds = predictedDeparture - nowSvc (held time when held).

## 12. Definition of done

1. `npm run typecheck`, `npm run lint`, `npm test` all pass.
2. `npm run dev` loads CTA static (or synthetic fixture), polls GTFS-RT, and
   serves the UI.
3. Terminal auto-discovery produces a list grouped by route.
4. Terminal view shows inbound scheduled/estimated arrivals, layover
   recorded/scheduled arrivals with countdowns, recently-departed actual/scheduled
   departures (purple when held) with current stops, and hold badges.
5. Triplet suggestions are emitted per §8.5 with 30-second rounding and the
   one-minute minimum, then require explicit approval before affecting dispatch.
6. `PUT /api/config` updates rules live; persisted in SQLite.
7. Intervention state transitions and views are persisted and audited.
8. VehiclePositions are the only source for recorded arrival/departure facts.
9. `npm run build && npm start` serves the built web bundle from the server.

## 13. Sequencing

Implement in PROGRESS phase order (0 -> 6). Commit working checkpoints at each
phase boundary. Default feed URLs are the CTA `transitdata` endpoints (key
required; see `.env.example`); the provider must work with any URL/key in
`.env`.
