"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DayTripRecord = {
  _id: string;
  user?: string;
  on_trip_with?: string[];
  logged_at?: number;
  service_date: number;
  transport_type: string;
  service_number?: string;
  operator?: string;
  operator_slug?: string;
  scheduled_departure?: string;
  actual_departure?: string;
  scheduled_arrival?: string;
  actual_arrival?: string;
  origin_name?: string;
  origin_stop_code?: string;
  destination_name?: string;
  destination_stop_code?: string;
  units?: { unit_number?: string; unit_reg?: string; unit_type?: string; livery?: string; livery_left?: string }[];
  unit_number?: string;
  unit_reg?: string;
  unit_type?: string;
  livery_name?: string;
  livery_css?: string;
  notes?: string;
  first_time?: boolean;
  first_units?: string[];
  vehicle_key?: string;
  vehicle_keys?: string[];
  distance_km?: number;
};

export type LoadedDay = {
  day: string;
  label: string;
  trips: DayTripRecord[];
};

export function formatDayLabel(day: string) {
  return new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

type DayFeedFetchers = {
  fetchLatestDay: () => Promise<string | null>;
  fetchDayBefore: (beforeDay: string) => Promise<string | null>;
  fetchTripsForDay: (day: string) => Promise<DayTripRecord[]>;
};

/**
 * Loads a trip feed exactly one day at a time. Each step appends a single
 * older day; nothing ever reads the whole trip log, so large logs can't blow
 * up the page. Exposes both a manual `loadMore` (for a button) and a
 * `sentinelRef` that auto-loads when scrolled into view.
 */
export function useDayByDayTrips(resetKey: string | null | undefined, fetchers: DayFeedFetchers) {
  const [days, setDays] = useState<LoadedDay[]>([]);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(false);
  const oldestDayRef = useRef<string | null>(null);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  useEffect(() => {
    oldestDayRef.current = days.length > 0 ? days[days.length - 1].day : null;
  }, [days]);

  // Track which key the loaded days belong to. When the key changes (user
  // switch, access granted), reset state during render (React's derived-state
  // pattern) so stale days never flash, then the effect below loads day one.
  const [loadedKey, setLoadedKey] = useState(resetKey);
  if (loadedKey !== resetKey) {
    setLoadedKey(resetKey);
    setDays([]);
    setHasMore(false);
    setLoadingMore(false);
    setInitialLoading(Boolean(resetKey));
  }

  // Initial load: latest day + its trips. Exactly one day.
  useEffect(() => {
    loadingMoreRef.current = false;
    oldestDayRef.current = null;
    hasMoreRef.current = false;
    if (!loadedKey) return;
    let cancelled = false;
    (async () => {
      try {
        const latest = await fetchers.fetchLatestDay();
        if (cancelled) return;
        if (!latest) {
          setDays([]);
          setHasMore(false);
          return;
        }
        const trips = await fetchers.fetchTripsForDay(latest);
        if (cancelled) return;
        setDays([{ day: latest, label: formatDayLabel(latest), trips }]);
        // Assume older days may exist until a lookup proves otherwise.
        setHasMore(true);
      } catch {
        if (!cancelled) {
          setDays([]);
          setHasMore(false);
        }
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadedKey, fetchers]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const oldest = oldestDayRef.current;
      if (!oldest) {
        setHasMore(false);
        return;
      }
      const prev = await fetchers.fetchDayBefore(oldest);
      if (!prev) {
        setHasMore(false);
        return;
      }
      const trips = await fetchers.fetchTripsForDay(prev);
      setDays((prevDays) => {
        if (prevDays.some((d) => d.day === prev)) return prevDays;
        return [...prevDays, { day: prev, label: formatDayLabel(prev), trips }];
      });
    } catch {
      // Keep hasMore true so the user can retry via the button.
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [fetchers]);

  // Auto-load on scroll: when the sentinel scrolls into view, pull one more day.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          void loadMore();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadMore, days.length, initialLoading]);

  return { days, initialLoading, loadingMore, hasMore, loadMore, sentinelRef };
}
