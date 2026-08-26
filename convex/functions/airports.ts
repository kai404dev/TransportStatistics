import { action, mutation, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

const OUR_AIRPORTS_URL =
  "https://davidmegginson.github.io/ourairports-data/airports.csv";

// ── CSV helpers ──────────────────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  // Normalise line endings + remove BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const rows: string[][] = [];
  let curField = "";
  let curRow: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          curField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        curField += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        curRow.push(curField);
        curField = "";
      } else if (c === "\n") {
        curRow.push(curField);
        rows.push(curRow);
        curRow = [];
        curField = "";
      } else {
        curField += c;
      }
    }
  }
  // flush last field/row (file may not end with newline)
  if (curField.length > 0 || curRow.length > 0) {
    curRow.push(curField);
    rows.push(curRow);
  }

  // drop empty trailing rows (e.g. final newline)
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    // skip empty lines
    if (row.length === 1 && row[0] === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = row[c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

function toStopTypeCode(rawType: string): string {
  const t = rawType.trim().toLowerCase();
  // Map OurAirports types to stopTypes.code — distinct per size so callers
  // can filter (e.g. LARGE_AIRPORT vs SMALL_AIRPORT).  If you prefer a
  // single type for all airports, change this to always return "AIRPORT".
  switch (t) {
    case "large_airport":
      return "LARGE_AIRPORT";
    case "medium_airport":
      return "MEDIUM_AIRPORT";
    case "small_airport":
      return "SMALL_AIRPORT";
    case "heliport":
      return "HELIPORT";
    case "seaplane_base":
      return "SEAPLANE_BASE";
    case "balloonport":
      return "BALLOONPORT";
    case "closed":
      return "CLOSED_AIRPORT";
    default:
      return t.toUpperCase().replace(/[^A-Z0-9]+/g, "_") || "AIRPORT";
  }
}

function toStopTypeName(rawType: string): string {
  if (!rawType) return "Airport";
  return rawType
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Row → stops document ───────────────────────────────────────────────────

function mapRowToStop(row: Record<string, string>) {
  const ident = (row.ident ?? "").trim();
  const id = (row.id ?? "").trim();
  // ident is the canonical FAA/ICAO short code (e.g. "00A").  Fall back to
  // id namespaced so we never produce an empty atcoCode.
  const atcoCode = ident || (id ? `OWR-${id}` : "");
  if (!atcoCode) return null;

  const lat = Number((row.latitude_deg ?? "").trim());
  const lon = Number((row.longitude_deg ?? "").trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = (row.name ?? "").trim() || atcoCode;
  const municipality = (row.municipality ?? "").trim();

  // Prefer "Municipality - Name" for commonName when municipality adds context,
  // but keep raw name when they are identical.
  const commonName =
    municipality && municipality.toLowerCase() !== name.toLowerCase()
      ? `${name} (${municipality})`
      : name;

  const rawType = (row.type ?? "").trim() || "airport";
  const isClosed = rawType.toLowerCase() === "closed";

  const iata = (row.iata_code ?? "").trim();
  const icao = (row.icao_code ?? "").trim();
  const gps = (row.gps_code ?? "").trim();
  const local = (row.local_code ?? "").trim();

  return {
    // core stops fields
    name,
    commonName,
    atcoCode,
    lat,
    lon,
    // stash airport codes in the optional code fields so existing indexes work:
    // crsCode ← IATA (3-letter airline code), tiplocCode ← ICAO, naptanCode ← local/gps
    crsCode: iata || undefined,
    tiplocCode: icao || gps || undefined,
    naptanCode: local || (gps && gps !== icao ? gps : undefined),
    indicator: rawType, // preserve raw OurAirports type
    // useful metadata packed into `lines` so it is queryable without schema changes
    lines: [
      row.iso_country ?? "",
      row.iso_region ?? "",
      row.continent ?? "",
    ].filter(Boolean) as string[],
    active: !isClosed,
    hidden: false,
    // internal helpers (not stored directly — resolved to stopTypeId)
    _rawType: rawType,
    _stopTypeCode: toStopTypeCode(rawType),
    _stopTypeName: toStopTypeName(rawType),
  };
}

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Insert/update a batch of pre-mapped airport rows into `stops`.
 *
 * Accepts raw OurAirports CSV rows (or already-mapped objects) so the
 * caller — either the `importOurAirports` action or the standalone
 * `scripts/import-airports.ts` — does not need to know stopTypeIds.
 *
 * Idempotent / upsert by `atcoCode` (ident).  Stateless retries are safe.
 */
export const importAirportsBatch = mutation({
  args: {
    // raw CSV rows (string-valued) — flexible so callers can pass either the
    // full 19-col row or a pre-filtered object.  Extra keys are ignored.
    rows: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const mapped = args.rows
      .map((r: Record<string, string>) => mapRowToStop(r))
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (mapped.length === 0) {
      return { inserted: 0, updated: 0, skipped: args.rows.length };
    }

    // Resolve/create stopTypes for every distinct type in this batch (deduped)
    const typeCodes = [...new Set(mapped.map((m) => m._stopTypeCode))];
    const codeToId = new Map<string, string>();

    for (const code of typeCodes) {
      const existing = await ctx.db
        .query("stopTypes")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (existing) {
        codeToId.set(code, existing._id);
      } else {
        const name =
          mapped.find((m) => m._stopTypeCode === code)?._stopTypeName ?? code;
        const id = await ctx.db.insert("stopTypes", { name, code });
        codeToId.set(code, id);
      }
    }

    // Look up existing stops by atcoCode (one query per row — matches
    // existing `importBatch` pattern; keep batch ≤ 100 to stay within limits)
    const atcoCodes = mapped.map((m) => m.atcoCode);
    const existingStops = await Promise.all(
      atcoCodes.map((code) =>
        ctx.db
          .query("stops")
          .withIndex("by_atcoCode", (q) => q.eq("atcoCode", code))
          .unique()
      )
    );
    const stopMap = new Map(
      existingStops
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => [s.atcoCode, s])
    );

    let inserted = 0;
    let updated = 0;

    for (const m of mapped) {
      const stopTypeId = codeToId.get(m._stopTypeCode)! as any;
      const doc = {
        name: m.name,
        commonName: m.commonName,
        atcoCode: m.atcoCode,
        crsCode: m.crsCode,
        tiplocCode: m.tiplocCode,
        naptanCode: m.naptanCode,
        indicator: m.indicator,
        lines: m.lines.length > 0 ? m.lines : undefined,
        stopTypeId,
        active: m.active,
        hidden: m.hidden,
        lat: m.lat,
        lon: m.lon,
      };

      const existing = stopMap.get(m.atcoCode);
      if (existing) {
        const isDifferent =
          existing.name !== doc.name ||
          existing.commonName !== doc.commonName ||
          existing.lat !== doc.lat ||
          existing.lon !== doc.lon ||
          String(existing.stopTypeId) !== String(stopTypeId) ||
          existing.crsCode !== doc.crsCode ||
          existing.tiplocCode !== doc.tiplocCode ||
          existing.naptanCode !== doc.naptanCode ||
          existing.indicator !== doc.indicator ||
          existing.active !== doc.active;
        if (isDifferent) {
          await ctx.db.patch(existing._id, doc);
          updated++;
        }
      } else {
        await ctx.db.insert("stops", doc);
        inserted++;
      }
    }

    return {
      inserted,
      updated,
      skipped: args.rows.length - mapped.length,
    };
  },
});

/**
 * Internal helper for the scheduled-continuation path (avoids public API
 * exposure for the chunk worker).  Identical logic to `importAirportsBatch`
 * but registered as internal so the scheduler can call it without auth.
 */
export const importAirportsChunk = internalMutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, args) => {
    const mapped = args.rows
      .map((r: Record<string, string>) => mapRowToStop(r))
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (mapped.length === 0) return { inserted: 0, updated: 0, skipped: args.rows.length };

    const typeCodes = [...new Set(mapped.map((m) => m._stopTypeCode))];
    const codeToId = new Map<string, string>();
    for (const code of typeCodes) {
      const existing = await ctx.db
        .query("stopTypes")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (existing) codeToId.set(code, existing._id);
      else {
        const name = mapped.find((m) => m._stopTypeCode === code)?._stopTypeName ?? code;
        const id = await ctx.db.insert("stopTypes", { name, code });
        codeToId.set(code, id);
      }
    }

    const existingStops = await Promise.all(
      mapped.map((m) =>
        ctx.db.query("stops").withIndex("by_atcoCode", (q) => q.eq("atcoCode", m.atcoCode)).unique()
      )
    );
    const stopMap = new Map(
      existingStops.filter((s): s is NonNullable<typeof s> => s !== null).map((s) => [s.atcoCode, s])
    );

    let inserted = 0;
    let updated = 0;
    for (const m of mapped) {
      const stopTypeId = codeToId.get(m._stopTypeCode)! as any;
      const doc = {
        name: m.name,
        commonName: m.commonName,
        atcoCode: m.atcoCode,
        crsCode: m.crsCode,
        tiplocCode: m.tiplocCode,
        naptanCode: m.naptanCode,
        indicator: m.indicator,
        lines: m.lines.length > 0 ? m.lines : undefined,
        stopTypeId,
        active: m.active,
        hidden: m.hidden,
        lat: m.lat,
        lon: m.lon,
      };
      const existing = stopMap.get(m.atcoCode);
      if (existing) {
        const isDifferent =
          existing.name !== doc.name ||
          existing.commonName !== doc.commonName ||
          existing.lat !== doc.lat ||
          existing.lon !== doc.lon ||
          String(existing.stopTypeId) !== String(stopTypeId) ||
          existing.crsCode !== doc.crsCode ||
          existing.tiplocCode !== doc.tiplocCode ||
          existing.naptanCode !== doc.naptanCode ||
          existing.indicator !== doc.indicator ||
          existing.active !== doc.active;
        if (isDifferent) {
          await ctx.db.patch(existing._id, doc);
          updated++;
        }
      } else {
        await ctx.db.insert("stops", doc);
        inserted++;
      }
    }
    return { inserted, updated, skipped: args.rows.length - mapped.length };
  },
});

