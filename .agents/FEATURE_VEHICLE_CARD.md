# Feature spec: vehicle detail card + block strip

Status: ready for handoff. Target branch: `feat/vehicle-card-block-strip`
(cut from `main`). Read `.agents/AGENTS.md` first; its conventions
(atomic commits, zod boundaries, comment discipline, verify commands,
PROGRESS.md updates) are binding for this work.

## Goal

Selecting any bus card in the terminal view opens a detail panel with:

1. **Vehicle detail card** — a small Leaflet map with the vehicle's live
   position and heading, its upcoming stops (schedule times, marked "est"
   when a realtime prediction exists), and the run's identity/hold state.
2. **Block strip** — one horizontal timeline of the vehicle's block: one
   colored segment per trip, labeled by route / direction / destination
   (NOT the GTFS trip_id — operators do not think in trip IDs), with a
   "now" marker and the current trip highlighted.

Both are read-only projections of data the server already holds. Neither
mutates engine state, neither triggers a feed fetch.

## Feed reality (do not violate these)

Corrected after owner review 2026-09-03; the earlier FEED_ANALYSIS.md claim
that "TU carries no timing fields" was wrong for stop-level predictions (see
the addendum appended there).

- **CTA TripUpdates DO carry stop-level ETAs.** A trip's TU entity lists its
  *upcoming* stops in `stopTimeUpdates`, typically with absolute
  `arrivalTime` (delays as fallback). The feed's prediction window starts
  *after* the current stop — the current stop is not in the window, and the
  exact terminus is often missing too (see `arrivalAtTerminal` in
  `server/src/engine/headway.ts`, which already exploits this). So: the TU
  window IS the upcoming-stops list; predicted ETAs are the primary time
  source; scheduled times fill gaps only. Keep the per-stop
  `source: 'scheduled' | 'predicted'` field and never fake predictions.
- VP carries `stop_id` ~8% and `current_stop_sequence` never, so VP cannot
  refine "which stop is next" — the TU window is the authority. Only when a
  trip has no TU entity at all do we fall back to schedule-clock windowing.
- `trip_id` is present 100% on VP and matches static bus trips ~90%; block
  chains predict the realtime re-key 97%. Vehicle → block linkage via the
  tripId join is therefore reliable but must degrade gracefully for the
  unmatched ~10%.

## Part 1 — Vehicle detail

### API

`GET /api/terminals/:id/vehicles/:tripId` → `VehicleDetail` (404 when the
terminal is unknown, the trip is unknown to static, or the trip has no
presence at that terminal). Read-only over `latestRt` + the snapshot
caches, exactly like `Engine.buildMapSnapshot` (see `server/src/index.ts`
`computeTerminalMap` for the wiring pattern). Must not call
`engine.refresh` or the provider.

Resolve the vehicle for the trip the same way `buildDepartures` does:
TU vehicle assignment for the trip, else the block predecessor's, else VP
tripId inversion (see `server/src/engine/headway.ts` — reuse, do not
duplicate). Response includes whatever resolution found; `vehicleId` may
be undefined.

### DTO (shared/types.ts + zod schema `vehicleDetailSchema`)

```ts
interface VehicleDetail {
  terminalId: string;
  tripId: string;            // the run this card represents
  blockId?: string;
  vehicleId?: string;
  routeId: string;
  routeShortName: string;
  color?: string;            // GTFS route colors, passed through
  textColor?: string;
  destination: string;       // trip_ends.last_stop_name
  directionId?: number;      // 0/1; UI renders a glyph, never "0"/"1" as text
  // Live position: present only when the feed has coordinates for the vehicle.
  position?: {
    lat: number;
    lon: number;
    headingDegrees?: number; // prefer feed bearing, else implied toward/away
    observedAt: number;      // epoch seconds of the VP sample
    ageSeconds: number;      // > vehiclePositionMaxAgeSeconds => UI greys the marker
  };
  status: 'incoming' | 'layover' | 'departed';  // reuse the existing classification
  hold?: { holdSeconds: number; effectiveDeparture: number; reason: string };
  overdueSeconds?: number;   // mirror LayoverBus.overdueSeconds
  arrivalSource?: 'observed' | 'estimated';
  nextTripId?: string;       // block successor (97% accurate pre-flip)
  nextTripDestination?: string;
  upcomingStops: UpcomingStop[];  // see rules below
  passedCount: number;       // stops of this trip already behind the bus (schedule clock)
}

interface UpcomingStop {
  stopId: string;
  stopName: string;
  stopSequence: number;
  scheduled: number;        // service-day seconds
  predicted?: number;       // present only when the feed supplied timing
  source: 'scheduled' | 'predicted';
}
```

