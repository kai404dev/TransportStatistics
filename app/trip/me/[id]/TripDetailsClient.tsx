'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation } from 'convex/react';
import { useUser } from '@clerk/nextjs';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getMapStyleUrl } from '@/components/mapStyleUrl';
import { useTheme } from '@/components/ThemeProvider';
import type { Id } from '@/convex/_generated/dataModel';
import { api } from '@/convex/_generated/api';
import { useQuery } from 'convex/react';
import { IWasHereButton } from '@/components/IWasHereButton';
import {
  ArrowLeft,
  BadgeInfo,
  Bus,
  CalendarDays,
  Link2,
  Link2Off,
  LoaderCircle,
  MapPinned,
  NotebookText,
  Plus,
  RefreshCw,
  Route,
  TrainFront,
  TramFront,
  Trash2,
  UserRound,
  Waypoints,
  X,
} from 'lucide-react';

type StopRecord = {
  name?: string;
  commonName?: string;
  crsCode?: string | null;
  atcoCode?: string | null;
  lat?: number;
  lon?: number;
};

type RouteStopLike = {
  name?: string;
  commonName?: string;
  stop?: {
    name?: string;
    commonName?: string;
    lat?: number;
    lon?: number;
  };
  lat?: number;
  lon?: number;
  actual_departure?: string | null;
  actual_arrival?: string | null;
  scheduled_departure?: string | null;
  scheduled_arrival?: string | null;
};

type RouteGeometry = {
  coordinates?: [number, number][];
};

type RoutePayload = {
  geometry?: RouteGeometry;
  coordinates?: [number, number][];
  stops?: RouteStopLike[];
  full_locations?: RouteStopLike[];
};

type RailDetails = {
  rid: string;
  uid: string;
  headcode: string;
  train_operator: string | null;
  origin_name: string;
  destination_name: string;
  origin_departure: string | null;
  destination_arrival: string | null;
  unit_numbers?: string[];
};

type UnitInfo = {
  unit_number?: string;
  unit_reg?: string;
  unit_type?: string;
  livery?: string;
  livery_left?: string;
};

type CouplingEvent = {
  type: 'couple' | 'uncouple';
  unit: UnitInfo;
  stop_name?: string;
  stop_code?: string;
  stop_id?: number | null;
};

type TripDetailsData = {
  trip: {
    _id: Id<'tripLogs'>;
    user: string;
    transport_type: string;
    service_number: string;
    operator: string;
    operator_slug: string;
    service_date: number;
    origin_name: string;
    origin_stop_code: string;
    destination_name: string;
    destination_stop_code: string;
    scheduled_departure: string;
    actual_departure?: string;
    scheduled_arrival: string;
    actual_arrival?: string;
    full_route?: RoutePayload | null;
    ridden_route?: RoutePayload | null;
    full_locations?: RouteStopLike[] | null;
    vehicle_journey_id?: number;
    bustimes_trip_id?: number;
    time_aware_polyline?: string;
    scheduled_geometry?: RouteGeometry | null;
    actual_geometry?: RouteGeometry | null;
    scheduled_route?: RouteStopLike[] | RoutePayload | null;
    actual_route?: RouteStopLike[] | RoutePayload | null;
    units?: UnitInfo[];
    unit_number?: string;
    unit_reg?: string;
    unit_type?: string;
    livery_name?: string;
    livery_css?: string;
    notes?: string;
    first_time?: boolean;
    first_units?: string[];
    coupling_events?: CouplingEvent[];
    on_trip_with: string[];
  };
  originStop: StopRecord | null;
  destinationStop: StopRecord | null;
  operatorRecord: { display_name: string } | null;
  railDetails: RailDetails | null;
  units: UnitInfo[];
};

type TripParticipant = {
  userId: string;
  username: string;
  addedAt: number;
  first_time?: boolean;
  first_units?: string[];
};

