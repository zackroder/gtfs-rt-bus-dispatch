# Bus Dispatch Pilot

A web app for bus dispatching at transit terminals. It combines GTFS static
schedule data with GTFS-Realtime vehicle positions and trip updates to detect
buses running off-schedule, then recommends simple "hold" interventions so a
dispatcher can even out headways between consecutive departures.

## What the app does

- Shows each terminal's bus activity in three groups: inbound, laying over, and
  recently departed.
- Recommends when to hold the middle bus of a set of consecutive departures so
  headways stay more even.
- Lets a dispatcher view, apply, decline, or cancel each recommendation, and
  records every action.
- Includes a debug map view showing a terminal's geofence circles and live
  vehicle positions.

## How hold decisions work

When several outbound buses leave a terminal in sequence, the app groups them
into triplets — leader, center, follower — and considers the two gaps between
them:

- the forward headway, from the leader's departure to the center's, and
- the backward headway, from the center's departure to the follower's.

If the gap behind the center is larger than the gap ahead, it recommends holding
the center for half the difference:

```
hold = min(max((backward − forward) / 2, 0), maxHoldMinutes)
```

This spreads a late bus's delay onto a following bus instead of letting it pile
into one gap. Holds are capped at the configured maximum, rounded to 30-second
increments, and recommendations under a minute are not shown.

Each bus has an expected departure time (EDT):

```
EDT = max(scheduledDeparture, terminalArrival + minRestMinutes)
```

A bus is never expected to leave before the scheduled time or before its rest is
complete. When the rest requirement pushes the departure past the scheduled
time, the bus is shown as rest-delayed.

Every hold starts as a pending recommendation. Until it is applied it does not
affect the dispatch math; once applied it stays locked until the bus departs.
Declined, canceled, and expired recommendations never affect dispatch.

## Features

- **Terminal list** — terminals grouped by route, sorted by route number, with
  GTFS route colors.
- **Inbound buses** — scheduled vs estimated arrival, plus the next trip's
  destination and departure.
- **Laying over** — recorded vs scheduled arrival, expected vs scheduled
  departure, a live countdown, and a badge when a hold is applied.
- **Recently departed** — actual vs scheduled departure, destination, and the
  vehicle's current stop.
- **Intervention queue** — persistent hold recommendations with a reason, and
  audited apply/decline/cancel actions.
- **Debug map** — geofence circles around a terminal's stops plus color-coded
  arrows for live vehicles (inbound, arriving, laying over, departing,
  departed). Linked from each terminal view.
- **Live updates** — GTFS-Realtime polling pushed to the UI over WebSocket, with
  a polling fallback.
- **Configurable rules** — rest, hold, and lookahead parameters plus feed URLs,
  editable at runtime.

## Architecture

A single Node/TypeScript process serves the React/Vite frontend and the API. It
polls GTFS-Realtime, joins it against GTFS static data in SQLite, and
broadcasts a normalized snapshot over WebSocket.

```
[GTFS static zip] -> [SQLite static tables]
[GTFS-RT feeds] -> [RealtimeProvider] -> [Engine]
     -> [terminal snapshots + hold interventions]
     -> [REST + WebSocket] -> [React app]
```

Flow:

1. Load GTFS static into SQLite (stops, routes, trips, stop_times, calendar).
2. Poll TripUpdates and VehiclePositions on a configurable interval.
3. Match vehicles to trips, determine each bus's state at each terminal, and
   generate pending hold recommendations.
4. Serve snapshots over WebSocket (and REST for initial load and config).

All realtime/static access goes through narrow provider interfaces
(`server/src/providers/types.ts`) so the GTFS-RT adapter can be replaced with
another data source without changing the engine or UI.

## Getting started

```bash
npm install
cp .env.example .env   # set CTA_API_KEY (required for GTFS-Realtime)
npm run dev            # server on :8080, web on :5173 (proxied)
```

On first run the server downloads and loads CTA GTFS static, then starts
polling GTFS-Realtime.

### CTA data

- Static schedule: <https://www.transitchicago.com/downloads/sch_data/google_transit.zip>
- VehiclePositions: <https://transitdata.transitchicago.com/GtfsRealtime/VehiclePositions.pb>
- TripUpdates: <https://transitdata.transitchicago.com/GtfsRealtime/TripUpdates.pb>

The GTFS-Realtime endpoints (at this time) require a free API key from
<https://www.transitchicago.com/developers/>.

## Configuration

