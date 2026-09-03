# Live CTA VP Feed Analysis — arrival/departure recording feasibility

> **Correction (2026-09-03, owner review):** the PROGRESS 2026-08-16 note and
> one reading of this file claimed "TU carries no timing fields at all
> (0/6115 entities)". That is wrong as a general statement: live CTA
> TripUpdates DO carry stop-level predictions — `stopTimeUpdates` list the
> upcoming stops with absolute `arrivalTime` (delays as fallback), excluding
> the current stop and often the exact terminus. `arrivalAtTerminal` in
> `server/src/engine/headway.ts` is built on exactly that behavior (it
> extends the latest carried stop's prediction by scheduled travel time).
> The 0/6115 measurement was most likely scoped to terminus updates only or
> an anomalous capture. Re-measure before citing it; do not design around
> "no TU timing".

Captured 2026-08-16 (Sunday) ~18:xx Chicago time. 8 polls at ~30s intervals over
~3.5 minutes of the live VehiclePositions feed (with the configured `CTA_API_KEY`).
Static reference: `data/gtfs.zip` (bus-only, 90,405 trips, 86 routes). Throwaway
capture script at `%TEMP%/opencode/vp_capture.cjs` (not part of the repo).

## Findings

### 1. VP almost never carries stop identity — the current engine is starved

Across three captures (Sun), only **~8.3%** of VP observations carry a `stop_id`,
and **`current_stop_sequence` is never populated (0.0%)**. The existing
arrival/departure machinery (`engine.ts recordFacts`: `at_last_stop`,
`past_first_stop`) is stop-matched, so ~92% of VP data can never trigger a
transition by that path — and the sequence-based half of it is doubly dead
because CTA never sends the sequence at all. This is the most likely reason
recording "hasn't worked at all."

Also: `current_status` is populated on 100% of entities but is **always
`IN_TRANSIT_TO`; `STOPPED_AT` is never observed** (0 within 600 m of a
terminus), so the status field is not usable as an arrival trigger either.

### 2. `trip_id` and `lat/lon` are present 100% of the time

- with tripId: 6,263 / 6,263 (100.0%)
- with lat/lon: 6,263 / 6,263 (100.0%)
- distinct VP tripIds: 841; matched in static bus trips: 757 (**90.0%**)
- unmatched sample: `92275546881`, `92275546368`, `92275547041`, … (a different
  ID namespace; not present as bus trips in this static snapshot)

So a vehicleId + tripId + position model is viable, and the tripId join works
for ~9 in 10 vehicles. The 10% that don't match static are invisible to any
static-join logic today (block chains, trip ends, stop-times).

### 3. The feed holds the inbound tripId through the layover; flips are late-but-certain

- **113 vehicles lingered** near their own trip's terminus on the SAME tripId for
  the whole capture window (no re-key at all).
- **37 vehicles re-keyed** to a different trip; **36/37** flipped to a trip whose
  start is within 600 m of the old trip's terminus (same terminal), and
  **28/37** did so after a stationary/resting period.
- When a flip did come, the vehicle had been resting a median of **3 polls
  (~90 s)** and max **6 polls (~180 s)** before re-key.

Implication: the flip is a *certain* arrival signal (it can only happen once the
bus is at the terminal and reassigned) but arrives *after* the bus is already
sitting — consistent with the earlier "certain but late" concern.

### 4. Resting distance from the terminus is spread wide — a tight buffer would miss most layovers

Re-measured (2026-08-16, second capture) against the corrected anchor — **stop 1
of the next outbound trip** (block-chain-derived), for 451 resting samples at a
terminal:

```
min 3m  p25 40m  median 72m  p75 313m  max 657m
within 30m: 62 (14%)   within 60m: 190 (42%)   within 100m: 261 (58%)
```

Caveat on the proposed **100–200 ft (30–60 m) buffer**: at 60 m it captures only
~42% of actually-laying-over buses. Buses stage/park well past the outbound
stop. Keep the radius configurable with a per-terminal override, using a tight
radius as a *confirmation* signal combined with proximity + stationarity rather
than the sole arrival criterion.

### 5. `block_id` predicts the realtime re-key 97% of the time

34 realtime tripId flips observed in the window; comparing each flip target to
the static block-chain next trip:

```
exact tripId match: 33 (97%)
same route only:    1 (3%)
different route:    0 (0%)
no static block-next: 0 (0%)
```

Specific examples:
```
#8098 rt 6800000371010 -> 6800027030010 | static-next 6800027030010 | EXACT
#1593 rt 6800022108010 -> 6800000053010 | static-next 6800000053010 | EXACT
#1261 rt 6800038040010 -> 6800005368010 | static-next 6800005368010 | EXACT
#7946 rt 6800036440010 -> 6800002611010 | static-next 6800002611010 | EXACT
#1115 rt 6800038145010 -> 6800000421010 | static-next 6800031693010 | route-same (only non-exact flip)
```

Implication: static `block_id` chains are a reliable *prediction* of the next
trip, and the realtime flip *confirms* it. The observed flip can upgrade the
static prediction from "expected" to "observed/confirmed," but the static chain
alone is trustworthy enough to know T_next ahead of time (needed for the
proximity arm and for EDT before the flip fires).

## Raw examples (audit trail)

### Linger without re-key (same tripId the whole window)

```
bus #1334 route 82 trip 6800018082010 terminus 12950
  t+0s  trip=6800018082010 pos=41.83694,-87.72119 dist2end=293m
  t+30s trip=6800018082010 pos=41.83693,-87.72200 dist2end=226m
  t+60s trip=6800018082010 pos=41.83688,-87.72501 dist2end=25m
  t+90s trip=6800019460010 pos=41.83686,-87.72539   <- re-key here (55m from old terminus)
  t+121s trip=6800019460010 ... dist from OLD end growing as it pulls out
  dist values after t+90s are to the NEW trip's terminus (far end) — not meaningful.
```

```
bus #1110 route 18 trip 6800023789010 terminus 16140 (approaches, arrives, holds)
  t+0s  dist2end=440m   (still approaching)
  t+90s dist2end=106m
  t+151s dist2end=56m
  t+181s dist2end=22m
  t+211s dist2end=32m   -- resting at terminus, STILL same tripId at end of window
```

```
bus #1470 route 55 trip 6800007591010 terminus 14122
  t+0s  dist2end=291m
  t+90s dist2end=40m
  t+121s trip=6800034433010   <- re-key ~30-60s after reaching ~40m from terminus
  (rests ~3 polls before re-key; flip lag is visible in raw timestamps)
```

```
bus #1344 route 75 trip 6800028188010 terminus 10851
  t+0s..t+121s identical pos=41.76062,-87.55711 dist2end=152m (fully stationary 4 polls)
  t+151s trip=6800028994010 pos=41.75986,-87.55863   <- re-key after ~2 min stationary
```

```
bus #7911 route 43 trip 6800047734010 -> 6800038729010 (old-end dist 11m at flip)
  moving inbound, flips at 11m from old terminus while still moving — prompt flip case
```

### Flip while resting (late confirmation)

```
bus #7930 6800009343010 -> 6800028098010 (old-end dist 8m at flip)
  t+0s..t+121s identical pos=41.80460,-87.70454 (stationary 5 polls)
  t+151s trip flipped; pos barely moves — re-key while parked at the terminal
```

## What the flip numbers are NOT

The FLIP raw dumps above print `dist2end` relative to the *new* trip's terminus
(the far end of the route), which looks like a 10–19 km jump. Use
`nearOwnTerminalMeters` (distance from the pre-flip positions to the OLD trip's
terminus) for anything about terminal proximity.

## Open items before finalizing the plan

1. Confirm the ~10% unmatched VP tripIds are truly absent from static (not
   Sunday-service or snapshot-vs-feed skew) — they bypass all static joins today.
   Affects fewer than 11 fps of vehicles in the capture.
2. Buffer sizing **anchored to stop 1 of the next outbound trip** (this run:
   median 72 m, 58% within 100 m). A 100–200 ft default alone misses ~half of
   layovers; a ~100–150 m default + per-terminal override matches observed
   staging geometry, with a tight radius usable as a confirmation signal.
3. Flip lag median ~90 s — distance/proximity timing should drive EDT/layover
   `arrivalSeconds`; the flip upgrades the fact source (estimate → observed).
4. `current_status` is always `IN_TRANSIT_TO` — do not rely on it as an arrival
   signal; treat it as noise for transition detection.
5. `block_id` predicts re-key target 97% → static chains can pre-identify T_next;
   the realtime flip is the confirmation/upgrade, not the source of linkage.