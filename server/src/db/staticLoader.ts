import type { Database } from 'better-sqlite3';
import type { ParsedStaticGtfs } from '../providers/types';
import { normalizeServiceSeconds } from '../gtfs/time';

export function deriveBlockTrips(db: Database): void {
  db.exec(`DELETE FROM block_trips`);
  const tripRows = db
    .prepare(`SELECT trip_id, route_id, block_id FROM trips WHERE block_id IS NOT NULL`)
    .all() as Array<{ trip_id: string; route_id: string; block_id: string }>;
  const firstDepartures = db
    .prepare(`SELECT trip_id, MIN(departure_time) AS dep FROM stop_times GROUP BY trip_id`)
    .all() as Array<{ trip_id: string; dep: number }>;
  const departureByTrip = new Map<string, number>();
  for (const row of firstDepartures) departureByTrip.set(row.trip_id, row.dep);

  const chains = new Map<string, Array<{ tripId: string; routeId: string; start: number }>>();
  for (const trip of tripRows) {
    const chain = chains.get(trip.block_id) ?? [];
    chain.push({
      tripId: trip.trip_id,
      routeId: trip.route_id,
      start: departureByTrip.get(trip.trip_id) ?? 0,
    });
    chains.set(trip.block_id, chain);
  }

  const insert = db.prepare(
    `INSERT INTO block_trips (block_id, seq, trip_id, start_time, route_id) VALUES (?, ?, ?, ?, ?)`,
  );
  const run = db.transaction(() => {
    for (const [blockId, chain] of chains) {
      chain.sort((a, b) => a.start - b.start || a.tripId.localeCompare(b.tripId));
      chain.forEach((trip, seq) => {
        insert.run(blockId, seq, trip.tripId, trip.start, trip.routeId);
      });
    }
  });
  run();
}

export function loadStatic(db: Database, gtfs: ParsedStaticGtfs): void {
  const insertStop = db.prepare(
    `INSERT INTO stops (stop_id, stop_code, stop_name, parent_station, lat, lon) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertRoute = db.prepare(
    `INSERT INTO routes (route_id, agency_id, short_name, long_name, type) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertTrip = db.prepare(
    `INSERT INTO trips (trip_id, route_id, service_id, block_id, direction_id, headsign) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertStopTime = db.prepare(
    `INSERT INTO stop_times (trip_id, stop_sequence, stop_id, arrival_time, departure_time, pickup_type, drop_off_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCalendar = db.prepare(
    `INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCalendarDate = db.prepare(
    `INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)`,
  );
  const saveSetting = db.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
  );

  const run = db.transaction(() => {
    for (const stop of gtfs.stops) {
      insertStop.run(stop.stopId, stop.stopCode ?? null, stop.stopName, stop.parentStation ?? null, stop.lat, stop.lon);
    }
    for (const route of gtfs.routes) {
      insertRoute.run(route.routeId, route.agencyId ?? null, route.shortName, route.longName, route.type);
    }
    for (const trip of gtfs.trips) {
      insertTrip.run(
        trip.tripId,
        trip.routeId,
        trip.serviceId,
        trip.blockId ?? null,
        trip.directionId ?? null,
        trip.headsign ?? null,
      );
    }
    for (const st of gtfs.stopTimes) {
      insertStopTime.run(
        st.tripId,
        st.stopSequence,
        st.stopId,
        normalizeServiceSeconds(st.arrivalTime, gtfs.serviceDayStartSeconds),
        normalizeServiceSeconds(st.departureTime, gtfs.serviceDayStartSeconds),
        st.pickupType ?? 0,
        st.dropOffType ?? 0,
      );
    }
    for (const cal of gtfs.calendar) {
      insertCalendar.run(
        cal.serviceId,
        cal.monday,
        cal.tuesday,
        cal.wednesday,
        cal.thursday,
        cal.friday,
        cal.saturday,
        cal.sunday,
        cal.startDate,
        cal.endDate,
      );
    }
    for (const cd of gtfs.calendarDates) {
      insertCalendarDate.run(cd.serviceId, cd.date, cd.exceptionType);
    }
    deriveBlockTrips(db);
    saveSetting.run('serviceDayStartSeconds', JSON.stringify(gtfs.serviceDayStartSeconds));
    saveSetting.run('staticLoadedAt', JSON.stringify(Date.now()));
  });
  run();
}