type Props = {
  data: TripDetailsData;
  isOwner?: boolean;
};

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function normalizeTimestamp(value: number) {
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function dateKeyFromTimestamp(value: number) {
  const date = new Date(normalizeTimestamp(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimeValue(value?: string | null) {
  if (!value) return '—';
  if (/^\d{2}:\d{2}/.test(value)) return value.slice(0, 5);

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function parseTimeMs(serviceDate: number, value?: string | null) {
  if (!value) return null;

  if (value.includes('T')) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }

  const dateKey = dateKeyFromTimestamp(serviceDate);
  const parsed = new Date(`${dateKey}T${value}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function getDelayMs(serviceDate: number, scheduled?: string | null, actual?: string | null) {
  const scheduledMs = parseTimeMs(serviceDate, scheduled);
  const actualMs = parseTimeMs(serviceDate, actual);

  if (scheduledMs === null || actualMs === null) return null;
  return actualMs - scheduledMs;
}

function formatDuration(ms: number | null) {
  if (ms === null || Number.isNaN(ms)) return '—';
  const totalMinutes = Math.round(ms / 60000);
  const sign = totalMinutes < 0 ? '-' : '+';
  const absMinutes = Math.abs(totalMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;

  if (hours === 0) return `${sign}${minutes}m`;
  return `${sign}${hours}h ${minutes.toString().padStart(2, '0')}m`;
}

function haversineKm(start: [number, number], end: [number, number]) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const radiusKm = 6371;

  const latitude1 = toRadians(start[1]);
  const latitude2 = toRadians(end[1]);
  const latitudeDelta = toRadians(end[1] - start[1]);
  const longitudeDelta = toRadians(end[0] - start[0]);

  const a =
    Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2) +
    Math.cos(latitude1) * Math.cos(latitude2) *
    Math.sin(longitudeDelta / 2) * Math.sin(longitudeDelta / 2);

  return 2 * radiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractCoordinates(route?: RoutePayload | null): [number, number][] {
  const candidate = route?.geometry?.coordinates ?? route?.coordinates;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((point): point is [number, number] => Array.isArray(point) && point.length === 2);
}

function extractStops(route?: RoutePayload | null) {
  const candidate = route?.stops ?? route?.full_locations;
  if (!Array.isArray(candidate)) return [];
  return candidate;
}

function getStopLabel(stop: RouteStopLike, fallback: string) {
  return stop?.name ?? stop?.commonName ?? stop?.stop?.name ?? stop?.stop?.commonName ?? fallback;
}

function getStopTime(stop: RouteStopLike) {
  return stop?.actual_departure ?? stop?.actual_arrival ?? stop?.scheduled_departure ?? stop?.scheduled_arrival ?? null;
}

function getStopCoordinates(stop: RouteStopLike, fallback?: StopRecord | null) {
  const lat = stop?.lat ?? stop?.stop?.lat ?? fallback?.lat;
  const lon = stop?.lon ?? stop?.stop?.lon ?? fallback?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return [lon, lat] as [number, number];
}

function dedupeCoordinates(coordinates: [number, number][]) {
  return coordinates.filter((c, i, a) => i === 0 || a[i - 1][0] !== c[0] || a[i - 1][1] !== c[1]);
}

function isRouteCircularForUpdate(fullRoute: Array<{ stop?: { location?: [number, number] | null; name?: string | null }; id?: number }>): boolean {
  if (fullRoute.length < 2) return false;
  const first = fullRoute[0] as { stop?: { name?: string | null; location?: [number, number] | null }; id?: number };
  const last = fullRoute[fullRoute.length - 1] as { stop?: { name?: string | null; location?: [number, number] | null }; id?: number };
  const firstLoc = (first as { stop?: { location?: [number, number] | null } })?.stop?.location;
  const lastLoc = (last as { stop?: { location?: [number, number] | null } })?.stop?.location;
  const firstName = (first as { stop?: { name?: string | null } })?.stop?.name;
  const lastName = (last as { stop?: { name?: string | null } })?.stop?.name;
  if (firstName && lastName && firstName === lastName) return true;
  if (firstLoc && lastLoc && firstLoc.length === 2 && lastLoc.length === 2) {
    if (firstLoc[0] === lastLoc[0] && firstLoc[1] === lastLoc[1]) return true;
  }
  const seen = new Set<number>();
  for (const s of fullRoute) {
    const id = (s as { id?: number }).id;
    if (typeof id === 'number') {
      if (seen.has(id)) return true;
      seen.add(id);
    }
  }
  return false;
}

function getAccentClasses(type: string) {
  switch (type) {
    case 'Rail':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
    case 'Bus':
      return 'border-orange-500/25 bg-orange-500/10 text-orange-300';
    case 'Tram':
      return 'border-purple-500/25 bg-purple-500/10 text-purple-300';
    default:
      return 'border-sky-500/25 bg-sky-500/10 text-sky-300';
  }
}

function getTransportIcon(type: string) {
  switch (type) {
    case 'Rail':
      return <TrainFront className="h-4 w-4" />;
    case 'Tram':
      return <TramFront className="h-4 w-4" />;
    default:
      return <Bus className="h-4 w-4" />;
  }
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-ts-border bg-ts-surface p-4 md:p-5">
      <div className="text-[10px] font-semibold  tracking-[0.18em] text-ts-text-3">{label}</div>
      <div className="mt-2 text-xl font-bold text-ts-text-1 tabular-nums">{value}</div>
      {sub ? <div className="mt-1 text-xs text-ts-text-3">{sub}</div> : null}
    </div>
  );
}

function normalizeUnitInfo(unit?: UnitInfo | null): UnitInfo {
  return {
    unit_number: typeof unit?.unit_number === 'string' ? unit.unit_number : undefined,
    unit_reg: typeof unit?.unit_reg === 'string' ? unit.unit_reg : undefined,
    unit_type: typeof unit?.unit_type === 'string' ? unit.unit_type : undefined,
    livery: typeof unit?.livery === 'string' ? unit.livery : undefined,
    livery_left: typeof unit?.livery_left === 'string' ? unit.livery_left : undefined,
  };
}

function normalizeTripUnits(trip: TripDetailsData['trip']): UnitInfo[] {
  if (Array.isArray(trip.units) && trip.units.length > 0) {
    return trip.units.map((unit) => normalizeUnitInfo(unit));
  }

  const fallback = normalizeUnitInfo({
    unit_number: trip.unit_number,
    unit_reg: trip.unit_reg,
    unit_type: trip.unit_type,
    livery: trip.livery_name,
    livery_left: trip.livery_css,
  });

  return fallback.unit_number || fallback.unit_reg || fallback.unit_type || fallback.livery || fallback.livery_left ? [fallback] : [];
}

function SectionCard({
  title,
  icon,
  children,
  className = '',
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${className}`}>
      <div className="flex items-center gap-2 border-b border-ts-border px-4 py-3 md:px-5">
        <div className="text-ts-text-2">{icon}</div>
        <h2 className="text-sm font-semibold  tracking-[0.14em] text-ts-text-1">{title}</h2>
      </div>
      <div className="p-4 md:p-5">{children}</div>
    </section>
  );
}

export function TripDetailsClient({ data, isOwner = true }: Props) {
  const { theme } = useTheme();
  const router = useRouter();
  const deleteTrip = useMutation(api.functions.trips.deleteTrip);
  const updateTrip = useMutation(api.functions.trips.updateTrip);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [updateState, setUpdateState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [updateError, setUpdateError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const trip = data.trip;
  const isParticipating = useQuery(
    api.functions.friends.getMyParticipationStatus,
    !isOwner ? { tripId: trip._id } : "skip",
  );
  const tripOwner = useQuery(
    api.functions.friends.getUserByClerkId,
    !isOwner ? { clerkId: trip.user } : "skip",
  );
  const { user } = useUser();
  const tripParticipants = useQuery(api.functions.friends.getTripParticipants, { tripId: trip._id }) as TripParticipant[] | undefined;
  const participatedTrips = useQuery(
    api.functions.friends.getUserParticipatedTrips,
    user ? { userId: user.id } : "skip",
  ) as Array<{ _id: string; first_time?: boolean; first_units?: string[] }> | undefined;
  const accentClasses = getAccentClasses(trip.transport_type);
  const operatorName = data.operatorRecord?.display_name ?? trip.operator;
  const tripUnits = useMemo(() => normalizeTripUnits(trip), [trip]);
  const viewerParticipation = useMemo(
    () => participatedTrips?.find((participant) => participant._id === trip._id) ?? null,
    [participatedTrips, trip._id],
  );
  const myFriends = useQuery(
    api.functions.friends.getMyFriends,
    isOwner ? undefined : "skip",
  ) as Array<{ _id: string; clerkId: string; username: string }> | undefined;
  const addParticipant = useMutation(api.functions.friends.addTripParticipant);
  const removeParticipant = useMutation(api.functions.friends.removeTripParticipant);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [addingFriendId, setAddingFriendId] = useState<string | null>(null);
  const isFirstTime = isOwner
    ? Boolean(trip.first_units?.length || trip.first_time)
    : Boolean(viewerParticipation?.first_time || viewerParticipation?.first_units?.length);

  const fullCoordinates = useMemo(() => extractCoordinates(trip.full_route), [trip.full_route]);
  const riddenCoordinates = useMemo(() => extractCoordinates(trip.ridden_route), [trip.ridden_route]);
  const scheduledCoordinates = useMemo(() => {
    const c = extractCoordinates(trip.scheduled_geometry as RoutePayload | null);
    if (c.length > 0) return c;
    const sr = trip.scheduled_route as unknown;
    if (Array.isArray(sr)) return [];
    return extractCoordinates(sr as RoutePayload | null);
  }, [trip.scheduled_geometry, trip.scheduled_route]);
  const actualCoordinates = useMemo(() => {
    const c = extractCoordinates(trip.actual_geometry as RoutePayload | null);
    if (c.length > 0) return c;
    return [];
  }, [trip.actual_geometry]);
  const hasActualTracking = Boolean(trip.vehicle_journey_id || trip.time_aware_polyline || actualCoordinates.length > 0);
  const routeStops = useMemo(() => {
    const riddenStops = extractStops(trip.ridden_route);
    if (riddenStops.length > 0) return riddenStops;
    const fullStops = extractStops(trip.full_route);
    if (fullStops.length > 0) return fullStops;
    const schedStops = (() => {
      const v = trip.scheduled_route as unknown;
      if (Array.isArray(v)) return v as RouteStopLike[];
      return extractStops(v as RoutePayload | null);
    })();
    if (schedStops.length > 0) return schedStops;
    return Array.isArray(trip.full_locations) ? trip.full_locations : [];
  }, [trip.full_locations, trip.full_route, trip.ridden_route, trip.scheduled_route]);

  const originCoord = useMemo(
    () => getStopCoordinates(routeStops[0], data.originStop),
    [data.originStop, routeStops],
  );
  const destinationCoord = useMemo(
    () => getStopCoordinates(routeStops[routeStops.length - 1], data.destinationStop),
    [data.destinationStop, routeStops],
  );

  const departureDelayMs = useMemo(
    () => getDelayMs(trip.service_date, trip.scheduled_departure, trip.actual_departure),
    [trip.actual_departure, trip.scheduled_departure, trip.service_date],
  );
  const arrivalDelayMs = useMemo(
    () => getDelayMs(trip.service_date, trip.scheduled_arrival, trip.actual_arrival),
    [trip.actual_arrival, trip.scheduled_arrival, trip.service_date],
  );
  const primaryDelayMs = arrivalDelayMs ?? departureDelayMs ?? null;
  const isDelayed = primaryDelayMs !== null && primaryDelayMs > 60_000;
  const isEarly = primaryDelayMs !== null && primaryDelayMs < 0;
  const delayLabel = primaryDelayMs !== null ? (isDelayed ? 'Delayed' : isEarly ? 'Early' : 'On time') : null;

  const durationMs = useMemo(() => {
    const actualDeparture = parseTimeMs(trip.service_date, trip.actual_departure);
    const actualArrival = parseTimeMs(trip.service_date, trip.actual_arrival);

    if (actualDeparture != null && actualArrival != null) {
      if (actualArrival < actualDeparture) {
        return actualArrival + 24 * 60 * 60 * 1000 - actualDeparture;
      }
      return actualArrival - actualDeparture;
    }

    const scheduledDeparture = parseTimeMs(trip.service_date, trip.scheduled_departure);
    const scheduledArrival = parseTimeMs(trip.service_date, trip.scheduled_arrival);

    if (scheduledDeparture != null && scheduledArrival != null) {
      if (scheduledArrival < scheduledDeparture) {
        return scheduledArrival + 24 * 60 * 60 * 1000 - scheduledDeparture;
      }
      return scheduledArrival - scheduledDeparture;
    }

    return null;
  }, [
    trip.actual_arrival,
    trip.actual_departure,
    trip.scheduled_arrival,
    trip.scheduled_departure,
    trip.service_date
  ]);
  
  const distanceKm = useMemo(() => {
    const riddenPath = riddenCoordinates.length > 1 ? riddenCoordinates : fullCoordinates;
    if (riddenPath.length > 1) {
      let total = 0;
      for (let index = 1; index < riddenPath.length; index += 1) {
        total += haversineKm(riddenPath[index - 1], riddenPath[index]);
      }
      return total;
    }

    if (originCoord && destinationCoord) {
      return haversineKm(originCoord, destinationCoord);
    }

    return null;
  }, [destinationCoord, fullCoordinates, originCoord, riddenCoordinates]);

  const stopCount = routeStops.length > 0 ? routeStops.length : riddenCoordinates.length > 0 ? riddenCoordinates.length : fullCoordinates.length;

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const hasMapData = riddenCoordinates.length > 1 || fullCoordinates.length > 1 || actualCoordinates.length > 1 || scheduledCoordinates.length > 1;
    if (!hasMapData) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: getMapStyleUrl(theme),
      center: riddenCoordinates[0] ?? fullCoordinates[0] ?? scheduledCoordinates[0] ?? actualCoordinates[0] ?? [-1.5, 52.5],
      zoom: 11,
    });

    mapRef.current = map;

    map.on('load', () => {
      type RouteFeature = {
        type: 'Feature';
        geometry:
          | { type: 'LineString'; coordinates: [number, number][] }
          | { type: 'Point'; coordinates: [number, number] };
        properties: { kind: 'full' | 'ridden' | 'scheduled' | 'actual' | 'origin' | 'destination' };
      };

      const features: RouteFeature[] = [];
      const bounds = new maplibregl.LngLatBounds();

      // When bus has actual tracking, prefer scheduled/actual over generic full
      if (hasActualTracking) {
        if (scheduledCoordinates.length > 1) {
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: scheduledCoordinates },
            properties: { kind: 'scheduled' },
          });
          scheduledCoordinates.forEach((coord) => bounds.extend(coord));
        } else if (fullCoordinates.length > 1) {
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: fullCoordinates },
            properties: { kind: 'scheduled' },
          });
          fullCoordinates.forEach((coord) => bounds.extend(coord));
        }
        if (actualCoordinates.length > 1) {
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: actualCoordinates },
            properties: { kind: 'actual' },
          });
          actualCoordinates.forEach((coord) => bounds.extend(coord));
        }
      } else {
        if (fullCoordinates.length > 1) {
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: fullCoordinates },
            properties: { kind: 'full' },
          });
          fullCoordinates.forEach((coord) => bounds.extend(coord));
        }
      }

      if (riddenCoordinates.length > 1) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: riddenCoordinates },
          properties: { kind: 'ridden' },
        });

        riddenCoordinates.forEach((coord) => bounds.extend(coord));
      }

      if (originCoord) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: originCoord },
          properties: { kind: 'origin' },
        });
        bounds.extend(originCoord);
      }

      if (destinationCoord) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: destinationCoord },
          properties: { kind: 'destination' },
        });
        bounds.extend(destinationCoord);
      }

      if (!map.getSource('trip-route')) {
        map.addSource('trip-route', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features },
        });
      }

      map.addLayer({
        id: 'full-route',
        type: 'line',
        source: 'trip-route',
        filter: ['==', ['get', 'kind'], 'full'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#64748b',
          'line-width': 4,
          'line-opacity': 0.35,
        },
      });

      // Scheduled (intended) route — faint green/gray
      map.addLayer({
        id: 'scheduled-route',
        type: 'line',
        source: 'trip-route',
        filter: ['==', ['get', 'kind'], 'scheduled'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#22c55e',
          'line-width': 4,
          'line-opacity': 0.45,
        },
      });

      // Actual GPS trace from time_aware_polyline — orange dashed
      map.addLayer({
        id: 'actual-route',
        type: 'line',
        source: 'trip-route',
        filter: ['==', ['get', 'kind'], 'actual'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#f97316',
          'line-width': 4,
          'line-opacity': 0.9,
          'line-dasharray': [2, 2],
        },
      });

      map.addLayer({
        id: 'ridden-route',
        type: 'line',
        source: 'trip-route',
        filter: ['==', ['get', 'kind'], 'ridden'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#60a5fa',
          'line-width': 5,
          'line-opacity': 0.95,
        },
      });

      map.addLayer({
        id: 'origin-point',
        type: 'circle',
        source: 'trip-route',
        filter: ['==', ['get', 'kind'], 'origin'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#60a5fa',
        },
      });

      map.addLayer({
        id: 'destination-point',
        type: 'circle',
        source: 'trip-route',
        filter: ['==', ['get', 'kind'], 'destination'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#60a5fa',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 44, duration: 500, maxZoom: 14 });
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [destinationCoord, fullCoordinates, originCoord, riddenCoordinates, scheduledCoordinates, actualCoordinates, hasActualTracking, theme]);

  const routeTitle = `${trip.origin_name} → ${trip.destination_name}`;

  const handleUpdate = async () => {
    if (updateState === 'loading') return;
    setUpdateState('loading');
    setUpdateError('');

    try {
      const dateKey = dateKeyFromTimestamp(trip.service_date);
      let fetchUrl: string | null = null;

      // Prefer vehicle journey (actual GPS trace) if we have it, otherwise fall back to trip ID
      const bustimesServiceId = (trip as unknown as { bustimes_service_id?: number }).bustimes_service_id;
      if (trip.vehicle_journey_id) {
        fetchUrl = `/api/log?journey_id=${encodeURIComponent(String(trip.vehicle_journey_id))}`;
      } else if (trip.bustimes_trip_id) {
        fetchUrl = `/api/log?uid=${encodeURIComponent(String(trip.bustimes_trip_id))}&date=${encodeURIComponent(dateKey)}&type=bus`;
      } else if (bustimesServiceId) {
        // Last resort - bustimes service ID with date may still resolve
        fetchUrl = `/api/log?uid=${encodeURIComponent(String(bustimesServiceId))}&date=${encodeURIComponent(dateKey)}&type=bus`;
      }

      if (!fetchUrl) {
        throw new Error('This trip has no bustimes identifiers (trip/journey ID) to refresh.');
      }

      const res = await fetch(fetchUrl, { cache: 'no-store' });
      const payload = (await res.json()) as Record<string, unknown> & {
        error?: string;
        message?: string;
        details?: string;
      };

      if (!res.ok) {
        throw new Error(payload.details || payload.message || payload.error || 'Failed to fetch updated bustimes data');
      }

      const getString = (key: string, fallback: string) =>
        typeof payload[key] === 'string' && (payload[key] as string).trim().length > 0
          ? (payload[key] as string)
          : fallback;

      const getNullableString = (key: string) =>
        typeof payload[key] === 'string' ? (payload[key] as string) : null;

      const service_number = getString('service_number', trip.service_number);
      const operator = getString('operator', trip.operator);
      const operator_slug = getString('operator_slug', trip.operator_slug);
      const service_date =
        typeof payload.service_date === 'number' ? (payload.service_date as number) : trip.service_date;
      // Baseline trip header from payload (may be full-service endpoints) - will be overridden by ridden slice endpoints below
      let origin_name = getString('origin_name', trip.origin_name);
      let origin_stop_code = getString('origin_stop_code', trip.origin_stop_code);
      let destination_name = getString('destination_name', trip.destination_name);
      let destination_stop_code = getString('destination_stop_code', trip.destination_stop_code);
      let scheduled_departure = getString('scheduled_departure', trip.scheduled_departure);
      let scheduled_arrival = getString('scheduled_arrival', trip.scheduled_arrival);
      let actual_departure: string | undefined = getNullableString('actual_departure') ?? trip.actual_departure ?? undefined;
      let actual_arrival: string | undefined = getNullableString('actual_arrival') ?? trip.actual_arrival ?? undefined;

      // Bus tracking fields - prefer fresh, fall back to existing
      const bustimes_service_id =
        typeof payload.bustimes_service_id === 'number'
          ? (payload.bustimes_service_id as number)
          : (trip as unknown as { bustimes_service_id?: number }).bustimes_service_id;
      const bustimes_service_slug =
        typeof payload.bustimes_service_slug === 'string'
          ? (payload.bustimes_service_slug as string)
          : (trip as unknown as { bustimes_service_slug?: string }).bustimes_service_slug;
      const bustimes_trip_id =
        typeof payload.bustimes_trip_id === 'number' ? (payload.bustimes_trip_id as number) : trip.bustimes_trip_id;
      const vehicle_journey_id =
        typeof payload.vehicle_journey_id === 'number' ? (payload.vehicle_journey_id as number) : trip.vehicle_journey_id;
      const time_aware_polyline =
        typeof payload.time_aware_polyline === 'string' ? (payload.time_aware_polyline as string) : trip.time_aware_polyline;

      const scheduled_geometry = (payload.scheduled_geometry as unknown) ?? trip.scheduled_geometry ?? null;
      const actual_geometry = (payload.actual_geometry as unknown) ?? trip.actual_geometry ?? null;
      const scheduled_route = (payload.scheduled_route as unknown) ?? trip.scheduled_route ?? null;
      const actual_route = (payload.actual_route as unknown) ?? trip.actual_route ?? null;

      // Keep the user's saved stop lists exactly - do not replace full/ridden with fresh.
      // Only refresh times/polyline/geometries. This guarantees "Edit" still shows the same boarding/alighting
      // selection (e.g. Normanton→Peartree stays, not expanded to Derby→Alvaston) while still updating the map traces.
      const freshScheduled = payload.scheduled_route as unknown as unknown[] | undefined;
      const freshFullStops =
        (Array.isArray(freshScheduled) && freshScheduled.length > 0 ? (freshScheduled as unknown[]) : null) ??
        (payload.full_route as unknown as unknown[] | undefined) ??
        (payload.full_locations as unknown as unknown[] | undefined) ??
        null;

      // Build lookup of fresh stop data by atco code/name for per-stop time/track refresh
      const freshByCode = new Map<string, unknown>();
      const freshByName = new Map<string, unknown>();
      if (freshFullStops) {
        for (const s of freshFullStops as Array<{ stop?: { stop_code?: string | null; name?: string | null } }>) {
          const code = (s as { stop?: { stop_code?: string | null } }).stop?.stop_code;
          if (code) freshByCode.set(code, s);
          const name = (s as { stop?: { name?: string | null } }).stop?.name?.trim().toLowerCase();
          if (name && !freshByName.has(name)) freshByName.set(name, s);
        }
      }

      const normalizeStops = (raw: unknown): Array<{ id?: number; stop?: { stop_code?: string | null; name?: string | null; location?: [number, number] | null }; track?: unknown; scheduled_departure?: string | null; scheduled_arrival?: string | null; actual_departure?: string | null; actual_arrival?: string | null }> => {
        if (Array.isArray(raw)) return raw as Array<{ id?: number; stop?: { stop_code?: string | null; name?: string | null; location?: [number, number] | null }; track?: unknown; scheduled_departure?: string | null; scheduled_arrival?: string | null; actual_departure?: string | null; actual_arrival?: string | null }>;
        if (!raw || typeof raw !== 'object') return [];
        const p = raw as { stops?: unknown; full_locations?: unknown };
        if (Array.isArray(p.stops)) return p.stops as Array<{ id?: number; stop?: { stop_code?: string | null; name?: string | null; location?: [number, number] | null }; track?: unknown; scheduled_departure?: string | null; scheduled_arrival?: string | null; actual_departure?: string | null; actual_arrival?: string | null }>;
        if (Array.isArray(p.full_locations)) return p.full_locations as Array<{ id?: number; stop?: { stop_code?: string | null; name?: string | null; location?: [number, number] | null }; track?: unknown; scheduled_departure?: string | null; scheduled_arrival?: string | null; actual_departure?: string | null; actual_arrival?: string | null }>;
        return [];
      };
      const mergeStopsWithFresh = (stops: Array<{ id?: number; stop?: { stop_code?: string | null; name?: string | null; location?: [number, number] | null }; track?: unknown; scheduled_departure?: string | null; scheduled_arrival?: string | null; actual_departure?: string | null; actual_arrival?: string | null }>): typeof stops => {
        if (!freshFullStops || stops.length === 0) return stops;
        return stops.map((old) => {
          const code = old.stop?.stop_code;
          const name = old.stop?.name?.trim().toLowerCase();
          const fresh = (code && (freshByCode.get(code) as typeof old)) || (name && (freshByName.get(name) as typeof old)) || null;
          if (!fresh) return old;
          // Keep original id/stop identity (so Edit mapping stays valid) but refresh times/track from fresh
          return {
            ...old,
            scheduled_departure: (fresh as { scheduled_departure?: string | null }).scheduled_departure ?? old.scheduled_departure,
            scheduled_arrival: (fresh as { scheduled_arrival?: string | null }).scheduled_arrival ?? old.scheduled_arrival,
            actual_departure: (fresh as { actual_departure?: string | null }).actual_departure ?? old.actual_departure,
            actual_arrival: (fresh as { actual_arrival?: string | null }).actual_arrival ?? old.actual_arrival,
            track: (fresh as { track?: unknown }).track ?? old.track,
          };
        });
      };

      // Keep original full/ridden stop lists (guarantees Edit shows same selection), but refresh their per-stop times/tracks
      const originalFullStops = normalizeStops(trip.full_route ?? (trip as unknown as { full_locations?: unknown }).full_locations ?? trip.scheduled_route);
      const effectiveOriginalFull = originalFullStops.length > 0 ? originalFullStops : normalizeStops(trip.scheduled_route);
      const mergedFullStops = mergeStopsWithFresh(effectiveOriginalFull);
      const freshFullRoute: unknown = mergedFullStops.length > 0 ? mergedFullStops : trip.full_route ?? null;

      const buildRiddenForUpdate = (): unknown => {
        const rRaw = trip.ridden_route as unknown;
        if (!rRaw) return null;
        // If ridden is exactly the same as full (whole ride), keep it in sync with merged full
        const rStopsRaw = normalizeStops(rRaw);
        if (rStopsRaw.length === 0) {
          // Ridden stored as object with geometry but no stops array? Preserve as is but update geometry below
          return trip.ridden_route ?? null;
        }
        const mergedRiddenStops = mergeStopsWithFresh(rStopsRaw);
        // Preserve original ridden object shape, just refresh stops + geometry
        const orig = rRaw as { stops?: unknown; geometry?: unknown; from_stop_id?: unknown; to_stop_id?: unknown; origin_name?: unknown; destination_name?: unknown };
        // Build new geometry clipped to the preserved ridden segment using fresh polyline
        const polyPath =
          (payload.actual_geometry as { coordinates?: unknown } | null)?.coordinates ??
          (payload as unknown as { polyline_path?: unknown }).polyline_path ??
          (payload.scheduled_geometry as { coordinates?: unknown } | null)?.coordinates ??
          null;
        let newGeometry: { type: string; coordinates: [number, number][] } | null = null;
        if (Array.isArray(polyPath) && (polyPath as unknown[]).length > 1) {
          const path = polyPath as [number, number][];
          // Clip polyline to the preserved ridden segment's first/last stop locations
          const firstLoc = (mergedRiddenStops[0] as { stop?: { location?: [number, number] | null } }).stop?.location as [number, number] | null | undefined;
          const lastLoc = (mergedRiddenStops[mergedRiddenStops.length - 1] as { stop?: { location?: [number, number] | null } }).stop?.location as [number, number] | null | undefined;
          const findClosest = (target: [number, number] | null | undefined): number | null => {
            if (!target || target.length !== 2) return null;
            let best = Infinity; let idx = 0;
            for (let i = 0; i < path.length; i++) {
              const d = Math.hypot(path[i][0] - target[0], path[i][1] - target[1]);
              if (d < best) { best = d; idx = i; }
            }
            if (best > 0.01) return null;
            return idx;
          };
          let a = findClosest(firstLoc);
          let b = findClosest(lastLoc);
          if (a === null || b === null) {
            // Fallback to using tracks of the preserved ridden stops
            const built: [number, number][] = [];
            for (const s of mergedRiddenStops as Array<{ track?: unknown; stop?: { location?: unknown } }>) {
              const tr = (s as { track?: unknown }).track;
              if (Array.isArray(tr) && tr.length > 0) built.push(...(tr as [number, number][]));
              else {
                const loc = (s as { stop?: { location?: unknown } }).stop?.location;
                if (Array.isArray(loc) && loc.length === 2) built.push(loc as [number, number]);
              }
            }
            if (built.length > 0) newGeometry = { type: 'LineString', coordinates: dedupeCoordinates(built) };
          } else {
            const s = Math.min(a, b); const e = Math.max(a, b);
            const clipped = dedupeCoordinates(path.slice(s, e + 1));
            if (clipped.length > 0) newGeometry = { type: 'LineString', coordinates: clipped };
          }
          // If clipping produced nothing, fallback to original geometry
          if (!newGeometry) {
            const origGeom = (orig as { geometry?: { coordinates?: [number, number][] } | null }).geometry;
            if (origGeom && Array.isArray(origGeom.coordinates) && origGeom.coordinates.length > 0) newGeometry = origGeom as { type: string; coordinates: [number, number][] };
          }
        } else {
          const origGeom = (orig as { geometry?: { coordinates?: [number, number][] } | null }).geometry;
          if (origGeom && Array.isArray(origGeom.coordinates) && origGeom.coordinates.length > 0) newGeometry = origGeom as { type: string; coordinates: [number, number][] };
          else {
            const built: [number, number][] = [];
            for (const s of mergedRiddenStops as Array<{ track?: unknown; stop?: { location?: unknown } }>) {
              const tr = (s as { track?: unknown }).track;
              if (Array.isArray(tr) && tr.length > 0) built.push(...(tr as [number, number][]));
              else {
                const loc = (s as { stop?: { location?: unknown } }).stop?.location;
                if (Array.isArray(loc) && loc.length === 2) built.push(loc as [number, number]);
              }
            }
            if (built.length > 0) newGeometry = { type: 'LineString', coordinates: dedupeCoordinates(built) };
          }
        }
        // If original ridden was an array (not object), return merged array
        if (Array.isArray(rRaw)) return mergedRiddenStops as unknown;
        return {
          ...(orig as object),
          stops: mergedRiddenStops,
          geometry: newGeometry ?? (orig as { geometry?: unknown }).geometry ?? null,
        };
      };
      const freshRiddenRoute = buildRiddenForUpdate();

      // Derive trip header (origin/destination/times) from the preserved ridden slice, not the full service terminus.
      // This prevents a partial ride (e.g. Derby→Peartree) being overwritten to the bus's full Derby→Alvaston.
      if (
        freshRiddenRoute &&
        typeof freshRiddenRoute === 'object' &&
        Array.isArray((freshRiddenRoute as { stops?: unknown }).stops) &&
        ((freshRiddenRoute as { stops: unknown[] }).stops.length as number) > 0
      ) {
        const rStops = (freshRiddenRoute as { stops: Array<{ stop?: { stop_code?: string | null; name?: string | null }; scheduled_departure?: string | null; scheduled_arrival?: string | null; actual_departure?: string | null; actual_arrival?: string | null }> }).stops;
        const rFirst = rStops[0];
        const rLast = rStops[rStops.length - 1];
        if (rFirst?.stop?.name) origin_name = rFirst.stop.name as string;
        if ((rFirst as { stop?: { stop_code?: string | null } })?.stop?.stop_code) origin_stop_code = (rFirst as { stop?: { stop_code?: string | null } }).stop!.stop_code as string;
        if (rLast?.stop?.name) destination_name = rLast.stop.name as string;
        if ((rLast as { stop?: { stop_code?: string | null } })?.stop?.stop_code) destination_stop_code = (rLast as { stop?: { stop_code?: string | null } }).stop!.stop_code as string;
        const rFirstSchedDep = (rFirst as { scheduled_departure?: string | null; scheduled_arrival?: string | null }).scheduled_departure ?? (rFirst as { scheduled_departure?: string | null; scheduled_arrival?: string | null }).scheduled_arrival;
        const rLastSchedArr = (rLast as { scheduled_arrival?: string | null; scheduled_departure?: string | null }).scheduled_arrival ?? (rLast as { scheduled_arrival?: string | null; scheduled_departure?: string | null }).scheduled_departure;
        const rFirstActDep = (rFirst as { actual_departure?: string | null; actual_arrival?: string | null }).actual_departure ?? (rFirst as { actual_departure?: string | null; actual_arrival?: string | null }).actual_arrival;
        const rLastActArr = (rLast as { actual_arrival?: string | null; actual_departure?: string | null }).actual_arrival ?? (rLast as { actual_arrival?: string | null; actual_departure?: string | null }).actual_departure;
        if (typeof rFirstSchedDep === 'string' && rFirstSchedDep) scheduled_departure = rFirstSchedDep;
        if (typeof rLastSchedArr === 'string' && rLastSchedArr) scheduled_arrival = rLastSchedArr;
        if (typeof rFirstActDep === 'string' && rFirstActDep) actual_departure = rFirstActDep;
        if (typeof rLastActArr === 'string' && rLastActArr) actual_arrival = rLastActArr;
      }

      // Keep existing vehicle/notes/coupling data
      const units = Array.isArray(trip.units) ? trip.units : [];
      const notes = trip.notes;
      const coupling_events = trip.coupling_events;

      // Only include bustimes geometry fields for Bus trips where we have tracking data
      const isBus = trip.transport_type === 'Bus';
      const hasTracking = Boolean(vehicle_journey_id || time_aware_polyline || actual_geometry || scheduled_geometry);

      await updateTrip({
        tripId: trip._id,
        service_number,
        operator,
        operator_slug,
        service_date,
        transport_type: trip.transport_type as 'Rail' | 'Bus' | 'Tram' | 'Ferry' | 'Taxi' | 'Other',
        bustimes_service_id,
        bustimes_service_slug,
        bustimes_trip_id: isBus && hasTracking ? bustimes_trip_id : trip.bustimes_trip_id,
        vehicle_journey_id: isBus && hasTracking ? vehicle_journey_id : trip.vehicle_journey_id,
        time_aware_polyline: isBus && hasTracking ? (time_aware_polyline as string | undefined) : trip.time_aware_polyline as string | undefined,
        scheduled_geometry: (isBus && hasTracking ? scheduled_geometry : trip.scheduled_geometry) as unknown as never,
        actual_geometry: (isBus && hasTracking ? actual_geometry : trip.actual_geometry) as unknown as never,
        scheduled_route: (isBus && hasTracking ? scheduled_route : trip.scheduled_route) as unknown as never,
        actual_route: (isBus && hasTracking ? actual_route : trip.actual_route) as unknown as never,
        origin_name,
        origin_stop_code,
        destination_name,
        destination_stop_code,
        scheduled_departure,
        actual_departure: actual_departure ?? undefined,
        scheduled_arrival,
        actual_arrival: actual_arrival ?? undefined,
        full_route: (freshFullRoute ?? trip.full_route) as unknown as never,
        ridden_route: (freshRiddenRoute ?? trip.ridden_route) as unknown as never,
        units: units as never,
        notes: notes as string | undefined,
        coupling_events: coupling_events as unknown as never,
      } as unknown as never);

      setUpdateState('success');
      // Allow Convex live query + server page to revalidate
      router.refresh();
      window.setTimeout(() => setUpdateState('idle'), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      setUpdateError(msg);
      setUpdateState('error');
      window.setTimeout(() => {
        setUpdateState('idle');
        setUpdateError('');
      }, 3500);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;

    const confirmed = window.confirm('Delete this trip? This cannot be undone.');
    if (!confirmed) return;

    setIsDeleting(true);

    try {
      await deleteTrip({ tripId: trip._id });
      router.replace('/profile');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
      <div className="flex items-center justify-between gap-3">
        {isOwner ? (
          <Link
            href="/profile"
            className="inline-flex items-center gap-2 rounded-full border border-ts-border bg-ts-surface px-3 py-2 text-sm text-ts-text-2 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to trips
          </Link>
        ) : (
          <Link
            href={`/profile/${trip.user}`}
            className="inline-flex items-center gap-2 rounded-full border border-ts-border bg-ts-surface px-3 py-2 text-sm text-ts-text-2 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent"
          >
            <ArrowLeft className="h-4 w-4" />
            {tripOwner?.username ?? 'User'}&apos;s trips
          </Link>
        )}

        <div className="inline-flex items-center gap-2 rounded-full border border-ts-border bg-ts-surface px-3 py-2 text-xs text-ts-text-3">
          <CalendarDays className="h-3.5 w-3.5" />
          {new Date(normalizeTimestamp(trip.service_date)).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </div>
      </div>

      <section className={``}>
        <div className="border-b border-white/10 px-5 py-4 md:px-6 md:py-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0">
              <h1 className="mt-2 text-2xl font-bold text-ts-text-1 md:text-2xl">{trip.service_number} | {routeTitle}</h1>
              <div className="text-sm font-medium text-ts-text-3">
                {operatorName} | {formatTimeValue(trip.scheduled_departure)} → {formatTimeValue(trip.scheduled_arrival)}
              </div>
              <br/>
              <div className="flex flex-wrap items-center gap-2">
                {isFirstTime ? (
                  <div className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/5 px-3 py-1 text-xs font-semibold  tracking-[0.14em] text-amber-500">
                    <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 12 12" fill="currentColor">
                      <path d="M6 1l1.2 3.6H11l-3 2.2 1.1 3.6L6 8.2l-3.1 2.2L4 7 1 4.8h3.8z"/>
                    </svg>
                    First Time
                  </div>
                ) : null}
                {primaryDelayMs !== null ? (
                  <span
                    className={`rounded-full border px-3 py-1 text-xs font-semibold  tracking-[0.14em] ${
                      isDelayed
                        ? 'border-rose-400/25 bg-rose-400/10 text-rose-400'
                        : isEarly
                          ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-500'
                          : 'border-sky-400/25 bg-sky-400/10 text-sky-400'
                    }`}
                  >
                    {delayLabel} {formatDuration(primaryDelayMs)}
                  </span>
                ) : null}
                {!isOwner && isParticipating ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">
                    <MapPinned className="h-3 w-3" />
                    You were on this trip
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-3 border-t border-white/10 px-5 py-4 md:grid-cols-2 lg:grid-cols-4 md:px-6">
          <StatCard
            label="Duration"
            value={formatDuration(durationMs)}
          />
          <StatCard
            label="Distance"
            value={distanceKm !== null ? `${distanceKm.toFixed(1)} km` : '—'}
          />
          <StatCard
            label="Delay"
            value={`Dep: ${formatDuration(departureDelayMs)} | Arr: ${formatDuration(arrivalDelayMs)}`}
          />
          <StatCard
            label="Stops"
            value={String(stopCount || '—')}
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          <SectionCard title="Map" icon={<MapPinned className="h-4 w-4" />}>
            {fullCoordinates.length > 1 || riddenCoordinates.length > 1 || scheduledCoordinates.length > 1 || actualCoordinates.length > 1 ? (
              <div className="space-y-3">
                <div className="h-[500px] overflow-hidden rounded-2xl border border-ts-border bg-ts-bg">
                  <div ref={mapContainerRef} className="h-full w-full rounded-2xl" />
                </div>
                {hasActualTracking ? (
                  <div className="flex flex-wrap gap-3 text-xs text-ts-text-3 px-1">
                    <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-5 rounded-full bg-emerald-500/70 inline-block" /> Scheduled (intended) route</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-5 rounded-full bg-orange-500 inline-block" style={{background: 'repeating-linear-gradient(90deg,#f97316 0 4px, transparent 4px 8px)'}} /> Actual GPS trace</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-5 rounded-full bg-blue-500 inline-block" /> Ridden section</span>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-ts-border p-4 text-sm text-ts-text-3">
                Route geometry is unavailable for this trip, so the stop timeline below acts as the fallback view.
              </div>
            )}
          </SectionCard>

          <SectionCard title="Stops" icon={<Route className="h-4 w-4" />}>
            {routeStops.length > 0 ? (
              <div className="space-y-3">
                {routeStops.map((stop, index) => {
                  const isEdge = index === 0 || index === routeStops.length - 1;
                  const label = getStopLabel(stop, index === 0 ? trip.origin_name : index === routeStops.length - 1 ? trip.destination_name : `Stop ${index + 1}`);
                  const time = getStopTime(stop);

                  return (
                    <div key={`${label}-${index}`} className="flex gap-3 rounded-2xl px-4 mb-[1px]">
                      <div className="flex flex-col items-center pt-0.5">
                        <div className={`h-3 w-3 rounded-full ${isEdge ? 'bg-ts-accent' : 'bg-white/40'}`} />
                        {index < routeStops.length - 1 ? <div className="mt-1 h-full min-h-8 w-px bg-white/10" /> : null}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-ts-text-1">{label}</span>
                          {isEdge ? (
                            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold  tracking-[0.14em] text-ts-text-3">
                              {index === 0 ? 'Origin' : 'Destination'}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 text-sm text-ts-text-3">
                          {time ? formatTimeValue(time) : 'No stop time available'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="">
                  <div className="text-xs  tracking-[0.14em] text-ts-text-3">Origin</div>
                  <div className="mt-1 font-semibold text-ts-text-1">{trip.origin_name}</div>
                </div>
                <div className="">
                  <div className="text-xs  tracking-[0.14em] text-ts-text-3">Destination</div>
                  <div className="mt-1 font-semibold text-ts-text-1">{trip.destination_name}</div>
                </div>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard title="Vehicle" icon={<Waypoints className="h-4 w-4" />}>
            {tripUnits.length > 0 ? (
              <div className="space-y-3">
                {tripUnits.map((unit, index) => {
                  const liveryCss = unit.livery_left ?? trip.livery_css ?? null;
                  const unitLabel = [unit.unit_number, unit.unit_reg].filter(Boolean).join(' · ') || 'Unknown unit';

                  const couplingForThisUnit = Array.isArray(trip.coupling_events)
                    ? trip.coupling_events.filter((event) => {
                        const eventUnitLabel = [event.unit?.unit_number, event.unit?.unit_reg]
                          .filter(Boolean)
                          .join(' - ');
                        return (
                          eventUnitLabel === unitLabel ||
                          event.unit?.unit_number === unit.unit_number ||
                          event.unit?.unit_reg === unit.unit_reg
                        );
                      })
                    : [];

                  return (
                    <div key={`${unitLabel}-${index}`} className="">
                      <div className="flex items-start gap-3">
                        <div
                          className="h-12 w-16 shrink-0 rounded-xl border border-ts-border-soft"
                          style={{ background: liveryCss ?? undefined }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-mono text-sm font-semibold text-ts-text-1">{unitLabel}</div>
                            {unit.unit_type ? (
                              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px]  tracking-[0.14em] text-ts-text-3">
                                {unit.unit_type}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 text-sm text-ts-text-3">
                            {unit.livery ?? 'Vehicle data from trip payload'}
                          </div>
                          {couplingForThisUnit.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {couplingForThisUnit.map((event, evIdx) => (
                                <span
                                  key={evIdx}
                                  className={`inline-flex items-center gap-1 rounded-full px-2 mt-[-15px] py-1 text-[11px] font-semibold ${
                                    event.type === 'couple'
                                      ? 'text-emerald-500'
                                      : 'text-red-400'
                                  }`}
                                >
                                  {event.type === 'couple' ? (
                                    <Link2 className="h-3 w-3" />
                                  ) : (
                                    <Link2Off className="h-3 w-3" />
                                  )}
                                  {event.type === 'couple' ? 'Coupled' : 'Uncoupled'}
                                  {event.stop_name ? ` at ${event.stop_name}` : ''}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-ts-border p-4 text-sm text-ts-text-3">
                Vehicle details were not recorded on this trip.
              </div>
            )}
          </SectionCard>

          <SectionCard title="Companions" icon={<UserRound className="h-4 w-4" />}>
            {tripParticipants && tripParticipants.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {tripParticipants.map((participant) => (
                  <span key={participant.userId} className="inline-flex items-center gap-1.5 rounded-full border border-ts-border bg-ts-surface-2 px-3 py-1.5 text-sm text-ts-text-1">
                    {participant.username}
                    {isOwner ? (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await removeParticipant({ tripId: trip._id, participantClerkId: participant.userId });
                          } catch (e) {
                            console.error(e);
                          }
                        }}
                        className="ml-0.5 rounded-full p-0.5 text-ts-text-3 hover:bg-rose-500/20 hover:text-rose-300 transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : trip.on_trip_with.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {trip.on_trip_with.map((name) => (
                  <span key={name} className="rounded-full border border-ts-border bg-ts-surface-2 px-3 py-1.5 text-sm text-ts-text-1">
                    {name}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-sm text-ts-text-3">No companions recorded for this trip.</div>
            )}
            {isOwner ? (
              <div className="mt-3">
                {showAddFriend ? (
                  <div className="rounded-2xl border border-ts-border bg-ts-surface-2 p-3">
                    <div className="mb-2 text-xs font-semibold  tracking-[0.14em] text-ts-text-3">
                      Select a friend to add
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {myFriends
                        ?.filter((f) => !tripParticipants?.some((p) => p.userId === f.clerkId))
                        .map((friend) => (
                          <button
                            key={friend.clerkId}
                            type="button"
                            disabled={addingFriendId === friend.clerkId}
                            onClick={async () => {
                              setAddingFriendId(friend.clerkId);
                              try {
                                await addParticipant({ tripId: trip._id, friendClerkId: friend.clerkId });
                                setShowAddFriend(false);
                              } catch (e) {
                                console.error(e);
                              } finally {
                                setAddingFriendId(null);
                              }
                            }}
                            className="inline-flex items-center gap-1.5 rounded-full border border-ts-border bg-ts-surface px-3 py-1.5 text-sm text-ts-text-1 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent disabled:opacity-50"
                          >
                            {addingFriendId === friend.clerkId ? (
                              <LoaderCircle className="h-3 w-3 animate-spin" />
                            ) : (
                              <Plus className="h-3 w-3" />
                            )}
                            {friend.username}
                          </button>
                        ))}
                      {myFriends && myFriends.filter((f) => !tripParticipants?.some((p) => p.userId === f.clerkId)).length === 0 ? (
                        <div className="text-sm text-ts-text-3">All your friends are already companions on this trip.</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowAddFriend(false)}
                      className="mt-2 text-xs text-ts-text-3 hover:text-ts-text-1 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowAddFriend(true)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-ts-border bg-ts-surface-2 px-3 py-1.5 text-sm text-ts-text-1 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add friend as companion
                  </button>
                )}
              </div>
            ) : null}
          </SectionCard>

          {trip.notes ? (
            <SectionCard title="Notes" icon={<NotebookText className="h-4 w-4" />}>
              <div className="whitespace-pre-wrap  text-sm leading-6 text-ts-text-2">
                {trip.notes}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title="Actions" icon={<BadgeInfo className="h-4 w-4" />}>
            <div className="flex flex-wrap gap-2">
              {isOwner ? (
                <>
                  <Link
                    href={`/log?trip_id=${trip._id}`}
                    className="inline-flex items-center gap-2 rounded-full border border-ts-border bg-ts-surface-2 px-4 py-2 text-sm text-ts-text-1 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent"
                  >
                    <LoaderCircle className="h-4 w-4" />
                    Edit trip
                  </Link>
                  <button
                    type="button"
                    onClick={handleUpdate}
                    disabled={updateState === 'loading'}
                    className="inline-flex items-center gap-2 rounded-full border border-ts-border bg-ts-surface-2 px-4 py-2 text-sm text-ts-text-1 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent disabled:cursor-not-allowed disabled:opacity-60"
                    title="Refresh times, polyline and route from bustimes"
                  >
                    <RefreshCw className={`h-4 w-4 ${updateState === 'loading' ? 'animate-spin' : ''}`} />
                    {updateState === 'loading' ? 'Updating…' : updateState === 'success' ? 'Updated' : updateState === 'error' ? 'Failed' : 'Update'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 transition hover:border-rose-400/50 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    title="Delete your own trip"
                  >
                    <Trash2 className="h-4 w-4" />
                    {isDeleting ? 'Deleting...' : 'Delete trip'}
                  </button>
                </>
              ) : (
                <IWasHereButton tripId={trip._id} tripUserId={trip.user} />
              )}
            </div>
            {updateError ? (
              <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {updateError}
              </div>
            ) : updateState === 'success' ? (
              <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                Trip refreshed from bustimes — times, route and polyline updated.
              </div>
            ) : null}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
