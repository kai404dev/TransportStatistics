import { query, type QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { getAllUserTrips, getUserTripsForYear, getUserTripsForMonth } from "./userTrips";

type TripUnitLike = {
  unit_number?: string;
  unit_reg?: string;
  unit_type?: string;
  livery?: string;
  livery_left?: string;
};

async function getDistanceFallbackKm(
  ctx: QueryCtx,
  tripsMissingDistance: Doc<"tripLogs">[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (tripsMissingDistance.length === 0) return result;

  const detailsList = await Promise.all(
    tripsMissingDistance.map((trip) =>
      trip.full_route !== undefined || trip.ridden_route !== undefined
        ? Promise.resolve(null)
        : ctx.db
            .query("tripRouteDetails")
            .withIndex("by_tripId", (q) => q.eq("tripId", trip._id))
            .first(),
    ),
  );

  tripsMissingDistance.forEach((trip, i) => {
    const details = detailsList[i];
    const fullRoute = trip.full_route ?? details?.full_route;
    const riddenRoute = trip.ridden_route ?? details?.ridden_route;
    const coords: [number, number][] =
      (riddenRoute as { geometry?: { coordinates?: [number, number][] } } | undefined)?.geometry
        ?.coordinates ??
      (fullRoute as { coordinates?: [number, number][] } | undefined)?.coordinates ??
      [];
    let total = 0;
    for (let j = 1; j < coords.length; j++) {
      const prev = coords[j - 1];
      const curr = coords[j];
      if (
        Array.isArray(prev) &&
        Array.isArray(curr) &&
        typeof prev[0] === "number" &&
        typeof prev[1] === "number" &&
        typeof curr[0] === "number" &&
        typeof curr[1] === "number"
      ) {
        total += haversineKm([prev[0], prev[1]], [curr[0], curr[1]]);
      }
    }
    if (total > 0) result.set(String(trip._id), total);
  });

  return result;
}

async function getCompanionsByTrip(
  ctx: QueryCtx,
  trips: Doc<"tripLogs">[],
  userId: string,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (trips.length === 0) return result;

  // Single viewer lookup instead of one per trip.
  const viewer = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", userId))
    .first();
  const viewerUsername = viewer?.username;

  // One small participants query per trip (participant rows are tiny).
  const participantsByTrip = await Promise.all(
    trips.map((trip) =>
      ctx.db
        .query("tripParticipants")
        .withIndex("by_tripId_user", (q) => q.eq("tripId", trip._id))
        .collect(),
    ),
  );

  // Batch user lookups: each distinct clerkId is read exactly once.
  const clerkIds = new Set<string>();
  participantsByTrip.forEach((participants, i) => {
    for (const p of participants) {
      if (p.user !== userId) clerkIds.add(p.user);
    }
    const trip = trips[i];
    if (participants.some((p) => p.user === userId) && trip.user !== userId) {
      clerkIds.add(trip.user);
    }
  });
  const uniqueIds = [...clerkIds];
  const users = await Promise.all(
    uniqueIds.map((clerkId) =>
      ctx.db.query("users").withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId)).first(),
    ),
  );
  const usernameByClerkId = new Map<string, string>();
  users.forEach((u, i) => {
    if (u) usernameByClerkId.set(uniqueIds[i], u.username);
  });

  trips.forEach((trip, i) => {
    const companions = new Set<string>(trip.on_trip_with ?? []);
    if (viewerUsername) companions.delete(viewerUsername);
    for (const p of participantsByTrip[i]) {
      if (p.user === userId) continue;
      const username = usernameByClerkId.get(p.user);
      if (username) companions.add(username);
    }
    if (participantsByTrip[i].some((p) => p.user === userId) && trip.user !== userId) {
      const ownerUsername = usernameByClerkId.get(trip.user);
      if (ownerUsername && ownerUsername !== viewerUsername) companions.add(ownerUsername);
    }
    result.set(
      String(trip._id),
      [...companions].filter((name) => name.trim().length > 0),
    );
  });

  return result;
}