### Upcoming-stops rules

The TU prediction window is the authority for what is upcoming:

- Take the trip's TU entity and sort its `stopTimeUpdates` by
  `stopSequence`. The feed's window starts after the current stop — **keep
  it that way**: even if an update for the current stop ever appears,
  exclude it (owner decision: the card shows what is ahead, never where
  the bus is standing).
- Per stop: `predicted` = absolute `arrivalTime` when the update carries
  it, else `scheduled + arrivalDelay`; `source: 'predicted'` when either
  existed. An update with no timing, or a stop missing from the window,
  fills from `stop_times` with `source: 'scheduled'`. Join static
  `stop_times`/`stops` for names and scheduled times.
- `passedCount` = first window entry's `stopSequence - 1` (clamped at 0).
- Return up to **8** stops.
- Fallback when the trip has no TU entity at all: schedule-clock
  windowing — first stop whose scheduled time is at or after
  `nowSvc - 120` (grace), up to 8 stops, all `source: 'scheduled'`,
  `passedCount` = stops before that point.
- `nowSvc` uses the configured `agencyTimezone` (see `gtfs/time.ts`) —
  never `Date` local getters.

### Engine module

New file `server/src/engine/vehicleDetail.ts` with a pure builder
`buildVehicleDetail(deps)` plus a thin `Engine.vehicleDetail(terminalId,
tripId, snapshot, rt)` wrapper that supplies the caches (tripEnds,
blockChains, stopNames, routeStyle) — same cache discipline as
`buildMapSnapshot`. Use `db/prepare.ts` for any new SQL. Do not add
mutating state to the Engine for this.

## Part 2 — Block strip

### API

`GET /api/blocks/:blockId` → `BlockTimeline` (404 for unknown block).
Service-date scoped by the active service date, like the queue reads.

### DTO (`blockTimelineSchema`)

```ts
interface BlockTimeline {
  blockId: string;
  serviceDate: string;
  nowSvc: number;
  trips: BlockTrip[];        // ordered by block seq
}

interface BlockTrip {
  tripId: string;            // internal; UI must not display it as the label
  routeId: string;
  routeShortName: string;
  color?: string;
  textColor?: string;
  directionId?: number;
  destination: string;       // last stop name; primary label
  start: number;             // service-day seconds (trip_ends.first_departure)
  end: number;               // service-day seconds (trip_ends.last_arrival)
  state: 'past' | 'current' | 'future';   // vs nowSvc
  departedSeconds?: number;  // observed departure fact when recorded (ledger)
  held?: boolean;            // departure happened under an applied hold
}
```

- Block membership: `block_trips` ordered by `seq` for the requested
  `block_id`, restricted to the active service ids (same filter
  `buildBlockChains` uses).
- `state`: a trip is `current` when `start <= nowSvc < end`; `past`
  earlier, `future` later. If a recorded departure fact exists for the
  `current` window, keep `current` (the bus is between departure and the
  far end even if late).
- The UI finds the block for a selected vehicle via
  `VehicleDetail.blockId`; the strip request is separate so it can be
  cached/refetched independently.

### Web components

- `web/src/components/BlockStrip.tsx`: **pure SVG**, no Leaflet. One row;
  x-axis = service-day seconds spanning `[firstStart, lastEnd]` padded 10
  min; each trip = a rounded rect labeled per the color/label rules below;
  a vertical "now" line; the trip in its `current` window gets a stronger
  stroke; observed departure facts render a small tick. Horizontal scroll
  when the block is long; min segment width so short trips stay clickable
  (title tooltip carries the full label).

#### Color and labeling rules (block strip)

Color alone cannot identify a trip — GTFS route colors repeat across the
system — so the strip layers three identifiers:

1. **Route number, prominently.** The label leads with the route number,
   bold and large (route `shortName`); the destination is secondary and
   smaller. When a segment is narrower than the full label, show the
   number alone and move the destination into the tooltip. The number is
   the primary identifier and must never be truncated away.