Values are editable at runtime via `PUT /api/config` and persisted in SQLite.
Environment variables only seed first-run defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `CTA_STATIC_URL` | CTA zip URL | GTFS static source |
| `CTA_VP_URL` | CTA vehicles.pb | VehiclePositions feed (keyed) |
| `CTA_TU_URL` | CTA tripupdates.pb | TripUpdates feed (keyed) |
| `CTA_API_KEY` | — | GTFS-Realtime API key (appended as `?key=`) |
| `agencyTimezone` | `America/Chicago` | IANA zone the GTFS schedule is expressed in; all service-day math is evaluated here, independent of the server's local timezone |
| `refreshIntervalSeconds` | 10 | Realtime poll interval |
| `staticRefreshHours` | 24 | Re-load static GTFS |
| `minRestMinutes` | 5 | Minimum required rest (used in EDT) |
| `maxHoldMinutes` | 10 | Ceiling on any hold |
| `leadTimeMinutes` | 5 | Evaluate a hold this far before expected departure |
| `lookaheadMinutes` | 90 | Horizon of departures to consider |
| `arrivalRadiusMeters` | 150 | Arrival geofence around a terminal stop |
| `terminalMovementMeters` | 75 | Extra tolerance so a bus can inch within the terminal |
| `stationaryDisplacementMeters` | 20 | Displacement/poll that counts as parked |
| `confirmPings` | 2 | Parked pings before an arrival is confirmed |
| `departPings` | 2 | Motion pings before a departure is confirmed |
| `scheduleArmGraceSeconds` | 120 | Grace after scheduled arrival for the schedule fallback |
| `vehiclePositionMaxAgeSeconds` | 300 | Max VP sample age allowed to create a new fact |
| `departureTriggerMeters` | 75 | Distance beyond the outbound first stop that starts departure confirmation |
| `terminals` | auto-discovered | `[{ id, name, stopIds[], routeIds[]?, radiusMeters? }]` |

Terminals are auto-discovered from GTFS as the first/last stops of routes and
can be overridden in config. A terminal can map to multiple `stop_id`s and
routes (co-located terminals); `radiusMeters` overrides the global
`arrivalRadiusMeters` for that terminal.

## API

- `GET /api/health` — liveness and last-refresh info.
- `GET /api/terminals` — terminal list grouped by route.
- `GET /api/terminals/:id?route=R` — snapshot with `incoming[]`, `layovers[]`,
  `departed[]`, `interventions[]`.
- `GET /api/terminals/:id/map` — geofence circles and live vehicle positions
  for the debug map.
- `GET /api/interventions?terminalId=T` — intervention queue for the active
  service day.
- `GET /api/interventions/:id` — one intervention and its current status.
- `POST /api/interventions/:id/view|apply|decline|cancel` — record an
  interaction or transition its status.
- `GET /api/diagnostics/vp` — read-only VP observations, transition candidates,
  recorded fact events, and feed freshness.
- `GET /api/run-events` — append-only history of recorded arrivals/departures;
  filter by `serviceDate`, `terminalId`, `type`.
- `GET /api/config`, `PUT /api/config` — read/update runtime config.
- `WS /api/ws` — pushes terminal snapshots on each refresh.

## Deployment

Designed to run as a single process on a simple hosting platform (Render,
Fly.io, Railway):

- Use a persistent disk for `DB_PATH` so the static GTFS load is not repeated on
  every boot.
- Set `CTA_API_KEY` and feed URLs via environment.
- The server's own timezone no longer matters: schedule math runs in the
  configured `agencyTimezone` (default `America/Chicago`). Changing that value
  mid-service-day shifts how recorded times compare against the schedule, so
  set it once at deployment.
- Build once, then run the server, which also serves the built frontend:

```bash
npm run build && npm start
```

Local development: `npm run dev`.

## Known limitations

- Holds are decided in a single pass and are not re-solved after being applied.
- The first and last departures in a sequence have only one neighbor and are
  never held.
- Arrival/departure facts come only from fresh VehiclePosition coordinates;
  cached, duplicate, out-of-order, or stale samples cannot trigger transitions.
- TripUpdates supply estimates (arrival, ETA) but are never treated as observed
  facts.
- Co-located multi-route terminal views and manager roles are not in scope.

## Other documentation

Detailed implementation notes and the build log live under `.agents/`
(`IMPLEMENTATION.md`, `PROGRESS.md`, `FEED_ANALYSIS.md`).
