# Bus Dispatch Pilot

A mobile-friendly web app for bus terminal dispatching. It joins GTFS static
schedule data with GTFS-Realtime (VehiclePositions + TripUpdates) to detect
off-schedule buses, then recommends simple "hold" interventions so a terminal
manager can tell an operator to hold their bus and smooth headways.

## Problem

At a bus terminal, consecutive outbound departures on a route should be evenly
spaced (regular headways). In practice, inbound trips arrive unevenly, so a
bus's *expected* departure drifts from its schedule.

If every bus departs strictly on schedule (or as soon as its rest is up), a late
bus leaves a large gap behind it and the buses behind it bunch up. We smooth
this by holding the **middle** bus of each triplet for half the difference
between its two adjacent headways — spreading the delay across multiple gaps
rather than letting it pile into one.

## Features

- **Terminal selector** — pick a terminal, grouped/sorted by route number, with
  each route shown as a GTFS-colored badge and name.
- **Inbound view** — buses inbound to the terminal showing scheduled vs
  estimated arrival (red when late) and the next trip's destination/departure.
- **Layover view** — buses resting at the terminal showing recorded vs
  scheduled arrival (red when late), expected vs scheduled departure, a live
  **min:sec countdown**, and a hold badge when held.
- **Recently departed** — buses that just left, with actual vs scheduled
  departure time (purple when a hold was applied), their destination, and the
  stop they're currently at (from VehiclePositions).
- **Intervention queue** — persistent recommended holds ("hold vehicle X until
  hh:mm") with a human-readable reason. Managers can view, apply, decline, or
  cancel them; every interaction is audited.
- **Live refresh** — regular GTFS-RT polling, pushed to the UI over WebSocket.
- **Configurable rules** — minimum rest, maximum hold, lead time, lookahead,
  feed URLs/keys.

## How dispatch decisions work

We reason in terms of **triplets** of consecutive outbound departures at a
terminal, and make the decision for the **middle** bus from its two adjacent
headways.

### Expected departure time (EDT)

Every bus has an **expected departure time** — the earliest moment it should
leave the terminal:

```
EDT = max(scheduledDeparture, terminalArrival + minRestMinutes)
```

- `terminalArrival` is the bus's *observed* arrival at the terminal from
  VehiclePositions. While inbound, TripUpdates provide an estimate instead.
- If arrival + mandatory rest leaves room before the scheduled departure, the
  bus waits and departs on schedule. Otherwise it departs late: `EDT >
  scheduled`, and the bus is **rest-delayed**.

### Triplets and headways

For three consecutive buses — **leader** (earliest), **center**, and
**follower** (latest) — measure two headways:

```
H_f = center − leader     # forward headway (gap ahead, toward the leader)
H_b = follower − center   # backward headway (gap behind, toward the follower)
```

```
        H_f (ahead)             H_b (behind)
   ┌────────────┐   ┌────────────┐   ┌────────────┐
   │   leader   │   │   center   │   │  follower  │
   └────────────┘   └────────────┘   └────────────┘
        L                  C                  F
        └─ center − leader ─┘└─ follower − center ─┘
```

The leader's time is its *actual* recorded departure once it has left (else its
EDT); the center's and follower's are their EDTs.

### The hold

About `leadTimeMinutes` before the center's *expected* departure, evaluate the
triplet and hold the center by:

```
hold = min( max((H_b − H_f) / 2, 0), maxHoldMinutes )
```

- The inner `max(…, 0)` only delays — it never dispatches a bus early.
- The outer `min(…, maxHoldMinutes)` caps any hold at the configured ceiling.

Holding the center delays it, shrinking the gap to its follower while widening
the gap to its leader — exactly what evens the two headways when `H_b > H_f`.
Once generated, a recommendation is **pending** and does not affect dispatch
math. After the manager applies it, the hold is locked until the bus departs;
the applied departure feeds forward as the *leader* reference for the next
triplet. Declined, canceled, and expired recommendations never affect dispatch.