type StatsAccumulators = {
  totalDistanceKm: number;
  totalMinutes: number;
  totalDelayMins: number;
  punctualityCount: number;
  tripWithTimes: number;
  liveryCounts: Record<string, { count: number; css: string; name: string }>;
  typeCounts: Record<string, number>;
  operatorCounts: Record<string, { count: number; slug: string }>;
  tripsByMonth: Record<string, number>;
  routeGroups: Record<string, { count: number; serviceNum: string; stationPairs: Record<string, number> }>;
  companionCounts: Record<string, number>;
  dayOfWeekCounts: Record<string, number>;
  unitTypeCounts: Record<string, number>;
  stopCounts: Record<string, number>;
  dailyCounts: Record<string, number>;
  dates: string[];
};

function emptyAccumulators(): StatsAccumulators {
  return {
    totalDistanceKm: 0,
    totalMinutes: 0,
    totalDelayMins: 0,
    punctualityCount: 0,
    tripWithTimes: 0,
    liveryCounts: {},
    typeCounts: {},
    operatorCounts: {},
    tripsByMonth: {},
    routeGroups: {},
    companionCounts: {},
    dayOfWeekCounts: { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 },
    unitTypeCounts: {},
    stopCounts: {},
    dailyCounts: {},
    dates: [],
  };
}

// Single pass over trips producing mergeable accumulators. Shared by the
// legacy getUserStats query and the chunked getUserStatsChunk query.
function accumulateTripStats(
  trips: Doc<"tripLogs">[],
  distanceFallbackKm: Map<string, number>,
  companionsByTrip: Map<string, string[]>,
  timeZone: string,
): StatsAccumulators {
  const acc = emptyAccumulators();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const allDates = new Set<string>();

  for (const trip of trips) {
    // Distance (route geometry only fetched up front for trips missing distance_km)
    if (typeof trip.distance_km === "number") {
      acc.totalDistanceKm += trip.distance_km;
    } else {
      acc.totalDistanceKm += distanceFallbackKm.get(String(trip._id)) ?? 0;
    }

    // Time & Delay
    const dep = trip.actual_departure ?? trip.scheduled_departure;
    const arr = trip.actual_arrival ?? trip.scheduled_arrival;
    if (dep && arr) {
      const depDate = new Date(`${formatDate(trip.service_date, timeZone)}T${dep}`);
      const arrDate = new Date(`${formatDate(trip.service_date, timeZone)}T${arr}`);
      const diff = (arrDate.getTime() - depDate.getTime()) / 60000;
      if (diff > 0 && diff < 1440) acc.totalMinutes += diff;

      const schDate = new Date(`1970-01-01T${trip.scheduled_arrival}`);
      const actDate = new Date(`1970-01-01T${trip.actual_arrival}`);
      const delay = (actDate.getTime() - schDate.getTime()) / 60000;
      if (delay >= 0) {
        acc.totalDelayMins += delay;
        if (delay <= 1) acc.punctualityCount++;
        acc.tripWithTimes++;
      }
    }

    // Liveries & Unit types
    const units: TripUnitLike[] = Array.isArray(trip.units) ? trip.units : [];
    for (const unit of units) {
      const name = unit.livery ?? trip.livery_name ?? "";
      if (name) {
        const css = unit.livery_left ?? trip.livery_css ?? "";
        if (!acc.liveryCounts[name]) acc.liveryCounts[name] = { count: 0, css, name };
        acc.liveryCounts[name].count++;
      }
      const utype = unit.unit_type ?? trip.unit_type;
      if (utype) acc.unitTypeCounts[utype] = (acc.unitTypeCounts[utype] ?? 0) + 1;
    }
    if (units.length === 0) {
      if (trip.livery_name) {
        const { livery_name: name, livery_css: css } = trip;
        if (!acc.liveryCounts[name]) acc.liveryCounts[name] = { count: 0, css: css ?? "", name };
        acc.liveryCounts[name].count++;
      }
      if (trip.unit_type) acc.unitTypeCounts[trip.unit_type] = (acc.unitTypeCounts[trip.unit_type] ?? 0) + 1;
    }

    // Transport type
    const ttype = trip.transport_type ?? "Other";
    acc.typeCounts[ttype] = (acc.typeCounts[ttype] ?? 0) + 1;

    // Operator
    const opName = trip.operator ?? "Unknown";
    if (!acc.operatorCounts[opName]) acc.operatorCounts[opName] = { count: 0, slug: trip.operator_slug ?? "" };
    acc.operatorCounts[opName].count++;

    // Month
    const { year, month } = getDateParts(trip.service_date, timeZone);
    const monthKey = `${year}-${month}`;
    acc.tripsByMonth[monthKey] = (acc.tripsByMonth[monthKey] ?? 0) + 1;

    // Routes
    const origin = trip.origin_name ?? "Unknown";
    const destination = trip.destination_name ?? "Unknown";
    const serviceId = trip.bustimes_service_id?.toString();
    const serviceNum = trip.service_number ?? "Unknown";
    const stationsLabel = [origin, destination].sort().join(" ↔ ");
    const groupKey = serviceId ? `sid-${serviceId}` : `fallback-${serviceNum}-${stationsLabel}`;
    if (!acc.routeGroups[groupKey]) acc.routeGroups[groupKey] = { count: 0, serviceNum, stationPairs: {} };
    acc.routeGroups[groupKey].count++;
    acc.routeGroups[groupKey].stationPairs[stationsLabel] = (acc.routeGroups[groupKey].stationPairs[stationsLabel] ?? 0) + 1;

    // Social
    for (const person of companionsByTrip.get(String(trip._id)) ?? []) {
      acc.companionCounts[person] = (acc.companionCounts[person] ?? 0) + 1;
    }

    // Day of week
    const dateStr = formatDate(trip.service_date, timeZone);
    const dateObj = new Date(`${dateStr}T00:00:00`);
    acc.dayOfWeekCounts[days[dateObj.getDay()]]++;

    // Stops
    acc.stopCounts[origin] = (acc.stopCounts[origin] ?? 0) + 1;
    acc.stopCounts[destination] = (acc.stopCounts[destination] ?? 0) + 1;

    allDates.add(dateStr);
    acc.dailyCounts[dateStr] = (acc.dailyCounts[dateStr] ?? 0) + 1;
  }

  acc.dates = [...allDates].sort();
  return acc;
}

