/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { withApiKeyAuth } from '@/lib/api-key-auth';
import { buildBustimesUrl, getBustimesBaseUrl } from '@/lib/bustimes-source';
import { fetchAllocationFromRTT, getRTTToken } from "@/lib/realtime-trains";

const consoleDebug = false;

const REDIS_DISABLED =
  process.env.DISABLE_REDIS === 'true' || process.env.REDIS_DISABLED === 'true';

let redisClient: Redis | any;
let limiter: any;

if (!REDIS_DISABLED) {
  redisClient = new Redis(process.env.REDIS_URL!, { 
    lazyConnect: true,
    maxRetriesPerRequest: 3 
  });

  limiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'detail_limit',
    points: 5, 
    duration: 1,
  });
} else {
  redisClient = { get: async () => null, set: async () => null, on: () => null } as unknown as Redis;
  limiter = new RateLimiterMemory({ points: 5, duration: 1 });
}

function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

function log(message: string) {
  if (consoleDebug) console.log(`[Detail API] ${message}`);
}

function isPassingPoint(loc: any): boolean {
  const hasScheduled = Boolean(
    loc.temporalData?.arrival?.scheduleAdvertised ||
    loc.temporalData?.departure?.scheduleAdvertised
  );
  const isPass = loc.displayAs === 'PASS';
  return isPass || !hasScheduled;
}

function toLineStringGeometry(routeData: any) {
  if (!routeData) return null;
  if (routeData.type === "LineString" && Array.isArray(routeData.coordinates)) {
    return routeData;
  }
  if (routeData.geometry?.type === "LineString" && Array.isArray(routeData.geometry.coordinates)) {
    return routeData.geometry;
  }
  if (Array.isArray(routeData.coordinates)) {
    return { type: "LineString", coordinates: routeData.coordinates };
  }
  if (Array.isArray(routeData)) {
    return { type: "LineString", coordinates: routeData };
  }
  return null;
}

function dateToTimestamp(date: string) {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

function decodeTimeAwarePolyline(str: string): [number, number][] {
  let index = 0;
  const values: number[] = [];

  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let b: number;

    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    values.push(result & 1 ? ~(result >> 1) : result >> 1);
  }

  let lng = 0;
  let lat = 0;
  const coordinates: [number, number][] = [];

  for (let i = 0; i + 2 < values.length; i += 3) {
    lng += values[i];
    lat += values[i + 1];
    coordinates.push([lng / 1e5, lat / 1e5]);
  }

  return coordinates;
}

