# PROGRESS

Implementation plan and status. Check off items as they are completed. Update
this file (and the decisions log) after finishing any milestone.

## Status

- [x] Phase 0 — Repo scaffolding
- [x] Phase 1 — GTFS static ingestion
- [x] Phase 2 — GTFS-RT ingestion + provider abstraction
- [ ] Phase 3 — Join engine (terminal + headway + interventions)
- [ ] Phase 4 — API + WebSocket
- [ ] Phase 5 — Web frontend
- [ ] Phase 6 — Config UI + deployment polish

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

- [ ] `server/src/engine/terminal.ts` — resolve a terminal: which trips
      depart/arrive at its `stop_id`s, per route (first/last stop detection).
- [ ] `server/src/engine/headway.ts` — ordered outbound departures for a
      route/terminal in the lookahead window; assign vehicles via
      block trip chaining + realtime trip assignment; classify each as
      `layover` vs `incoming`; compute scheduled headway `H` per pair.
- [ ] Predicted departure: from TripUpdate terminal stop prediction, else
      `max(predicted_arrival, now) + min_rest`.
- [ ] `server/src/engine/interventions.ts` — unified headway rule using
      scheduled headway per pair: `P > gap_factor*H` -> hold leader;
      `P < bunch_factor*H` -> hold follower; plus gap alert + min-rest
      advisory. Emit `Intervention` DTOs with `hold_minutes`, `reason`,
      `expires_at`.
- [ ] `server/src/engine/engine.ts` — orchestrates refresh -> normalized
      `TerminalSnapshot` for each configured terminal.
- [ ] Tests: synthetic schedule + synthetic realtime fixtures for each rule
      (incl. lead-time window, max-hold cap, below-threshold no-op).

## Phase 4 — API + WebSocket

- [ ] `server/src/config.ts` — load/save runtime config in SQLite
      `settings` table; zod validation; seed from env.
- [ ] `server/src/api/routes.ts` — `/api/health`, `/api/terminals`,
      `/api/terminals/:id`, `/api/config` (GET/PUT).
- [ ] `server/src/api/ws.ts` — broadcast snapshots on each refresh tick;
      client subscribe by terminal.
- [ ] Wire refresh scheduler: on tick -> poll provider -> run engine ->
      persist snapshot -> WS broadcast.

## Phase 5 — Web frontend

- [ ] `web/` Vite + React + TS, mobile-first layout.
- [ ] `web/src/api.ts` — REST client + WS client with polling fallback.
- [ ] `web/src/pages/Terminals.tsx` — terminal list grouped by route.
- [ ] `web/src/pages/TerminalView.tsx` — incoming (ETA), layovers
      (scheduled departures + hold badges), interventions (action cards).
- [ ] Layover countdown: `Countdown` component (min:sec to scheduled
      departure, green/amber/red states) + hold-override badge on held buses.
- [ ] Components: `BusCard`, `InterventionCard`, `RouteGroup`,
      `Countdown`; `hooks/useStream.ts`.
- [ ] Wire to `/api` + WS; last-updated + data-source status in header.

## Phase 6 — Config UI + deployment polish

- [ ] Settings page for rule params + terminals curation + feed URLs/keys.
- [ ] `npm run build && npm start` serving static bundle.
- [ ] Deployment notes verified on Render/Fly/Railway (persistent disk,
      env config).
- [ ] Optional: manual "reload static" trigger endpoint.

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

## Next steps

1. Phase 0 scaffolding (workspaces, toolchain, shared types).
2. Phase 1 static ingestion with synthetic fixtures.