Holds are rounded to 30-second increments, and recommendations under one minute
are suppressed. This deliberately minimizes *excess* wait: equalizing adjacent headways spreads
a given lump of delay across more passengers instead of letting it pile into a
single gap.

### Example

Scheduled departures `1:00, 1:10, 1:20, 1:30`; inbound trips finish late, so
the initial EDTs are `1:05, 1:12, 1:23, 1:30` (buses 1–4):

1. **Bus 2** (center, EDT `1:12`): leader bus 1 departed `1:05`; follower bus 3
   EDT `1:23`. So `H_f = 1:12 − 1:05 = 7` and `H_b = 1:23 − 1:12 = 11`.
   Hold `(11 − 7)/2 = 2` minutes → bus 2 departs `1:14` (headways now `9`/`9`).
2. **Bus 3** (center, EDT `1:23`): leader bus 2 now departs `1:14`; follower
   bus 4 EDT `1:30`. So `H_f = 1:23 − 1:14 = 9` and `H_b = 1:30 − 1:23 = 7`.
   Hold `max((7 − 9)/2, 0) = 0` → bus 3 departs on time `1:23`.

Bus 1 (first) and bus 4 (last) have no neighbor on one side, so they are never
held by this rule.

## Countdown timer

Every bus laying over at a terminal shows a live **min:sec countdown** to its
*effective* departure time (held `until` if held, else EDT), color-coded green
(on track), amber (within lead time), red (overdue). Cards show scheduled and
actual times side by side: the layover's recorded terminal arrival against its
scheduled arrival (red when late), its expected departure against the
scheduled one, and a held bus shows the hold as an explicit badge — e.g.
`held +2:30 → departs 14:32`. Inbound buses show scheduled vs estimated arrival
(no countdown) and recently-departed buses show actual vs scheduled departure,
with the departure in purple when it left under a hold.

## Architecture

Single Node/TypeScript process: Express API + WebSocket server + a polling
scheduler. It serves the built React/Vite frontend as static files and holds
everything in SQLite (GTFS static tables + runtime config). The computed
snapshot lives in memory and is rebroadcast on every refresh tick.

```
[GTFS static .zip] --load--> [SQLite static tables]
[GTFS-RT protobuf] --poll--> [RealtimeProvider] --normalize-->
    [Engine: join realtime + static -> terminal snapshots + interventions]
       --> [REST + WebSocket] --> [React web app]
                 ^
       [SQLite intervention queue + audit events]
```

Key flows:

1. **Load static** — download/unzip GTFS, parse `stops`, `routes`, `trips`,
   `stop_times`, `calendar`, `calendar_dates` into SQLite. Derive
   `block_trips` (trip chains per `block_id`).
2. **Poll realtime** — fetch TripUpdates + VehiclePositions every
   `refresh_interval_seconds`, decode protobuf into normalized DTOs.
3. **Join** — match vehicles to trips to blocks. For each terminal/route,
    determine which buses are inbound vs laying over, compute predicted
    departures, and create pending hold suggestions. Only applied suggestions
    enter the dispatch ledger.
4. **Serve** — REST for initial state + config, WebSocket for live snapshots.

### Data source abstraction

To allow pivoting to a proprietary database later, all realtime/static access
goes through narrow interfaces (`RealtimeProvider`, `StaticProvider` in
`server/src/providers/types.ts`). The GTFS-RT adapter is the default
implementation. A proprietary adapter would implement the same interface and be
selected via config, with no changes to the engine or UI.

## Getting started

```bash
npm install
cp .env.example .env   # add your CTA_API_KEY (required for GTFS-RT)
npm run dev            # server on :8080, web on :5173 (proxied)
```

The server auto-downloads and loads CTA GTFS static on first run, then starts
polling GTFS-RT.

### CTA data

