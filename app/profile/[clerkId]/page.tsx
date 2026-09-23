"use client";

import { useQuery, useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import Link from "next/link";
import { use, useMemo } from "react";
import { TripRow } from "@/components/TripRow";
import { FriendRequestButton } from "@/components/FriendRequestButton";
import { useDayByDayTrips } from "@/components/useDayByDayTrips";
import { useRequireAuth } from "@/components/AuthGate";
import { ArrowLeft, Lock } from "lucide-react";

export default function UserProfilePage({
  params,
}: {
  params: Promise<{ clerkId: string }>;
}) {
  const { clerkId } = use(params);
  const convex = useConvex();
  const currentUser = useQuery(api.functions.friends.getUserByClerkId, { clerkId });
  const access = useQuery(api.functions.friends.canViewProfile, { targetUserId: clerkId });

  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    [],
  );

  const canLoadTrips = Boolean(currentUser && access?.allowed);

  const fetchers = useMemo(
    () => ({
      fetchLatestDay: async () => {
        if (!canLoadTrips) return null;
        return await convex.query(api.functions.trips.getUserLatestTripDay, {
          userId: clerkId,
          timeZone,
        });
      },
      fetchDayBefore: async (beforeDay: string) => {
        if (!canLoadTrips) return null;
        return await convex.query(api.functions.trips.getUserTripDayBefore, {
          userId: clerkId,
          beforeDay,
          timeZone,
        });
      },
      fetchTripsForDay: async (day: string) => {
        if (!canLoadTrips) return [];
        return await convex.query(api.functions.trips.getUserTripsForDay, {
          userId: clerkId,
          day,
          timeZone,
        });
      },
    }),
    [convex, clerkId, timeZone, canLoadTrips],
  );

  const { days, initialLoading, loadingMore, hasMore, loadMore, sentinelRef } =
    useDayByDayTrips(canLoadTrips ? clerkId : undefined, fetchers);

  const auth = useRequireAuth();
  if (auth) return auth;

  if (!currentUser) {
    return (
      <div className="max-w-4xl mx-auto p-4 md:p-8">
        <div className="text-center py-10 text-slate-400">User not found.</div>
      </div>
    );
  }

  if (!access || !access.allowed) {
    return (
      <div className="max-w-4xl mx-auto p-4 md:p-8">
        <Link
          href="/profile"
          className="inline-flex items-center gap-2 rounded-full border border-ts-border bg-ts-surface px-3 py-2 text-sm text-ts-text-2 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to my profile
        </Link>
        <div className="text-center py-16">
          <Lock className="h-12 w-12 mx-auto mb-4 text-ts-text-3 opacity-40" />
          <h2 className="text-xl font-bold text-ts-text-1 mb-2">Profile Private</h2>
          <p className="text-sm text-ts-text-3">
            {access?.reason === "friends_only"
              ? "This profile is only visible to friends."
              : "This profile is set to private."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 pt-6 pb-8 md:px-8 md:pt-8">
      <Link
        href="/profile"
        className="inline-flex items-center gap-2 rounded-full border border-ts-border bg-ts-surface px-3 py-2 text-sm text-ts-text-2 transition hover:border-ts-accent/50 hover:bg-ts-accent/10 hover:text-ts-accent mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to my profile
      </Link>

      <div className="mb-6 md:mb-8">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ts-accent/10 text-xl font-bold text-ts-accent">
              {currentUser.username.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-ts-text-1">{currentUser.username}</h1>
            </div>
          </div>
          <FriendRequestButton targetUserId={clerkId} />
        </div>


      </div>

      <div className="border-b border-white/10 mb-6 md:mb-8" />

      {initialLoading ? (
        <div className="text-center text-slate-500 py-10">Loading...</div>
      ) : days.length === 0 ? (
        <div className="text-center py-10 text-slate-400">No trips yet.</div>
      ) : (
        <>
          {days.map(({ day, label, trips: tripList }) => (
            <div key={day} className="mb-8">

              <div className="sticky top-0 z-10 bg-ts-bg pt-1 pb-2">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <h3 className="text-base md:text-lg font-bold text-ts-text-1 truncate">{label}</h3>
                    <span className="shrink-0 text-xs text-slate-500 tabular-nums">
                      {tripList.length} {tripList.length === 1 ? "trip" : "trips"}
                    </span>
                  </div>
                </div>
                <div className="mt-2 border-b border-white/5" />
              </div>

              <div className="flex flex-col gap-2 mt-2">
                {tripList.map((trip) => (
                  <TripRow key={trip._id} trip={trip} />
                ))}
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
