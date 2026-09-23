"use client";

import Link from "next/link";
import { useConvex } from "convex/react";
import { api } from "../../convex/_generated/api";
import { TripRow } from "@/components/TripRow";
import { CompactTripRow } from "@/components/CompactTripRow";
import { useDayByDayTrips } from "@/components/useDayByDayTrips";
import { useUser } from "@clerk/nextjs";
import { useMemo, useState } from "react";
import { MapPinned, Info, LayoutList, Rows3 } from "lucide-react";
import { useRequireAuth } from "@/components/AuthGate";

const LAYOUT_STORAGE_KEY = "ts_trip_layout";
type TripLayout = "comfortable" | "compact";

export default function ProfilePage() {
  const { user } = useUser();
  const convex = useConvex();
  const userId = user?.id;

  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    [],
  );

  const fetchers = useMemo(
    () => ({
      fetchLatestDay: async () => {
        if (!userId) return null;
        return await convex.query(api.functions.trips.getMyLatestTripDay, {
          user: userId,
          timeZone,
        });
      },
      fetchDayBefore: async (beforeDay: string) => {
        if (!userId) return null;
        return await convex.query(api.functions.trips.getMyTripDayBefore, {
          user: userId,
          beforeDay,
          timeZone,
        });
      },
      fetchTripsForDay: async (day: string) => {
        if (!userId) return [];
        return await convex.query(api.functions.trips.getMyTripsForDay, {
          user: userId,
          day,
          timeZone,
        });
      },
    }),
    [convex, userId, timeZone],
  );

  const { days, initialLoading, loadingMore, hasMore, loadMore, sentinelRef } =
    useDayByDayTrips(userId, fetchers);

  // ── Layout preference (comfortable / compact), persisted locally ──
  const [layout, setLayout] = useState<TripLayout>(() => {
    if (typeof window === "undefined") return "comfortable";
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    return stored === "compact" || stored === "comfortable" ? stored : "comfortable";
  });

  const toggleLayout = () => {
    setLayout((prev) => {
      const next = prev === "comfortable" ? "compact" : "comfortable";
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, next);
      return next;
    });
  };

  const auth = useRequireAuth();
  if (auth) return auth;

  return (
    <div className="max-w-4xl mx-auto px-4 pt-6 pb-8 md:px-8 md:pt-8">

      {/* ── Header ── */}
      <div className="mb-6 md:mb-8">
        {/* Title row */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl md:text-3xl font-bold text-ts-text-1">My Trips</h1>
        </div>

        {/* Map button + Layout toggle */}
        <div className="flex flex-wrap items-center gap-3">
          {days.length > 0 && (
            <Link
              href="/trip/all/map"
              className="flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-ts-text-1 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent"
            >
              <MapPinned className="h-4 w-4 shrink-0" />
              View all on map
            </Link>
          )}

          {/* Layout toggle */}
          <button
            type="button"
            onClick={toggleLayout}
            className="flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-ts-text-1 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent ml-auto"
            title={layout === "comfortable" ? "Switch to compact view" : "Switch to comfortable view"}
          >
            {layout === "comfortable" ? (
              <>
                <Rows3 className="h-4 w-4 shrink-0" />
                Compact view
              </>
            ) : (
              <>
                <LayoutList className="h-4 w-4 shrink-0" />
                Comfortable view
              </>
            )}
          </button>
        </div>
      </div>

      {/* Divider */}
      <div className="border-b border-white/10 mb-6 md:mb-8" />

      {/* ── Trip list, one day at a time ── */}
      {initialLoading ? (
        <div className="text-center text-slate-500 py-10">Loading...</div>
      ) : days.length === 0 ? (
        <div className="text-center py-10 text-slate-400">No trips yet.</div>
      ) : (
        <>
          {days.map(({ day, label, trips: tripList }) => (
            <div key={day} className="mb-8">

              {/* Sticky date group header */}
              <div className="sticky top-0 z-10 bg-ts-bg pt-1 pb-2">
                <div className="flex items-center gap-3">
                  {/* Date — clickable via Link */}
                  <Link href={`/trip/${day}`} className="flex items-center gap-3 min-w-0 flex-1">
                    <h3 className="text-base md:text-lg font-bold text-ts-text-1 truncate">{label}</h3>
                    <span className="shrink-0 text-xs text-slate-500 tabular-nums">
                      {tripList.length} {tripList.length === 1 ? "trip" : "trips"}
                    </span>
                  </Link>

                  {/* Day map link — pushed to the right */}
                  <div className="inline-flex gap-2 ml-auto">
                    <Link
                      href={`/trip/${day}`}
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium tracking-[0.12em] text-ts-text-2 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent"
                    >
                      <Info className="h-3 w-3" />
                      Details
                    </Link>
                    <Link
                      href={`/trip/${day}/map`}
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium tracking-[0.12em] text-ts-text-2 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent"
                    >
                      <MapPinned className="h-3 w-3" />
                      Map
                    </Link>
                  </div>
                </div>
                <div className="mt-2 border-b border-white/5" />
              </div>

              {/* Trip cards */}
              <div className="flex flex-col gap-2 mt-2">
                {tripList.map((trip) =>
                  layout === "compact" ? (
                    <CompactTripRow key={trip._id} trip={trip} />
                  ) : (
                    <TripRow key={trip._id} trip={trip} />
                  )
                )}
              </div>
            </div>
          ))}

          {/* Auto-load sentinel (loads one more day when scrolled into view) */}
          {hasMore && <div ref={sentinelRef} aria-hidden="true" className="h-1" />}

          <div className="py-4 text-center text-sm text-slate-500">
            {loadingMore && "Loading more trips..."}
            {!hasMore && "All trips loaded"}
            {hasMore && !loadingMore && (
              <button
                type="button"
                onClick={() => void loadMore()}
                className="rounded-full border border-white/10 bg-white/5 px-6 py-2 text-sm font-medium text-ts-text-1 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent"
              >
                Load more
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