export const getUserStats = query({
  args: { user: v.string(), year: v.optional(v.number()), timeZone: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const timeZone = args.timeZone ?? "UTC";

    // When year is specified, filter at the DB level via the
    // by_user_service_date index — avoids reading the whole log (and blowing
    // the 16MB per-execution byte budget) just to keep one year.
    const trips = args.year
      ? await getUserTripsForYear(ctx, args.user, args.year)
      : await getAllUserTrips(ctx, args.user);

    if (trips.length === 0) return null;

    // Batch the per-trip lookups up front: route details only for trips
    // missing distance_km, and one participants query per trip with each
    // distinct user read exactly once.
    const [distanceFallbackKm, companionsByTrip, dayRecords] = await Promise.all([
      getDistanceFallbackKm(
        ctx,
        trips.filter((trip) => typeof trip.distance_km !== "number"),
      ),
      getCompanionsByTrip(ctx, trips, args.user),
      ctx.db
        .query("userTripDays")
        .withIndex("by_user", (q) => q.eq("user", args.user))
        .collect(),
    ]);

    const {
      totalDistanceKm,
      totalMinutes,
      totalDelayMins,
      punctualityCount,
      tripWithTimes,
      liveryCounts,
      typeCounts,
      operatorCounts,
      tripsByMonth,
      routeGroups,
      companionCounts,
      dayOfWeekCounts,
      unitTypeCounts,
      stopCounts,
      dailyCounts,
      dates,
    } = accumulateTripStats(trips, distanceFallbackKm, companionsByTrip, timeZone);

    // ── Derive final shapes ──
    // Years come from the lightweight userTripDays cache (one tiny doc per
    // day) so the year selector stays complete even when a year filter is
    // active — deriving them from the filtered trips would collapse the
    // dropdown to just the selected year.
    const availableYears =
      dayRecords.length > 0
        ? [
            ...new Set(
              dayRecords
                .map((d) => Number(d.day.slice(0, 4)))
                .filter((y) => Number.isFinite(y)),
            ),
          ].sort((a, b) => b - a)
        : [
            ...new Set(trips.map((t) => getYearFromTimestamp(t.service_date, timeZone))),
          ].sort((a, b) => b - a);

    const topLiveries = Object.values(liveryCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topTypes = Object.entries(typeCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const topOperators = Object.entries(operatorCounts)
      .map(([name, { count, slug }]) => ({ name, count, slug }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const tripsPerMonth = Object.entries(tripsByMonth)
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const topRoutes = Object.values(routeGroups)
      .map((g) => ({
        route: `${g.serviceNum}: ${
          Object.entries(g.stationPairs).sort((a, b) => b[1] - a[1])[0][0]
        }`,
        count: g.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const sortedDates = [...dates].sort();
    let maxStreak = 0;
    let currentStreak = 0;
    for (let i = 0; i < sortedDates.length; i++) {
      if (i > 0) {
        const prev = new Date(`${sortedDates[i - 1]}T00:00:00`);
        const curr = new Date(`${sortedDates[i]}T00:00:00`);
        currentStreak =
          (curr.getTime() - prev.getTime()) / (1000 * 3600 * 24) === 1
            ? currentStreak + 1
            : 1;
      } else {
        currentStreak = 1;
      }
      maxStreak = Math.max(maxStreak, currentStreak);
    }

    const topCompanion = Object.entries(companionCounts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

    return {
      totalTrips: trips.length,
      totalDistanceKm: Math.round(totalDistanceKm),
      totalMinutes: Math.round(totalMinutes),
      topLiveries,
      topTypes,
      topOperators,
      tripsPerMonth,
      tripsByType: topTypes,
      topRoutes,
      uniqueOperators: Object.keys(operatorCounts).length,
      uniqueRoutes: Object.keys(routeGroups).length,
      availableYears,
      firstTripDate: sortedDates[0] ?? null,
      latestTripDate: sortedDates[sortedDates.length - 1] ?? null,
      onTimePercentage: tripWithTimes > 0 ? Math.round((punctualityCount / tripWithTimes) * 100) : 100,
      avgDelay: tripWithTimes > 0 ? (totalDelayMins / tripWithTimes).toFixed(1) : 0,
      topCompanionName: topCompanion[0],
      topCompanionCount: topCompanion[1],
      maxStreak,
      dayOfWeekCounts: Object.entries(dayOfWeekCounts).map(([day, count]) => ({ day, count })),
      dailyCounts,
      topUnitTypes: Object.entries(unitTypeCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      topStops: Object.entries(stopCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    };
  },
});

// ── Chunked stats feed ──
// getUserStats above reads a whole year (or the whole log) in ONE execution,
// which exceeds the 16MB per-execution byte budget for large logs. These two
// queries split the work so every execution stays bounded: the client fetches
// one small chunk per month and merges them (see app/stats/page.tsx).

export const getUserStatYears = query({
  args: { user: v.string() },
  handler: async (ctx, args) => {
    // Tiny docs (one per day), so collecting them is cheap.
    const dayRecords = await ctx.db
      .query("userTripDays")
      .withIndex("by_user", (q) => q.eq("user", args.user))
      .collect();
    return [
      ...new Set(
        dayRecords
          .map((d) => Number(d.day.slice(0, 4)))
          .filter((y) => Number.isFinite(y)),
      ),
    ].sort((a, b) => b - a);
  },
});

export const getUserStatsChunk = query({
  args: {
    user: v.string(),
    year: v.number(),
    month: v.number(),
    timeZone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const timeZone = args.timeZone ?? "UTC";
    const trips = await getUserTripsForMonth(ctx, args.user, args.year, args.month);
    if (trips.length === 0) return null;

    const [distanceFallbackKm, companionsByTrip] = await Promise.all([
      getDistanceFallbackKm(
        ctx,
        trips.filter((trip) => typeof trip.distance_km !== "number"),
      ),
      getCompanionsByTrip(ctx, trips, args.user),
    ]);

    const acc = accumulateTripStats(trips, distanceFallbackKm, companionsByTrip, timeZone);
    return { tripCount: trips.length, ...acc };
  },
});

function haversineKm([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getDateParts(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));

  return {
    year: parts.find((part) => part.type === "year")?.value ?? "0000",
    month: parts.find((part) => part.type === "month")?.value ?? "00",
    day: parts.find((part) => part.type === "day")?.value ?? "00",
  };
}

function getYearFromTimestamp(timestamp: number, timeZone: string) {
  return Number(getDateParts(timestamp, timeZone).year);
}

function formatDate(timestamp: number, timeZone: string): string {
  const { year, month, day } = getDateParts(timestamp, timeZone);
  return `${year}-${month}-${day}`;
}
