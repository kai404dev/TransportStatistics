import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

function normalizeServiceDate(value: number) {
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function getDayNumber(ms: number): number {
  return Math.floor(ms / 86_400_000);
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

function formatDateInTimezone(timestamp: number, timeZone: string): string {
  const { year, month, day } = getDateParts(timestamp, timeZone);
  return `${year}-${month}-${day}`;
}

function formatDayString(timestampMs: number, timeZone?: string): string {
  return formatDateInTimezone(timestampMs, timeZone ?? "UTC");
}

function parseDayKey(day: string): { year: number; month: number; day: number } | null {
  const parts = day.split("-").map(Number);
  if (parts.length !== 3) return null;
  const [year, month, dayNum] = parts;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(dayNum)) return null;
  if (!year || !month || !dayNum) return null;
  if (month < 1 || month > 12 || dayNum < 1 || dayNum > 31) return null;
  return { year, month, day: dayNum };
}

function getDayStartMs(year: number, month: number, day: number, timeZone?: string): number {
  if (timeZone) return getLocalDayStart(year, month, day, timeZone);
  return getDayNumber(Date.UTC(year, month - 1, day, 0, 0, 0)) * 86_400_000;
}

// service_date is stored inconsistently (ms for newer trips, seconds for older
// ones), so raw index order is not chronological across formats. Within a
// single format raw order is chronological, so read the head of each format
// range and merge in JS on the normalized value.
const MS_THRESHOLD = 1_000_000_000_000;

async function getLatestOwnedTrip(
  ctx: QueryCtx,
  userId: string,
  beforeMs?: number,
): Promise<Doc<"tripLogs"> | null> {
  const upperMs = beforeMs ?? Infinity;
  const upperSec = beforeMs !== undefined ? Math.floor(beforeMs / 1_000) : Infinity;
  const msHead: Promise<Doc<"tripLogs">[]> =
    upperMs <= MS_THRESHOLD
      ? Promise.resolve([])
      : upperMs === Infinity
        ? ctx.db
            .query("tripLogs")
            .withIndex("by_user_service_date", (q) =>
              q.eq("user", userId).gte("service_date", MS_THRESHOLD),
            )
            .order("desc")
            .take(1)
        : ctx.db
            .query("tripLogs")
            .withIndex("by_user_service_date", (q) =>
              q.eq("user", userId).gte("service_date", MS_THRESHOLD).lt("service_date", upperMs),
            )
            .order("desc")
            .take(1);
  const secHead: Promise<Doc<"tripLogs">[]> = ctx.db
    .query("tripLogs")
    .withIndex("by_user_service_date", (q) =>
      q.eq("user", userId).lt("service_date", Math.min(upperSec, MS_THRESHOLD)),
    )
    .order("desc")
    .take(1);
  const [msPage, secPage] = await Promise.all([msHead, secHead]);

  const candidates = [...msPage, ...secPage];
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => normalizeServiceDate(b.service_date) - normalizeServiceDate(a.service_date),
  );
  return candidates[0];
}

async function getParticipationTrips(ctx: QueryCtx, userId: string): Promise<Doc<"tripLogs">[]> {
  const participations = await ctx.db
    .query("tripParticipants")
    .withIndex("by_user", (q) => q.eq("user", userId))
    .collect();
  if (participations.length === 0) return [];
  const trips = await Promise.all(participations.map((p) => ctx.db.get(p.tripId)));
  return trips.filter((trip): trip is NonNullable<typeof trip> => trip !== null);
}

function maxNormalizedServiceDate(trips: Doc<"tripLogs">[]): number | null {
  let max: number | null = null;
  for (const trip of trips) {
    const ts = normalizeServiceDate(trip.service_date);
    if (max === null || ts > max) max = ts;
  }
  return max;
}

/**
 * Latest day (YYYY-MM-DD) that has any trip for the user (owned or joined).
 * Reads at most 2 owned index heads + the user's participations, so it stays
 * cheap no matter how large the trip log grows.
 */
export async function getLatestTripDay(
  ctx: QueryCtx,
  userId: string,
  timeZone?: string,
): Promise<string | null> {
  const [owned, participated] = await Promise.all([
    getLatestOwnedTrip(ctx, userId),
    getParticipationTrips(ctx, userId),
  ]);
  const max = maxNormalizedServiceDate([...(owned ? [owned] : []), ...participated]);
  if (max === null) return null;
  return formatDayString(max, timeZone);
}

/**
 * Latest day strictly before `beforeDay` that has any trip for the user.
 * Used to page backwards one day at a time.
 */
export async function getTripDayBefore(
  ctx: QueryCtx,
  userId: string,
  beforeDay: string,
  timeZone?: string,
): Promise<string | null> {
  const parsed = parseDayKey(beforeDay);
  if (!parsed) return null;
  const boundMs = getDayStartMs(parsed.year, parsed.month, parsed.day, timeZone);
  const [owned, participated] = await Promise.all([
    getLatestOwnedTrip(ctx, userId, boundMs),
    getParticipationTrips(ctx, userId),
  ]);
  const candidates = [
    ...(owned ? [owned] : []),
    ...participated.filter((trip) => normalizeServiceDate(trip.service_date) < boundMs),
  ];
  const max = maxNormalizedServiceDate(candidates);
  if (max === null) return null;
  return formatDayString(max, timeZone);
}

