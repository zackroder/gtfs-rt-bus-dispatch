import type { TripUpdateInfo, VehiclePosition } from '../../../shared/types';

export interface RealtimeSnapshot {
  timestamp: number;
  vehicles: VehiclePosition[];
  tripUpdates: TripUpdateInfo[];
}

export interface RealtimeProvider {
  fetch(): Promise<RealtimeSnapshot>;
}

export interface ParsedStop {
  stopId: string;
  stopCode?: string;
  stopName: string;
  parentStation?: string;
  lat: number;
  lon: number;
}

export interface ParsedRoute {
  routeId: string;
  agencyId?: string;
  shortName: string;
  longName: string;
  type: number;
}

export interface ParsedTrip {
  tripId: string;
  routeId: string;
  serviceId: string;
  blockId?: string;
  directionId?: number;
  headsign?: string;
}

export interface ParsedStopTime {
  tripId: string;
  stopSequence: number;
  stopId: string;
  arrivalTime: number;
  departureTime: number;
  pickupType?: number;
  dropOffType?: number;
}

export interface ParsedCalendar {
  serviceId: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
  startDate: string;
  endDate: string;
}

export interface ParsedCalendarDate {
  serviceId: string;
  date: string;
  exceptionType: number;
}

export interface ParsedStaticGtfs {
  stops: ParsedStop[];
  routes: ParsedRoute[];
  trips: ParsedTrip[];
  stopTimes: ParsedStopTime[];
  calendar: ParsedCalendar[];
  calendarDates: ParsedCalendarDate[];
  serviceDayStartSeconds: number;
}

export interface StaticProvider {
  load(): Promise<ParsedStaticGtfs>;
}