- Static (schedule): https://www.transitchicago.com/downloads/sch_data/google_transit.zip
- Realtime VehiclePositions: https://transitdata.transitchicago.com/GtfsRealtime/VehiclePositions.pb
- Realtime TripUpdates: https://transitdata.transitchicago.com/GtfsRealtime/TripUpdates.pb

The GTFS-RT endpoints require an API key (free from
https://www.transitchicago.com/developers/). Put it in `.env` as
`CTA_API_KEY` — the server appends `?key=` — and never commit it.

## Configuration

Most values are editable at runtime via `PUT /api/config` and persisted in
SQLite. Env vars only seed the initial defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `CTA_STATIC_URL` | CTA zip URL | GTFS static source |
| `CTA_VP_URL` | CTA vehicles.pb | VehiclePositions feed (keyed) |
| `CTA_TU_URL` | CTA tripupdates.pb | TripUpdates feed (keyed) |
| `CTA_API_KEY` | — | Required; GTFS-RT API key (appended as `?key=`) |
| `refresh_interval_seconds` | 10 | Realtime poll interval |
| `static_refresh_hours` | 24 | Re-load static GTFS |
| `min_rest_minutes` | 5 | Mandatory operator rest (used in EDT) |
| `max_hold_minutes` | 10 | Absolute ceiling on any hold |
| `lead_time_minutes` | 5 | Evaluate a hold this far before expected departure |
| `lookahead_minutes` | 90 | Horizon of departures to consider |
| `terminals` | auto-discovered | `[{ id, name, stop_ids[], route_ids[]? }]` |

Terminals are auto-discovered from GTFS (stops that are a route's first/last
stop) and can be curated via config or the UI. A terminal may map to multiple
`stop_id`s and routes (co-located terminals).

## API

- `GET /api/health` — liveness + last refresh.
- `GET /api/terminals` — terminal list grouped by route.
- `GET /api/terminals/:id?route=R` — `{ incoming[], layovers[], interventions[], generated_at }`.
- `GET /api/interventions?terminalId=T` — persistent intervention queue for the active service day.
- `GET /api/interventions/:id` — one intervention and its current status.
- `POST /api/interventions/:id/view|apply|decline|cancel` — record an interaction or transition its status.
- `GET /api/diagnostics/vp` — read-only latest Vehicle Position observations,
  transition candidates, recorded fact events, and feed freshness/errors.
- `GET /api/config`, `PUT /api/config` — read/update runtime config.
- `WS /api/ws` — pushes terminal snapshots on each refresh tick.

## Deployment

Designed to run as a single process, easily deployable to simple hosting
platforms (Render, Fly.io, Railway):

- Provide a persistent disk (for `DB_PATH`) so the static GTFS load isn't
  redone every boot (or enable remote/object-storage static path later).
- Set `CTA_API_KEY` and feed URLs via environment.
- `npm run build && npm start` runs the server which also serves the built web
  bundle.

Local testing: `npm run dev`.

## Known limitations / future work

- Hold suggestions are decided in a single left-to-right pass. They remain
  pending until explicitly applied; an applied hold is not re-solved even if
  conditions change before departure.
- Observed arrival/departure facts are persisted in SQLite by service date;
  applied intervention state and its audit history are persisted alongside
  them.
- Actual arrival/departure facts are recorded only from VehiclePositions
  (vehicle observed at a trip's terminal stop, sequence advancing past the
  first stop, or a tripId flip). TripUpdates remain predictions and are labeled
  as estimated when used for EDT inputs.
- The first and last departures in a route have no neighbor on one side and are
  never held by the triplet rule.
- ETA when TripUpdates lack a terminal prediction is a simple delay-based
  estimate.
- Multiple-route co-located terminal view is a future UI feature (data model
  already supports it).
- Service-day start is auto-detected from GTFS stop_times (see `gtfs/time.ts`);
  after-midnight (`24:00:00+`) trips are normalized to that clock.
- Auth/roles for managers is out of scope for the pilot.