function getLocalDayStart(year: number, month: number, day: number, timeZone: string): number {
  const targetDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hourMs = 3_600_000;
  const minuteMs = 60_000;

  let ts = Date.UTC(year, month - 1, day);

  // Find a timestamp that falls on the target date in the timezone
  for (let i = 0; i < 48; i++) {
    const parts = getDateParts(ts, timeZone);
    const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
    if (currentDate === targetDate) break;
    if (currentDate < targetDate) {
      ts += hourMs;
    } else {
      ts -= hourMs;
    }
  }

  // Walk backwards by hours to get closer to the exact start of the day
  for (let i = 0; i < 24; i++) {
    const prev = ts - hourMs;
    const parts = getDateParts(prev, timeZone);
    const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
    if (currentDate !== targetDate) break;
    ts = prev;
  }

  // Fine-tune with minutes
  for (let i = 0; i < 60; i++) {
    const prev = ts - minuteMs;
    const parts = getDateParts(prev, timeZone);
    const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
    if (currentDate !== targetDate) break;
    ts = prev;
  }

  return ts;
}

function sortTripsDesc(trips: Doc<"tripLogs">[]): Doc<"tripLogs">[] {
  return trips.sort((a, b) => {
    const aTime = typeof a.logged_at === "number"
      ? a.logged_at
      : (a.service_date > 1_000_000_000_000 ? a.service_date : a.service_date * 1000);
    const bTime = typeof b.logged_at === "number"
      ? b.logged_at
      : (b.service_date > 1_000_000_000_000 ? b.service_date : b.service_date * 1000);

    if (aTime !== bTime) return bTime - aTime;
    return String(b._id).localeCompare(String(a._id));
  });
}

export async function getAllUserTrips(ctx: QueryCtx, userId: string): Promise<Doc<"tripLogs">[]> {
  const ownedTrips = await ctx.db
    .query("tripLogs")
    .withIndex("by_user", (q) => q.eq("user", userId))
    .collect();

  const participations = await ctx.db
    .query("tripParticipants")
    .withIndex("by_user", (q) => q.eq("user", userId))
    .collect();

  const participatedTrips = (await Promise.all(
    participations.map((p) => ctx.db.get(p.tripId))
  )).filter((trip): trip is NonNullable<typeof trip> => trip !== null);

  const byId = new Map<string, Doc<"tripLogs">>();
  for (const trip of ownedTrips) byId.set(String(trip._id), trip);
  for (const trip of participatedTrips) byId.set(String(trip._id), trip);

  return sortTripsDesc([...byId.values()]);
}

export async function getUserTripsForDateRange(
  ctx: QueryCtx,
  userId: string,
  dateKey: string,
  timeZone?: string,
): Promise<Doc<"tripLogs">[]> {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return [];

  let dayStartMs: number;
  let dayEndMs: number;
  let dayStartSec: number;
  let dayEndSec: number;

  if (timeZone) {
    dayStartMs = getLocalDayStart(year, month, day, timeZone);
    dayEndMs = dayStartMs + 86_400_000;
    dayStartSec = Math.floor(dayStartMs / 1_000);
    dayEndSec = Math.floor(dayEndMs / 1_000);
  } else {
    const targetDay = getDayNumber(Date.UTC(year, month - 1, day, 0, 0, 0));
    dayStartMs = targetDay * 86_400_000;
    dayEndMs = (targetDay + 1) * 86_400_000;
    dayStartSec = targetDay * 86_400;
    dayEndSec = (targetDay + 1) * 86_400;
  }

  const [ownedTripsMs, ownedTripsSec] = await Promise.all([
    ctx.db
      .query("tripLogs")
      .withIndex("by_user_service_date", (q) =>
        q.eq("user", userId).gte("service_date", dayStartMs).lt("service_date", dayEndMs),
      )
      .collect(),
    ctx.db
      .query("tripLogs")
      .withIndex("by_user_service_date", (q) =>
        q.eq("user", userId).gte("service_date", dayStartSec).lt("service_date", dayEndSec),
      )
      .collect(),
  ]);

  const byId = new Map<string, Doc<"tripLogs">>();
  for (const trip of ownedTripsMs) byId.set(String(trip._id), trip);
  for (const trip of ownedTripsSec) byId.set(String(trip._id), trip);

  const participations = await ctx.db
    .query("tripParticipants")
    .withIndex("by_user", (q) => q.eq("user", userId))
    .collect();

  const missingTrips = (await Promise.all(
    participations
      .filter((p) => !byId.has(String(p.tripId)))
      .map((p) => ctx.db.get(p.tripId)),
  )).filter((trip): trip is NonNullable<typeof trip> => trip !== null);

  for (const trip of missingTrips) {
    if (timeZone) {
      if (formatDateInTimezone(normalizeServiceDate(trip.service_date), timeZone) === dateKey) {
        byId.set(String(trip._id), trip);
      }
    } else {
      if (getDayNumber(normalizeServiceDate(trip.service_date)) === getDayNumber(Date.UTC(year, month - 1, day, 0, 0, 0))) {
        byId.set(String(trip._id), trip);
      }
    }
  }

  return sortTripsDesc([...byId.values()]);
}
