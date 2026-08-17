import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

function toDayString(serviceDate: number): string {
  if (!serviceDate || Number.isNaN(serviceDate)) return "invalid";
  const ts = serviceDate > 1_000_000_000_000 ? serviceDate : serviceDate * 1000;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function getOrCreateUserTripStats(
  ctx: MutationCtx,
  user: string
): Promise<Id<"userTripStats">> {
  const existing = await ctx.db
    .query("userTripStats")
    .withIndex("by_user", (q) => q.eq("user", user))
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("userTripStats", {
    user,
    trip_count: 0,
    day_count: 0,
    updated_at: Date.now(),
  });
}

/**
 * Increment trip and day counts for a user when a trip is added.
 */
export async function incrementUserTripStats(
  ctx: MutationCtx,
  user: string,
  serviceDate: number
): Promise<void> {
  const day = toDayString(serviceDate);
  const statsId = await getOrCreateUserTripStats(ctx, user);

  const dayRecord = await ctx.db
    .query("userTripDays")
    .withIndex("by_user_day", (q) => q.eq("user", user).eq("day", day))
    .first();

  if (dayRecord) {
    // Existing day — only increment trip_count
    await ctx.db.patch(dayRecord._id, { count: dayRecord.count + 1 });
    const stats = await ctx.db.get(statsId);
    if (stats) {
      await ctx.db.patch(statsId, {
        trip_count: stats.trip_count + 1,
        updated_at: Date.now(),
      });
    }
  } else {
    // New day — increment both trip_count and day_count
    await ctx.db.insert("userTripDays", { user, day, count: 1 });
    const stats = await ctx.db.get(statsId);
    if (stats) {
      await ctx.db.patch(statsId, {
        trip_count: stats.trip_count + 1,
        day_count: stats.day_count + 1,
        updated_at: Date.now(),
      });
    }
  }
}

/**
 * Decrement trip and day counts for a user when a trip is removed.
 */
export async function decrementUserTripStats(
  ctx: MutationCtx,
  user: string,
  serviceDate: number
): Promise<void> {
  const day = toDayString(serviceDate);

  const dayRecord = await ctx.db
    .query("userTripDays")
    .withIndex("by_user_day", (q) => q.eq("user", user).eq("day", day))
    .first();

  if (!dayRecord) return;

  const newCount = dayRecord.count - 1;
  const stats = await ctx.db
    .query("userTripStats")
    .withIndex("by_user", (q) => q.eq("user", user))
    .first();

  if (newCount <= 0) {
    await ctx.db.delete(dayRecord._id);
    if (stats) {
      await ctx.db.patch(stats._id, {
        trip_count: Math.max(0, stats.trip_count - 1),
        day_count: Math.max(0, stats.day_count - 1),
        updated_at: Date.now(),
      });
    }
  } else {
    await ctx.db.patch(dayRecord._id, { count: newCount });
    if (stats) {
      await ctx.db.patch(stats._id, {
        trip_count: Math.max(0, stats.trip_count - 1),
        updated_at: Date.now(),
      });
    }
  }
}

/**
 * Handle a service_date change for an existing trip.
 */
export async function moveUserTripStatsDay(
  ctx: MutationCtx,
  user: string,
  oldServiceDate: number,
  newServiceDate: number
): Promise<void> {
  await decrementUserTripStats(ctx, user, oldServiceDate);
  await incrementUserTripStats(ctx, user, newServiceDate);
}

/**
 * Read cached stats for a user. Returns null if no cache exists yet.
 */
export async function getCachedUserTripStats(
  ctx: QueryCtx,
  user: string
): Promise<{ trip_count: number; day_count: number } | null> {
  const stats = await ctx.db
    .query("userTripStats")
    .withIndex("by_user", (q) => q.eq("user", user))
    .first();
  if (!stats) return null;
  return { trip_count: stats.trip_count, day_count: stats.day_count };
}

/**
 * Recalculate stats from scratch for a user. Used for backfill / repair.
 */
export async function recalculateUserTripStats(
  ctx: MutationCtx,
  user: string,
  allTrips: Doc<"tripLogs">[]
): Promise<void> {
  const days = new Map<string, number>();
  for (const trip of allTrips) {
    const day = toDayString(trip.service_date);
    days.set(day, (days.get(day) ?? 0) + 1);
  }

  // Clear old day records
  const oldDays = await ctx.db
    .query("userTripDays")
    .withIndex("by_user", (q) => q.eq("user", user))
    .collect();
  for (const d of oldDays) {
    await ctx.db.delete(d._id);
  }

  // Insert new day records
  for (const [day, count] of days) {
    await ctx.db.insert("userTripDays", { user, day, count });
  }

  // Upsert stats record
  const existing = await ctx.db
    .query("userTripStats")
    .withIndex("by_user", (q) => q.eq("user", user))
    .first();

  const payload = {
    trip_count: allTrips.length,
    day_count: days.size,
    updated_at: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, payload);
  } else {
    await ctx.db.insert("userTripStats", { user, ...payload });
  }
}
