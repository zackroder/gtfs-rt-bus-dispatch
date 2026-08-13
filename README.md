# Bus Dispatch Pilot

A mobile-friendly web app for bus terminal dispatching. It joins GTFS static
schedule data with GTFS-Realtime (VehiclePositions + TripUpdates) to detect
off-schedule buses, then recommends simple "hold" interventions so a terminal
manager can tell an operator to hold their bus and smooth headways.

## Problem

At a bus terminal, consecutive outbound departures on a route should be evenly
spaced (regular headways). In practice:

- The **leader** is at the terminal, ready to depart on its next outbound trip.
- Its **follower** is still inbound and running late. The follower will be late
  for *its* outbound trip, even after its mandatory minimum rest.

If the leader departs on time, the gap behind it becomes huge (a "gap" in
service). If we hold the leader for part of the follower's lateness, we split
the delay across both buses and keep headways more even.

## Features

- **Terminal selector** — pick a terminal, grouped/sorted by route.
- **Incoming view** — buses inbound to the terminal with ETA and delay.
- **Layover view** — buses currently resting at the terminal with their
  scheduled departure time and a live **min:sec countdown** (hold overrides
  shown as a badge).
- **Interventions** — recommended holds ("hold vehicle X until hh:mm") with a
  human-readable reason, surfaced 5+ minutes before the leader's departure.
- **Live refresh** — regular GTFS-RT polling, pushed to the UI over WebSocket.
- **Configurable rules** — rest minimum, hold fraction, max hold, lead time,
  thresholds, feed URLs/keys.

## Intervention rules

All rules run on the ordered set of outbound departures for a route at a
terminal, pairing each departure with the vehicle operating it (via GTFS
`block_id` trip chaining + realtime trip assignment).

Both hold rules are the same mechanism — intentionally delaying a bus at the
terminal — targeted at different buses depending on which direction the
headway error runs:

| Condition | Problem | Action |
| --- | --- | --- |
| follower late | service gap (headway too big) | hold **leader** |
| follower early / leader late | bunching (headway too small) | hold **follower** |

Leader hold sacrifices an on-time leader's punctuality to split the follower's
lateness across two gaps; follower hold delays a bus that is ready to depart
so it doesn't platoon. Thresholds are relative to each pair's **scheduled
headway** `H = F_d - L_d`, so they scale with route and time of day:

```
P = predicted_depart(follower) - predicted_depart(leader)   # predicted headway
if P > gap_factor   * H -> hold leader   by min(hold_fraction * (P - H), max_hold)
if P < bunch_factor * H -> hold follower by min(bunch_factor * H - P,  max_hold)
```

If the leader has already departed, a gap can no longer be fixed by holding —
that downgrades to a passive gap alert (rule 3).

### 1. Hold leader (headway smoothing) — primary

For a leader/follower pair with scheduled departures `L_d` and `F_d`:

1. Follower lateness: `P - H = predicted_departure(follower) - F_d`.
2. If `P > gap_factor * H` (a real gap is opening) and
   `now >= L_d - lead_time` and the leader is physically at the terminal:
   - `hold = min(hold_fraction * (P - H), max_hold)`.
   - Recommend: "Hold leader until `L_d + hold`".
3. Reason: splitting the follower's lateness across both buses smooths the
   headway instead of letting a gap form behind the leader.

### 2. Hold follower (anti-bunching)

If `P < bunch_factor * H` (the follower is early relative to the leader, or the
leader was held/delayed so the follower catches up), recommend holding the
follower by `min(bunch_factor * H - P, max_hold)`.

### 3. Gap alert (passive)

If a gap exceeds `gap_factor * H` but the leader has already departed (so it
can no longer be held), flag the gap so a manager can consider inserting a
spare. No automatic hold is issued.

### 4. Minimum-rest advisory (passive)

If a bus's predicted layover at the terminal is less than `min_rest`, surface a
warning that the operator may depart without the required rest.

## Countdown timer

Every bus laying over at a terminal shows a live **min:sec countdown** to its
next trip's *scheduled* departure (from its `block_id` chain), color-coded:
green (on track), amber (within lead time), red (overdue). A bus under an
active hold shows the hold as an explicit badge on top of the scheduled time —
e.g. `held +2:30 -> departs 14:32` — so on-time tracking and hold
recommendations stay visually distinct. This lets a manager both nudge
operators toward on-time departures and act on holds in the same view.

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
```

Key flows:

1. **Load static** — download/unzip GTFS, parse `stops`, `routes`, `trips`,
   `stop_times`, `calendar`, `calendar_dates` into SQLite. Derive
   `block_trips` (trip chains per `block_id`).
2. **Poll realtime** — fetch TripUpdates + VehiclePositions every
   `refresh_interval_seconds`, decode protobuf into normalized DTOs.
3. **Join** — match vehicles to trips to blocks. For each terminal/route,
   determine which buses are inbound vs laying over, compute predicted
   departures, and run the hold rules.
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
| `min_rest_minutes` | 5 | Mandatory operator rest |
| `gap_factor` | 1.5 | Gap threshold as a multiple of scheduled headway |
| `bunch_factor` | 0.5 | Bunch threshold as a multiple of scheduled headway |
| `hold_fraction` | 0.5 | Fraction of excess lateness to hold the leader |
| `max_hold_minutes` | 10 | Absolute ceiling on any hold |
| `lead_time_minutes` | 5 | Warn this far before leader departure |
| `lookahead_minutes` | 90 | Horizon of departures to consider |
| `terminals` | auto-discovered | `[{ id, name, stop_ids[], route_ids[]? }]` |

Terminals are auto-discovered from GTFS (stops that are a route's first/last
stop) and can be curated via config or the UI. A terminal may map to multiple
`stop_id`s and routes (co-located terminals).

## API

- `GET /api/health` — liveness + last refresh.
- `GET /api/terminals` — terminal list grouped by route.
- `GET /api/terminals/:id?route=R` — `{ incoming[], layovers[], interventions[], generated_at }`.
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

- Hold propagation across multiple pairs is computed independently (no
  iterative re-solve). Refine in a later phase.
- ETA from VehiclePositions (when TripUpdates lack a terminal prediction) is a
  simple delay-based estimate.
- Multiple-route co-located terminal view is a future UI feature (data model
  already supports it).
- Service-day start is auto-detected from GTFS stop_times (see `gtfs/time.ts`);
  after-midnight (`24:00:00+`) trips are normalized to that clock.
- Auth/roles for managers is out of scope for the pilot.