export const GET = withApiKeyAuth(async (_auth, request: Request) => {
  const bustimesBaseUrl = await getBustimesBaseUrl("tripLookup", _auth?.userId);
  const ip = request.headers.get("x-forwarded-for") ?? "127.0.0.1";
  
  try { 
    await limiter.consume(ip); 
  } catch {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const serviceRid = searchParams.get('service_rid');
  const serviceId = searchParams.get('service_id');
  const serviceUid = searchParams.get('service_uid');
  const tripId = searchParams.get('trip_id');
  const journeyId = searchParams.get('journey_id');
  const uid = searchParams.get('uid') ?? serviceUid ?? serviceId ?? tripId ?? journeyId;
  const date = searchParams.get('date') ?? searchParams.get('service_date'); 
  const type = searchParams.get('type') || (serviceRid ? 'train' : (serviceId || tripId ? 'bus' : 'train'));
  const debug = searchParams.get('debug') === 'true';
  const showPass = searchParams.get('show_pass') === 'true';

  if (serviceRid) {
    try {
      return await handleServiceRidRequest(serviceRid, debug, showPass);
    } catch (err: any) {
      log(`RID resolution error: ${err.message}`);
      return NextResponse.json({
        error: 'Failed to resolve service RID.',
        message: err.message,
      }, { status: 500 });
    }
  }

  if (journeyId) {
    try {
      return await handleJourneyRequest(journeyId, date, debug, bustimesBaseUrl);
    } catch (err: any) {
      log(`Journey request error: ${err.message}`);
      return NextResponse.json({
        error: 'Failed to load journey.',
        message: err.message,
      }, { status: 500 });
    }
  }

  if (!uid || !date) {
    return NextResponse.json({ 
      error: 'Missing required parameters.', 
      details: 'Both "uid" and "date" (YYYY-MM-DD) are required.' 
    }, { status: 400 });
  }

  try {
    switch (type) {
      case 'train':
        return await handleTrainRequest(uid, date, debug, showPass);
      case 'bus':
        return await handleBusRequest(uid, date, debug, bustimesBaseUrl);
      default:
        return NextResponse.json({ error: `Invalid type: ${type}` }, { status: 400 });
    }
  } catch (err: any) {
    log(`Critical Error: ${err.message}`);
    return NextResponse.json({ 
      error: 'An internal error occurred.', 
      message: err.message 
    }, { status: 500 });
  }
});

const resolveServiceRidPayload = (payload: any, serviceRid?: string) => {
  // 1. Resolve UID
  const uid =
    payload?.uid ??
    payload?.service?.uid ??
    payload?.train?.uid ??
    payload?.data?.uid ??
    null;

  // 2. Target origin_departure FIRST (The definitive schedule operational date)
  const originDeparture = 
    payload?.origin_departure ?? 
    payload?.service?.origin_departure ??
    payload?.train?.origin_departure ??
    null;

  let date = typeof originDeparture === "string" && originDeparture.includes("T")
    ? originDeparture.split("T")[0]
    : null;

  // 3. Fallback to destination_arrival ONLY if origin_departure is entirely absent
  if (!date) {
    const destinationArrival =
      payload?.destination_arrival ??
      payload?.service?.destination_arrival ??
      payload?.train?.destination_arrival ??
      payload?.data?.destination_arrival ??
      null;

    date = typeof destinationArrival === "string" && destinationArrival.includes("T")
        ? destinationArrival.split("T")[0]
        : null;
  }

  // 4. Absolute Fallback: Extract the date directly from the Service RID string digits
  if (!date && serviceRid && serviceRid.length >= 8) {
    const year = serviceRid.substring(0, 4);
    const month = serviceRid.substring(4, 6);
    const day = serviceRid.substring(6, 8);
    
    if (!isNaN(Number(year)) && !isNaN(Number(month)) && !isNaN(Number(day))) {
      date = `${year}-${month}-${day}`;
    }
  }

  return { uid, date };
};

async function handleServiceRidRequest(serviceRid: string, debug: boolean, showPass: boolean) {
  const response = await fetch(`https://map-api.production.signalbox.io/api/train-information/${serviceRid}`);

  if (!response.ok) {
    return NextResponse.json(
      { error: "Signalbox train lookup failed." },
      { status: 500 },
    );
  }

  const payload = await response.json();
  const { uid, date } = resolveServiceRidPayload(payload);

  if (!uid || !date) {
    return NextResponse.json(
      {
        error: "Signalbox lookup did not return a usable UID and date.",
        debug: debug ? payload : undefined,
      },
      { status: 500 },
    );
  }

  return handleTrainRequest(uid, date, debug, showPass, serviceRid);
}

function mergeTrainStopAndTrack(locations: any[], routeData: any, uid: string, date: string) {
  const geometry = toLineStringGeometry(routeData);
  const fullCoords = geometry?.coordinates || [];

  // Helper to generate our unique number ID
  const generateId = (loc: any, i: number) => {
    const formatted = formatStop(loc);
    const stopCode = formatted.stop_code ?? i.toString();
    return hashStringToNumber(`${uid}-${date}-${stopCode}`);
  };

  // IF NO GEOMETRY: Just return stops with unique IDs
  if (fullCoords.length === 0) {
    return locations.map((loc, i) => ({
      id: generateId(loc, i), // FIX: Use unique ID here too
      stop: formatStop(loc),
      scheduled_arrival: loc.temporalData?.arrival?.scheduleAdvertised || null,
      scheduled_departure: loc.temporalData?.departure?.scheduleAdvertised || null,
      actual_arrival: loc.temporalData?.arrival?.realtimeActual || loc.temporalData?.arrival?.realtimeForecast || null,
      actual_departure: loc.temporalData?.departure?.realtimeActual || loc.temporalData?.departure?.realtimeForecast || null,
      track: null,
    }));
  }

  // Pass 1: find the closest geometry index for each stop
  const closestIndices: number[] = [];
  let searchFrom = 0;

  for (const loc of locations) {
    const stopCoords = formatStop(loc).location as [number, number] | null;

    if (!stopCoords) {
      closestIndices.push(searchFrom);
      continue;
    }

    let closestIdx = searchFrom;
    let minDistance = Infinity;

    for (let j = searchFrom; j < fullCoords.length; j++) {
      const dist = Math.sqrt(
        Math.pow(fullCoords[j][0] - stopCoords[0], 2) +
        Math.pow(fullCoords[j][1] - stopCoords[1], 2)
      );
      if (dist < minDistance) {
        minDistance = dist;
        closestIdx = j;
      }
    }

    closestIndices.push(closestIdx);
    searchFrom = closestIdx;
  }

  // Pass 2: assign each stop the track segment from the PREVIOUS stop to itself
  return locations.map((loc, i) => {
    const formattedStop = formatStop(loc);
    const isFirst = i === 0;

    const stopCode = formattedStop.stop_code ?? i.toString();
    const uniqueString = `${uid}-${date}-${stopCode}`;
    const uniqueId = hashStringToNumber(uniqueString);

    let trackSegment: any[] = [];
    if (!isFirst) {
      const fromIdx = closestIndices[i - 1];
      const toIdx = closestIndices[i];
      trackSegment = fullCoords.slice(fromIdx, toIdx + 1);
    }

    return {
      id: uniqueId, // Now a unique string instead of just 'i'
      stop: formattedStop,
      scheduled_arrival: loc.temporalData?.arrival?.scheduleAdvertised || null,
      scheduled_departure: loc.temporalData?.departure?.scheduleAdvertised || null,
      actual_arrival: loc.temporalData?.arrival?.realtimeActual || loc.temporalData?.arrival?.realtimeForecast || null,
      actual_departure: loc.temporalData?.departure?.realtimeActual || loc.temporalData?.departure?.realtimeForecast || null,
      track: trackSegment.length > 0 ? trackSegment : null,
      timing_status: loc.displayAs,
      pick_up: loc.scheduledCallType?.includes("PICK_UP"),
      set_down: loc.scheduledCallType?.includes("SET_DOWN"),
    };
  });
}


function formatStop(loc: any) {
  const hasCoords = typeof loc.stopData?.lon === "number" && typeof loc.stopData?.lat === "number";
  const location = hasCoords
    ? [loc.stopData.lon, loc.stopData.lat]
    : (loc.stopData?.location || null);

  return {
    stop_code: loc.location.shortCodes?.[0] || null,
    name: loc.location.description,
    location: location,
    bearing: null,
    icon: null
  };
}

async function handleTrainRequest(
  uid: string,
  date: string,
  debug: boolean,
  showPass: boolean,
  serviceRid?: string,
) {
  log(`Processing train: ${uid} for ${date}`);

  let rid: string | null = serviceRid ?? null;
  if (!rid) {
    try {
      const trainRecord = await fetchQuery(api.functions.trains.getRidWithUID, { uid });
      if (trainRecord) rid = trainRecord.rid;
    } catch (e: any) {
      log(`Convex Lookup Error: ${e.message}`);
    }
  }

  try {
    const token = await getRTTToken();
    const rttUrl = `https://data.rtt.io/gb-nr/service?uniqueIdentity=${uid}:${date}&detailed=true`;
    
    const rttPromise = fetch(rttUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const routePromise = rid 
      ? fetch(`https://map-api.production.signalbox.io/api/route/${rid}`).catch(() => null)
      : Promise.resolve(null);

    const [rttRes, routeRes] = await Promise.all([rttPromise, routePromise]);
        const rttData = await rttRes.json();
        const routeData = routeRes?.ok ? await routeRes.json() : null;
        const fullRouteGeometry = toLineStringGeometry(routeData);

    const service = rttData.service;
    if (!service) return NextResponse.json({ error: 'Missing service object' }, { status: 500 });

    // --- FIX: Define the missing variables ---
    const meta = service.scheduleMetadata;
    const locations = service.locations || [];
    const filteredLocations = showPass ? locations : locations.filter((loc: any) => !isPassingPoint(loc));
    const origin = filteredLocations[0];
    const destination = filteredLocations[filteredLocations.length - 1];
    // -----------------------------------------

    // 1. Resolve stop locations from Convex using crsCodes
    const locationsWithCoords = await Promise.all(
      filteredLocations.map(async (loc: any) => {
        const crs = loc.location.shortCodes?.[0];
        let stopData = null;
        if (crs) {
          stopData = await fetchQuery(api.functions.stops.getGroupByCode, { code: crs });
        }
        return { ...loc, stopData };
      })
    );

    // 2. Merge Stop and Track
    const full_route = mergeTrainStopAndTrack(locationsWithCoords, routeData, uid, date);
    const allocationData = await fetchAllocationFromRTT(uid, date, rttData);

    const responsePayload: Record<string, any> = {
      service_number: meta?.trainReportingIdentity ?? "Unknown",
      operator: meta?.operator?.name ?? "Unknown",
      operator_slug: meta?.operator?.code?.toLowerCase() ?? "unknown",
      service_date: meta?.departureDate ? new Date(meta.departureDate).getTime() : Date.now(),
      origin_name: origin?.location?.description ?? "Unknown Origin",
      origin_stop_code: origin?.location?.shortCodes?.[0] ?? null,
      destination_name: destination?.location?.description ?? "Unknown Destination",
      destination_stop_code: destination?.location?.shortCodes?.[0] ?? null,
      scheduled_departure: origin?.temporalData?.departure?.scheduleInternal,
      actual_departure: origin?.temporalData?.departure?.realtimeActual || origin?.temporalData?.departure?.realtimeForecast,
      scheduled_arrival: destination?.temporalData?.arrival?.scheduleInternal,
      actual_arrival: destination?.temporalData?.arrival?.realtimeActual || destination?.temporalData?.arrival?.realtimeForecast,
      full_route_geometry: fullRouteGeometry,
      full_locations: full_route,
      full_route: full_route,
      unit: allocationData,
    };

    if (debug) {
      responsePayload._debug = {
        rtt_allocation_data: rttData?.allocationData ?? null,
        rtt_service_keys: rttData ? Object.keys(rttData) : [],
        parsed_allocation: allocationData,
        uid,
        date,
      };
    }

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function handleBusRequest(uid: string, date: string, debug: boolean, bustimesBaseUrl: string) {
  log(`Processing bus trip: ${uid} for ${date}`);

  try {
    // Always fetch the trip directly — this is the source of truth for stops + track (scheduled/intended)
    const tripGeomRes = await fetch(buildBustimesUrl(bustimesBaseUrl, `/api/trips/${uid}/`));
    if (!tripGeomRes.ok) {
      return NextResponse.json({ error: 'Bus trip not found on bustimes.org' }, { status: 404 });
    }
    const geomData = await tripGeomRes.json();
    const geomTimes: any[] = geomData?.times ?? [];

    // Journey lookup via trip+date — per user spec, this resolves the vehicle journey ID
    // e.g. https://bustimes.org/api/vehiclejourneys/?vehicle=&service=&trip=644171025&source=&datetime=&date=2026-08-24
    let journeyLookupData: any = null;
    let tripData: any = null;
    let vehicleDetails: any = null;
    let resolvedJourneyId: number | null = null;
    let rawPolyline: string | null = null;
    let actualGeometry: { type: string; coordinates: [number, number][] } | null = null;

    const journeyLookupRes = await fetch(
      buildBustimesUrl(bustimesBaseUrl, `/api/vehiclejourneys/?vehicle=&service=&trip=${uid}&source=&datetime=&date=${date}`)
    );

    if (journeyLookupRes.ok) {
      journeyLookupData = await journeyLookupRes.json();
      const journeyId = journeyLookupData?.results?.[0]?.id;
      if (journeyId) {
        resolvedJourneyId = typeof journeyId === 'number' ? journeyId : Number(journeyId);
        const journeyDetailsRes = await fetch(buildBustimesUrl(bustimesBaseUrl, `/api/vehiclejourneys/${journeyId}/details/`));
        if (journeyDetailsRes.ok) {
          tripData = await journeyDetailsRes.json();
          rawPolyline = tripData?.time_aware_polyline ?? null;
          if (rawPolyline) {
            const coords = decodeTimeAwarePolyline(rawPolyline);
            if (coords.length > 0) actualGeometry = { type: "LineString", coordinates: coords };
          }
          const vehicleStub = tripData?.vehicle ?? tripData?.trip?.vehicle ?? null;
          if (vehicleStub?.id) {
            const vDetailsRes = await fetch(buildBustimesUrl(bustimesBaseUrl, `/api/vehicles/${vehicleStub.id}/`));
            if (vDetailsRes.ok) vehicleDetails = await vDetailsRes.json();
          }
        }
      }
    }

    // Use realtime times if available, otherwise fall back to geom times
    const trip = tripData?.trip ?? tripData ?? geomData;
    const realtimeTimes: any[] = trip?.times ?? [];
    const stops = realtimeTimes.length > 0 ? realtimeTimes : geomTimes;

    const firstStop = stops[0];
    const lastStop = stops[stops.length - 1];

    const getAimedArrival = (time: any) => time?.aimed_arrival_time ?? null;
    const getAimedDeparture = (time: any) => time?.aimed_departure_time ?? null;
    const getActualArrival = (time: any) =>
      time?.actual_arrival_time ??
      time?.expected_arrival_time ??
      time?.aimed_arrival_time ??
      null;
    const getActualDeparture = (time: any) =>
      time?.actual_departure_time ??
      time?.expected_departure_time ??
      time?.aimed_departure_time ??
      null;

    const full_route = stops.map((time: any, index: number) => {
      const isFirst = index === 0;
      const track = !isFirst && time.track?.length > 0
        ? time.track
        : (!isFirst && geomTimes[index]?.track?.length > 0
          ? geomTimes[index].track
          : null);

      const uniqueId = `bus-${uid}-${date}-${time.stop.atco_code ?? index}`;

      return {
        id: hashStringToNumber(uniqueId),
        stop: {
          stop_code: time.stop.atco_code,
          name: time.stop.name,
          location: time.stop.location,
          bearing: null,
          icon: null,
        },
        scheduled_arrival: getAimedArrival(time),
        scheduled_departure: getAimedDeparture(time),
        actual_arrival: getActualArrival(time),
        actual_departure: getActualDeparture(time),
        track,
        timing_status: time.timing_status || time.status || "scheduled",
        pick_up: time.pick_up ?? true,
        set_down: time.set_down ?? true,
      };
    });

    // Scheduled (intended) geometry from trip's track data
    const scheduledTrackCoords = geomTimes
      .filter((t: any) => t.track && Array.isArray(t.track))
      .flatMap((t: any) => t.track);
    let scheduledGeometry: { type: string; coordinates: [number, number][] } | null = null;
    if (scheduledTrackCoords.length > 0) {
      scheduledGeometry = { type: "LineString", coordinates: scheduledTrackCoords as [number, number][] };
    } else {
      const stitched: [number, number][] = [];
      let lastLoc: [number, number] | null = null;
      for (const t of geomTimes) {
        const loc = t.stop?.location;
        const hasTrack = Array.isArray(t.track) && t.track.length > 0;
        if (hasTrack) { stitched.push(...t.track); lastLoc = t.track[t.track.length-1] ?? null; }
        else if (Array.isArray(loc) && loc.length >= 2) {
          const pt: [number, number] = [loc[0], loc[1]];
          if (lastLoc) stitched.push(lastLoc, pt);
          lastLoc = pt;
        }
      }
      if (stitched.length > 1) scheduledGeometry = { type: "LineString", coordinates: stitched };
    }

    // For backward compat, stitchedGeometry is the combined fallback; but prefer scheduled
    const stitchedCoords: [number, number][] = [];
    let lastLoc2: [number, number] | null = null;
    for (const t of stops) {
      const loc = t.stop?.location;
      const hasTrack = Array.isArray(t.track) && t.track.length > 0;
      if (hasTrack) {
        stitchedCoords.push(...t.track);
        lastLoc2 = t.track[t.track.length - 1] ?? null;
      } else if (Array.isArray(loc) && loc.length >= 2) {
        const point: [number, number] = [loc[0], loc[1]];
        if (lastLoc2) stitchedCoords.push(lastLoc2, point);
        lastLoc2 = point;
      }
    }
    const stitchedGeometry = stitchedCoords.length > 1
      ? { type: "LineString", coordinates: stitchedCoords }
      : null;

    const fullRouteGeometry = scheduledGeometry ?? stitchedGeometry ?? null;

    // Polyline path for frontend ridden-route clipping is the actual GPS when available
    const polylinePath = actualGeometry?.coordinates ?? null;

    // Build scheduled/actual route arrays for saving (bus-only actual tracking)
    const scheduled_route = geomTimes.map((time: any, index: number) => {
      const uniqueId = `scheduled-${uid}-${date}-${time.stop.atco_code ?? index}`;
      return {
        id: hashStringToNumber(uniqueId),
        stop: { stop_code: time.stop.atco_code, name: time.stop.name, location: time.stop.location, bearing: null, icon: null },
        scheduled_arrival: time?.aimed_arrival_time ?? null,
        scheduled_departure: time?.aimed_departure_time ?? null,
        actual_arrival: null,
        actual_departure: null,
        track: time.track ?? null,
        timing_status: time.timing_status || "scheduled",
        pick_up: time.pick_up ?? true, set_down: time.set_down ?? true,
      };
    });

    const tripIdNum = Number(uid);

    const responsePayload: Record<string, any> = {
      service_number: geomData?.service?.line_name ?? trip?.service?.line_name ?? "Unknown",
      operator: geomData?.operator?.name ?? trip?.operator?.name ?? "Unknown Operator",
      operator_slug: geomData?.operator?.slug ?? geomData?.operator?.noc?.toLowerCase?.() ?? "unknown",
      service_date: dateToTimestamp(date),
      bustimes_service_id: typeof geomData?.service?.id === "number" ? geomData.service.id : undefined,
      bustimes_service_slug: geomData?.service?.slug ?? undefined,
      bustimes_trip_id: Number.isFinite(tripIdNum) ? tripIdNum : undefined,
      vehicle_journey_id: resolvedJourneyId ?? undefined,
      time_aware_polyline: rawPolyline ?? undefined,
      origin_name: firstStop?.stop?.name ?? "Unknown Origin",
      origin_stop_code: firstStop?.stop?.atco_code ?? null,
      destination_name: geomData?.headsign ?? lastStop?.stop?.name ?? "Unknown",
      destination_stop_code: lastStop?.stop?.atco_code ?? null,
      scheduled_departure: getAimedDeparture(firstStop),
      actual_departure: getActualDeparture(firstStop),
      scheduled_arrival: getAimedArrival(lastStop),
      actual_arrival: getActualArrival(lastStop),
      full_route_geometry: fullRouteGeometry,
      scheduled_geometry: scheduledGeometry,
      actual_geometry: actualGeometry,
      polyline_path: polylinePath,
      full_locations: full_route,
      full_route: full_route,
      scheduled_route: scheduled_route.length > 0 ? scheduled_route : undefined,
      actual_route: full_route, // actual per-stop times are on full_route when journey details were found
      available_journeys: Array.isArray(journeyLookupData?.results) ? journeyLookupData.results.map((r: any) => ({ id: r.id, datetime: r.datetime, vehicle: r.vehicle, route_name: r.route_name, destination: r.destination, trip_id: r.trip_id })) : undefined,
      unit: vehicleDetails ? {
        "0": {
          unit_number: vehicleDetails.fleet_code || vehicleDetails.fleet_number || null,
          unit_reg: vehicleDetails.reg || null,
          unit_type: vehicleDetails.vehicle_type?.name || "Bus",
          livery: vehicleDetails.livery?.name || null,
          livery_left: vehicleDetails.livery?.left || null,
        }
      } : null,
      debug: debug ? {
        journey_lookup_raw: journeyLookupData,
        trip_raw: tripData,
        geom_raw: geomData,
        vehicle_raw: vehicleDetails,
      } : undefined,
    };

    return NextResponse.json(responsePayload);

  } catch (error: any) {
    log(`Bus Handler Error: ${error.message}`);
    return NextResponse.json({ error: 'Internal Bus API Error', details: error.message }, { status: 500 });
  }
}

async function handleJourneyRequest(
  journeyId: string,
  date: string | null,
  debug: boolean,
  bustimesBaseUrl: string,
) {
  log(`Processing bus journey: ${journeyId}`);

  const journeyRes = await fetch(
    buildBustimesUrl(bustimesBaseUrl, `/api/vehiclejourneys/${journeyId}/details/`),
  );

  if (!journeyRes.ok) {
    return NextResponse.json({ error: 'Journey not found on bustimes.org' }, { status: 404 });
  }

  const journeyData = await journeyRes.json();
  const trip = journeyData?.trip;
  const tripId = trip?.id ?? journeyData?.trip_id;
  let times: any[] = trip?.times ?? [];

  // Fetch scheduled trip data (intended route) separately so we can store both.
  let scheduledTimes: any[] = [];
  let scheduledServiceMeta: any = null;
  if (tripId) {
    const tripGeomRes = await fetch(buildBustimesUrl(bustimesBaseUrl, `/api/trips/${tripId}/`));
    if (tripGeomRes.ok) {
      const geomData = await tripGeomRes.json();
      scheduledTimes = geomData?.times ?? [];
      scheduledServiceMeta = geomData ?? null;
    }
  }

  // Journey times are the per-stop schedule+actuals from the vehicle journey itself.
  // Use scheduledTimes as primary if available, otherwise journey times.
  const timesForFallback = scheduledTimes.length > 0 ? scheduledTimes : times;

  if (times.length === 0 && scheduledTimes.length === 0) {
    const serviceId = trip?.service?.id ?? journeyData?.service?.id;
    if (serviceId) {
      const svcRes = await fetch(
        buildBustimesUrl(bustimesBaseUrl, `/services/${serviceId}.json`),
      );
      if (svcRes.ok) {
        const svcData = await svcRes.json();
        const features = svcData?.stops?.features;
        if (Array.isArray(features) && features.length > 0) {
          const svcTimes = features.map((feature: any, index: number) => ({
            stop: {
              atco_code: feature.properties?.url?.replace("/stops/", "") ?? `svc-${index}`,
              name: feature.properties?.name ?? "Unknown",
              location: feature.geometry?.coordinates ?? null,
              bearing: feature.properties?.bearing ?? null,
              icon: null,
            },
            aimed_arrival_time: null,
            aimed_departure_time: null,
            expected_arrival_time: null,
            expected_departure_time: null,
            track: null,
            timing_status: "scheduled",
            pick_up: true,
            set_down: true,
          }));
          times = svcTimes;
          if (scheduledTimes.length === 0) scheduledTimes = svcTimes;
        }
      }
    }
  }

  // Ensure we have at least some times to build stops from.
  const effectiveTimes = times.length > 0 ? times : scheduledTimes;
  if (effectiveTimes.length === 0) {
    return NextResponse.json({ error: 'No stop data in journey' }, { status: 404 });
  }

  let vehicleDetails: any = null;
  const vehicleStub = journeyData?.vehicle;
  if (vehicleStub?.id) {
    const vRes = await fetch(buildBustimesUrl(bustimesBaseUrl, `/api/vehicles/${vehicleStub.id}/`));
    if (vRes.ok) vehicleDetails = await vRes.json();
  }

  // ── Actual geometry: the time_aware_polyline is the vehicle's actual GPS trace.
  let actualGeometry: { type: string; coordinates: [number, number][] } | null = null;
  let polylinePath: [number, number][] | null = null;
  const rawPolyline: string | null = journeyData?.time_aware_polyline ?? null;
  if (rawPolyline) {
    const coords = decodeTimeAwarePolyline(rawPolyline);
    if (coords.length > 0) {
      polylinePath = coords;
      actualGeometry = { type: "LineString", coordinates: coords };
    }
  }

  // ── Scheduled geometry: the intended route from the trip's track data.
  let scheduledGeometry: { type: string; coordinates: [number, number][] } | null = null;
  const scheduledTrackCoords = scheduledTimes
    .filter((t: any) => t.track && Array.isArray(t.track))
    .flatMap((t: any) => t.track);
  if (scheduledTrackCoords.length > 0) {
    scheduledGeometry = { type: "LineString", coordinates: scheduledTrackCoords as [number, number][] };
  }
  if (!scheduledGeometry) {
    const interleaved: [number, number][] = [];
    let lastLoc: [number, number] | null = null;
    const sourceForGeom = scheduledTimes.length > 0 ? scheduledTimes : effectiveTimes;
    for (const t of sourceForGeom) {
      const loc = t.stop?.location;
      const hasTrack = Array.isArray(t.track) && t.track.length > 0;
      if (hasTrack) {
        interleaved.push(...t.track);
        lastLoc = t.track[t.track.length - 1] ?? null;
      } else if (Array.isArray(loc) && loc.length >= 2) {
        const point: [number, number] = [loc[0], loc[1]];
        if (lastLoc) interleaved.push(lastLoc, point);
        lastLoc = point;
      }
    }
    if (interleaved.length > 1) {
      scheduledGeometry = { type: "LineString", coordinates: interleaved };
    }
  }

  // For backward compat, fullRouteGeometry prefers scheduled, falls back to actual.
  const fullRouteGeometry = scheduledGeometry ?? actualGeometry ?? null;

  const resolvedDate = date || journeyData?.date || journeyData?.datetime?.split("T")[0] || "";

  const getAimedArrival = (time: any) => time?.aimed_arrival_time ?? null;
  const getAimedDeparture = (time: any) => time?.aimed_departure_time ?? null;
  const getActualArrival = (time: any) =>
    time?.actual_arrival_time ?? time?.expected_arrival_time ?? null;
  const getActualDeparture = (time: any) =>
    time?.actual_departure_time ?? time?.expected_departure_time ?? null;

  // Helpers to map a times array to RouteStop[]
  const mapTimes = (source: any[], prefix: string) =>
    source.map((time: any, index: number) => {
      const isFirst = index === 0;
      const track = !isFirst && time.track?.length > 0 ? time.track : null;
      const uniqueId = `${prefix}-${journeyId}-${time.stop.atco_code ?? index}`;
      return {
        id: hashStringToNumber(uniqueId),
        stop: {
          stop_code: time.stop.atco_code,
          name: time.stop.name,
          location: time.stop.location,
          bearing: time.stop.bearing ?? null,
          icon: time.stop.icon ?? null,
        },
        scheduled_arrival: getAimedArrival(time),
        scheduled_departure: getAimedDeparture(time),
        actual_arrival: getActualArrival(time),
        actual_departure: getActualDeparture(time),
        track,
        timing_status: time.timing_status || "scheduled",
        pick_up: time.pick_up ?? true,
        set_down: time.set_down ?? true,
      };
    });

  // full_route stays as before (from journey times) for backward compat.
  const full_route = mapTimes(effectiveTimes, "journey");
  // scheduled_route: the intended stops/geometry from the trip endpoint.
  const scheduled_route = scheduledTimes.length > 0 ? mapTimes(scheduledTimes, "scheduled") : full_route;
  // actual_route: if time_aware polyline exists we still have per-stop actual times on journey times,
  // so expose journey times as actual_route for completeness.
  const actual_route = mapTimes(effectiveTimes, "actual");

  const firstStop = effectiveTimes[0];
  const lastStop = effectiveTimes[effectiveTimes.length - 1];
  const vehicleUnit = vehicleDetails
    ? {
        "0": {
          unit_number: vehicleDetails.fleet_code || vehicleDetails.fleet_number || null,
          unit_reg: vehicleDetails.reg || null,
          unit_type: vehicleDetails.vehicle_type?.name || "Bus",
          livery: vehicleDetails.livery?.name || null,
          livery_left: vehicleDetails.livery?.left || null,
        },
      }
    : journeyData?.vehicle
    ? {
        "0": {
          unit_number: journeyData.vehicle.fleet_code || null,
          unit_reg: journeyData.vehicle.reg || null,
          unit_type: "Bus",
          livery: null,
          livery_left: null,
        },
      }
    : null;

  const bustimesTripIdNum = typeof tripId === 'number' ? tripId : (tripId ? Number(tripId) : undefined);
  const vehicleJourneyIdNum = Number(journeyId);
  return NextResponse.json({
    service_number: trip?.service?.line_name ?? journeyData?.route_name ?? "Unknown",
    operator: trip?.operator?.name ?? "Unknown Operator",
    operator_slug: trip?.operator?.slug ?? "unknown",
    service_date: dateToTimestamp(resolvedDate),
    bustimes_service_id: trip?.service?.id ?? journeyData?.service?.id,
    bustimes_service_slug: trip?.service?.slug ?? journeyData?.service?.slug,
    bustimes_trip_id: Number.isFinite(bustimesTripIdNum as number) ? (bustimesTripIdNum as number) : undefined,
    vehicle_journey_id: Number.isFinite(vehicleJourneyIdNum) ? vehicleJourneyIdNum : undefined,
    time_aware_polyline: rawPolyline ?? undefined,
    origin_name: firstStop?.stop?.name ?? "Unknown Origin",
    origin_stop_code: firstStop?.stop?.atco_code ?? null,
    destination_name: journeyData?.destination ?? lastStop?.stop?.name ?? "Unknown",
    destination_stop_code: lastStop?.stop?.atco_code ?? null,
    scheduled_departure: getAimedDeparture(firstStop),
    actual_departure: getActualDeparture(firstStop),
    scheduled_arrival: getAimedArrival(lastStop),
    actual_arrival: getActualArrival(lastStop),
    // Backward compat
    full_route_geometry: fullRouteGeometry,
    scheduled_geometry: scheduledGeometry,
    actual_geometry: actualGeometry,
    polyline_path: polylinePath,
    full_locations: full_route,
    full_route: full_route,
    scheduled_route,
    actual_route,
    unit: vehicleUnit,
    debug: debug
      ? {
          journey_raw: journeyData,
          vehicle_raw: vehicleDetails,
        }
      : undefined,
  });
}