2. **Direction via a deterministic shade transform on the GTFS color.**
   `directionId 0` renders the route color as-is; `directionId 1` renders
   the same hue mixed ~40% toward white (or ~25% toward black when the
   base color is already very light, luma > 200 by the helper below). One
   transform, applied identically to every segment, so same-color routes
   still read as different trips once direction differs. Add a small
   legend chip in the strip header ("solid / tinted" mapped to the
   agency's meaning of 0/1) rather than trusting operators to know GTFS
   direction ids.
3. **Text contrast recomputed on the shaded variant.** Extract
   `readableOn` from `web/src/components/RouteBadge.tsx` into a shared
   `web/src/routeColor.ts` util (RouteBadge refactored to use it, no
   behavior change) providing `readableOn(hex)`, `shadeForDirection(hex,
   directionId)`, and GTFS `#` normalization. BlockStrip picks text color
   with `readableOn` on the *final* shaded background; `textColor` from
   GTFS only applies to the unshaded variant.

The direction glyph from `directionId` stays as a non-color cue (aria
labeled) for accessibility and monochrome reading.
- Vehicle card map: extend the existing map primitives from
  `web/src/pages/TerminalMap.tsx` — extract the rotated-SVG `L.divIcon`
  arrow into a shared component/helper rather than copy-pasting it. The
  mini map shows: vehicle arrow (grey when `ageSeconds` is stale),
  the trip's stop dots (upcoming = filled, passed = hollow), and the
  terminal stop. Tiles from OSM as the existing map does. No geofence
  circles here.
- Selection UX in `web/src/pages/TerminalView.tsx`: clicking a
  `BusCard`/`LayoverCard`/`DepartedCard` toggles selection (selected card
  gets a visible outline); the detail panel renders below the selected
  route group (mobile-first, no modals). Poll the detail endpoint every
  10 s while open (match `TerminalMap`'s polling pattern), fetch the
  block strip once per selection unless `blockId` changes. Close button
  clears selection. Cards need an `onClick` + the tripId they represent
  — `BusCard` uses `nextTripId` (the run being formed), layover/departed
  use `tripId`.
- `web/src/api.ts`: `getVehicleDetail(terminalId, tripId)` and
  `getBlockTimeline(blockId)` through the existing `request()` + zod
  pattern. 404 → surface "no live data for this run" in the panel, not
  an error state.

## Edge cases the implementation must handle

- Trip not matched in static (~10% of live tripIds): 404 from the detail
  endpoint; card click shows the empty state. Do not crash on missing
  joins.
- No vehicle assigned (tripId-only cards): detail renders without the
  map; stops still show from the schedule.
- Departed trips: position usually still present (bus is on the road);
  `upcomingStops` derived the same way, UI labels the header "departed".
- Blocks crossing midnight: all times are service-day seconds; the strip
  is one service day, matching app convention.
- Stale VP (age > `vehiclePositionMaxAgeSeconds`): keep the marker,
  grey it, show `ageSeconds` ("last seen 4 min ago").
- Trip with > 8 remaining stops: `passedCount` + cap, as specified.

## Testing / definition of done

1. Engine unit tests (`server/src/engine/vehicleDetail.test.ts`, using
   `syntheticGtfs` fixtures): a TU window with absolute `arrivalTime`s
   (proves `predicted` + `source: 'predicted'`), a TU with timing on only
   some stops (mixed sources, schedule fill for the rest), a TU that
   includes the current stop (assert it is excluded per the rule above),
   a trip with no TU entity (schedule fallback incl. the 120 s grace),
   the 8-stop cap and `passedCount`, unmatched trip, no-vehicle trip.
2. Block strip builder tests: ordering, `state` windows, observed
   departure fact + `held` propagation, unknown block.
3. `server/src/api/routes.test.ts`: endpoint contracts (200 + zod-valid
   body, 404s for unknown terminal/trip/block).
4. Unit tests for the color util (`shadeForDirection`, `readableOn`
   boundary cases incl. very light bases and `#`-less inputs).
5. `npm run typecheck`, `npm run lint`, `npm test` all green; run the
   suite once with `TZ=America/New_York` to confirm zone independence.
6. Manual smoke on `npm run dev`: select an inbound, layover, and
   departed card; verify map, stops, strip, empty states; verify two
   same-color routes with opposite directions render visibly distinct
   segments with legible numbers.
7. Update `README.md` API section and `PROGRESS.md` (dated entry) in the
   same commits as the code they describe. Atomic commits: server DTO +
   endpoint; engine builder; web card selection + detail; block strip;
   docs can ride with their code.

## Out of scope (explicitly)

- Realtime ETA estimation beyond pass-through of feed predictions.
- Multi-day / whole-route block views; interlining editor.
- Any change to the dispatch math, ledger, or intervention lifecycle.
- Browser-level component tests (no infra yet — manual smoke instead).
