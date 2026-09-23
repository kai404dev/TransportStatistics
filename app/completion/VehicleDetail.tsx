"use client";

import Link from "next/link";
import { ArrowLeft, Bus, CheckCircle2, Clock3, Gauge, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import type { Vehicle } from "./types";

type Trip = {
  _id: string;
  service_number: string;
  service_date: number;
  origin_name: string;
  destination_name: string;
  units?: Array<{ unit_number?: string; unit_reg?: string }>;
  actual_departure?: string;
  actual_arrival?: string;
  scheduled_departure?: string;
  scheduled_arrival?: string;
};

function formatMinutes(value: number) {
  const minutes = Math.round(value);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export function VehicleDetail({ operatorCode, operatorName, fleetNumber, registration }: {
  operatorCode: string;
  operatorName: string;
  fleetNumber: string | null;
  registration: string | null;
}) {
  const { user, isLoaded } = useUser();
  const [fleet, setFleet] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const operator = useQuery(api.functions.completion.getOperatorByAnyCode, { code: operatorCode });
  const trips = useQuery(
    api.functions.vehicles.getUserTripsByOperators,
    isLoaded && user && operator ? { user: user.id, operatorNames: operator.operator_names } : "skip"
  ) as Trip[] | undefined;

  useEffect(() => {
    fetch(`/api/vehicles?code=${encodeURIComponent(operatorCode)}`)
      .then((response) => response.json())
      .then((data) => setFleet(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, [operatorCode]);

  const vehicle = useMemo(() => fleet.find((item) =>
    (fleetNumber && item.unit_number === fleetNumber) || (registration && item.reg === registration)
  ), [fleet, fleetNumber, registration]);

  const vehicleTrips = useMemo(() => (trips ?? []).filter((trip) =>
    (trip.units ?? []).some((unit: { unit_number?: string; unit_reg?: string }) =>
      unit.unit_number === fleetNumber || unit.unit_reg === registration
    )
  ), [trips, fleetNumber, registration]);

  if (loading) return <div className="h-96 rounded-2xl bg-[var(--color-ts-surface)] animate-pulse" />;

  return (
    <div className="space-y-7">
      <div className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-[var(--color-ts-text-3)]">
        <Link href={`/completion?operator=${encodeURIComponent(operatorCode)}&code=${encodeURIComponent(operatorCode)}`} className="hover:text-[var(--color-ts-text-2)]">
          {operatorName || "Completion"}
        </Link>
        <span>/</span>
        <span className="font-bold text-[var(--color-ts-text-2)]">Vehicle</span>
      </div>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-[10px] font-bold tracking-[0.2em] text-[var(--color-ts-accent)]">{operatorName || operator?.display_name || operatorCode}</p>
          <h1 className="text-4xl font-black tracking-tight text-[var(--color-ts-text-1)]">{vehicle?.unit_number || fleetNumber || "Unknown vehicle"}</h1>
          {vehicle?.reg && vehicle.reg !== vehicle.unit_number && <p className="mt-2 font-mono text-sm text-[var(--color-ts-text-3)]">{vehicle.reg}</p>}
        </div>
        <Link href={`/completion?operator=${encodeURIComponent(operatorCode)}&code=${encodeURIComponent(operatorCode)}`} className="inline-flex items-center gap-2 self-start rounded-xl border border-[var(--color-ts-border-soft)] px-3 py-2 text-[10px] font-bold tracking-widest text-[var(--color-ts-text-2)] hover:border-[var(--color-ts-accent-border)]">
          <ArrowLeft size={13} /> Back to fleet
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Times ridden", value: vehicle?.times_ridden ?? 0, icon: Bus },
          { label: "Distance", value: `${Math.round(vehicle?.distance_km ?? 0)} km`, icon: Route },
          { label: "Time ridden", value: formatMinutes(vehicle?.time_minutes ?? 0), icon: Clock3 },
          { label: "Status", value: vehicle?.withdrawn ? "Withdrawn" : vehicle?.ridden ? "Ridden" : "Unridden", icon: vehicle?.ridden ? CheckCircle2 : Gauge },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-2xl border border-[var(--color-ts-border-soft)] bg-[var(--color-ts-surface)] p-4">
            <Icon size={15} className="mb-4 text-[var(--color-ts-accent)]" />
            <p className="text-[9px] font-bold tracking-[0.15em] text-[var(--color-ts-text-3)]">{label}</p>
            <p className="mt-1 text-lg font-black text-[var(--color-ts-text-1)]">{value}</p>
          </div>
        ))}
      </div>

      <section className="rounded-2xl border border-[var(--color-ts-border-soft)] bg-[var(--color-ts-surface)] p-4 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-black text-[var(--color-ts-text-1)]">Recent rides</h2>
          <span className="text-[10px] font-bold tracking-widest text-[var(--color-ts-text-3)]">{vehicleTrips.length} shown</span>
        </div>
        {vehicleTrips.length === 0 ? <p className="py-8 text-sm text-[var(--color-ts-text-3)]">No matching rides yet.</p> : (
          <div className="divide-y divide-white/[0.06]">
            {vehicleTrips.slice(0, 10).map((trip) => (
              <div key={trip._id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div><p className="text-xs font-bold text-[var(--color-ts-text-1)]">{trip.origin_name} → {trip.destination_name}</p><p className="mt-1 text-[10px] text-[var(--color-ts-text-3)]">Service {trip.service_number}</p></div>
                <p className="text-[10px] font-mono text-[var(--color-ts-text-3)]">{trip.actual_departure ?? trip.scheduled_departure ?? "—"} – {trip.actual_arrival ?? trip.scheduled_arrival ?? "—"}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