// ── Action: fetch CSV and drive batched import ───────────────────────────

function isRetryableActionError(e: any): boolean {
  const msg = String(e?.message ?? e ?? "").toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("bad gateway") ||
    msg.includes("internalservererror") ||
    msg.includes("internal server error") ||
    msg.includes("try again later")
  );
}

function actionSleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch https://davidmegginson.github.io/ourairports-data/airports.csv and
 * import every row into `stops` (batched via `importAirportsChunk`).
 *
 * Options:
 *  - url: override the CSV URL (defaults to OUR_AIRPORTS_URL)
 *  - batchSize: rows per mutation (default 25, max 50 — smaller = less 502s)
 *  - isoCountry: if set, only import rows matching that ISO country code (e.g. "US", "GB")
 *  - typeFilter: if set, only import rows whose `type` equals this value (e.g. "large_airport")
 *
 * Example (from dashboard or via `npx convex run`):
 *   npx convex run functions/airports:importOurAirports '{"isoCountry":"GB"}'
 *
 * For the full 85k-row file prefer the throttled client script
 * `scripts/import-airports.ts` (default concurrency=1) which paces requests
 * and retries 502s; this action is best for filtered imports.
 */
export const importOurAirports = action({
  args: {
    url: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    isoCountry: v.optional(v.string()),
    typeFilter: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const url = args.url ?? OUR_AIRPORTS_URL;
    const batchSize = Math.min(Math.max(args.batchSize ?? 25, 1), 50);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    const text = await res.text();

    let rows = parseCsv(text);

    // Optional server-side filters
    if (args.isoCountry) {
      const want = args.isoCountry.trim().toUpperCase();
      rows = rows.filter((r) => (r.iso_country ?? "").trim().toUpperCase() === want);
    }
    if (args.typeFilter) {
      const want = args.typeFilter.trim().toLowerCase();
      rows = rows.filter((r) => (r.type ?? "").trim().toLowerCase() === want);
    }

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    const failures: Array<{ batchStart: number; error: string }> = [];

    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      let retries = 0;
      const maxRetries = 6;
      while (true) {
        try {
          const result: { inserted: number; updated: number; skipped: number } =
            await ctx.runMutation(internal.functions.airports.importAirportsChunk, { rows: chunk });
          totalInserted += result.inserted;
          totalUpdated += result.updated;
          totalSkipped += result.skipped;
          break; // success
        } catch (e: any) {
          if (isRetryableActionError(e) && retries < maxRetries) {
            const delay = 1200 * Math.pow(2, retries) + Math.floor(Math.random() * 300);
            retries++;
            await actionSleep(delay);
            continue;
          }
          failures.push({ batchStart: i, error: String(e?.message ?? e).slice(0, 500) });
          break; // give up on this batch, continue to next
        }
      }
      // Pace mutations: 300ms between batches lets Convex breathe (was hammered at 100/3)
      if (i + batchSize < rows.length) await actionSleep(300);
    }

    return {
      totalRows: rows.length,
      totalInserted,
      totalUpdated,
      totalSkipped,
      batches: Math.ceil(rows.length / batchSize),
      failures,
      failedBatches: failures.length,
    };
  },
});

/**
 * Lightweight helper: fetch the CSV and return counts without writing.
 * Useful for dry-runs / verifying the URL is reachable.
 */
export const previewOurAirports = action({
  args: {
    url: v.optional(v.string()),
    isoCountry: v.optional(v.string()),
    typeFilter: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const url = args.url ?? OUR_AIRPORTS_URL;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    const text = await res.text();
    let rows = parseCsv(text);
    const total = rows.length;
    if (args.isoCountry) {
      const want = args.isoCountry.trim().toUpperCase();
      rows = rows.filter((r) => (r.iso_country ?? "").trim().toUpperCase() === want);
    }
    if (args.typeFilter) {
      const want = args.typeFilter.trim().toLowerCase();
      rows = rows.filter((r) => (r.type ?? "").trim().toLowerCase() === want);
    }
    const byType: Record<string, number> = {};
    for (const r of rows) byType[r.type ?? "unknown"] = (byType[r.type ?? "unknown"] ?? 0) + 1;
    const sample = rows.slice(0, 3).map(mapRowToStop).filter(Boolean);
    return { url, totalRows: total, filteredRows: rows.length, byType, sample };
  },
});
