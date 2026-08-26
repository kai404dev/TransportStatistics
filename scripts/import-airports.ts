/**
 * Import https://davidmegginson.github.io/ourairports-data/airports.csv
 * into the Convex `stops` table.
 *
 * Usage:
 *   # 1. Set Convex URL (one of these env vars)
 *   export CONVEX_URL="https://<deployment>.convex.cloud"
 *   # or NEXT_PUBLIC_CONVEX_URL / CONVEX_DEPLOYMENT_URL
 *
 *   # 2. Run (requires `tsx` — already a devDependency):
 *   npx tsx scripts/import-airports.ts                              # full 85k, now defaults to --batch 25 --concurrency 1 --delay 400
 *   npx tsx scripts/import-airports.ts --country GB                    # 1.6k rows, good for testing
 *   npx tsx scripts/import-airports.ts --type large_airport
 *   npx tsx scripts/import-airports.ts --url https://.../airports.csv --batch 25 --concurrency 1 --delay 400
 *   npx tsx scripts/import-airports.ts --dry-run
 *
 * Alternatively, run the Convex-hosted action directly (no local script needed):
 *   npx convex run functions/airports:importOurAirports '{"isoCountry":"GB"}'
 *   npx convex run functions/airports:previewOurAirports '{}'
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

// ── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  return undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const URL_DEFAULT = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const url = getArg("url") ?? URL_DEFAULT;
const isoCountry = getArg("country") ?? getArg("isoCountry");
const typeFilter = getArg("type") ?? getArg("typeFilter");
const batchSize = Math.min(Math.max(Number(getArg("batch") ?? 25), 1), 100);
const concurrency = Math.min(Math.max(Number(getArg("concurrency") ?? 1), 1), 3);
const interBatchDelayMs = Math.max(Number(getArg("delay") ?? (concurrency === 1 ? 400 : 150)), 0);
const dryRun = hasFlag("dry-run") || hasFlag("dryRun");

// Convex URL resolution — accept any of the common env names
const convexUrl =
  process.env.CONVEX_URL ??
  process.env.NEXT_PUBLIC_CONVEX_URL ??
  process.env.CONVEX_DEPLOYMENT_URL ??
  (process.env as any).VITE_CONVEX_URL;

if (!convexUrl && !dryRun) {
  console.error(
    "Missing Convex URL. Set one of: CONVEX_URL, NEXT_PUBLIC_CONVEX_URL, CONVEX_DEPLOYMENT_URL\n" +
      "  export CONVEX_URL=\"https://<your-deployment>.convex.cloud\"\n" +
      "Or pass --dry-run to fetch+parse without writing."
  );
  process.exit(1);
}

// ── CSV parser (quote-aware, handles embedded commas + escaped "") ───────

function parseCsv(text: string): Record<string, string>[] {
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
      if (c === '"') inQuotes = true;
      else if (c === ",") { curRow.push(curField); curField = ""; }
      else if (c === "\n") { curRow.push(curField); rows.push(curRow); curRow = []; curField = ""; }
      else curField += c;
    }
  }
  if (curField.length > 0 || curRow.length > 0) {
    curRow.push(curField);
    rows.push(curRow);
  }
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0] === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = row[c] ?? "";
    out.push(obj);
  }
  return out;
}

// ── Retry wrapper ─────────────────────────────────────────────────────────

const MAX_RETRIES = 8;
const RETRY_BASE_MS = 1500;

function isRetryable(e: any): boolean {
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? e ?? "");
  const lower = msg.toLowerCase();
  // Explicit Convex codes
  if (code === "SystemTimeoutError" || code === "RateLimitError" || code === "InternalServerError") return true;
  // Substrings that indicate transient infra errors
  return (
    lower.includes("timed out") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("500") ||
    lower.includes("bad gateway") ||
    lower.includes("cloudflare") ||
    lower.includes("internalservererror") ||
    lower.includes("internal server error") ||
    lower.includes("couldn't be completed") ||
    lower.includes("try again later") ||
    lower.includes("<!doctype html>") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed") ||
    lower.includes("http actions enabled")
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function importBatchWithRetry(
  client: ConvexHttpClient,
  batch: Record<string, string>[],
  batchStart: number,
  retries = 0
): Promise<{ inserted: number; updated: number; skipped: number }> {
  try {
    return await client.mutation((api as any).functions.airports.importAirportsBatch, {
      rows: batch,
    });
  } catch (e: any) {
    const retryable = isRetryable(e);
    // Convex sometimes throws HTML string as message; log truncated for readability
    const snippet = String(e?.message ?? e).slice(0, 400).replace(/\s+/g, " ");
    if (retryable && retries < MAX_RETRIES) {
      const jitter = Math.floor(Math.random() * 400);
      const delay = RETRY_BASE_MS * Math.pow(2, retries) + jitter;
      console.warn(`⟳ Batch @${batchStart} retry ${retries + 1}/${MAX_RETRIES} in ${delay}ms — ${e?.code ?? "ERR"} :: ${snippet}`);
      await sleep(delay);
      return importBatchWithRetry(client, batch, batchStart, retries + 1);
    }
    // attach snippet for caller logging
    (e as any).__snippet = snippet;
    throw e;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();

  let rows = parseCsv(text);
  console.log(`CSV parsed: ${rows.length} rows, cols: ${Object.keys(rows[0] ?? {}).join(", ")}`);

  if (isoCountry) {
    const want = isoCountry.trim().toUpperCase();
    const before = rows.length;
    rows = rows.filter((r) => (r.iso_country ?? "").trim().toUpperCase() === want);
    console.log(`Filter iso_country=${want}: ${before} → ${rows.length} rows`);
  }
  if (typeFilter) {
    const want = typeFilter.trim().toLowerCase();
    const before = rows.length;
    rows = rows.filter((r) => (r.type ?? "").trim().toLowerCase() === want);
    console.log(`Filter type=${want}: ${before} → ${rows.length} rows`);
  }

  // Summary
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.type ?? "unknown"] = (byType[r.type ?? "unknown"] ?? 0) + 1;
  console.log("By type:", byType);
  console.log("Sample row:", rows[0]);

  if (dryRun) {
    console.log("\n--dry-run: not writing to Convex.");
    return;
  }

  const client = new ConvexHttpClient(convexUrl!);

  // Quick connectivity check (preview call)
  try {
    const preview: any = await client.action((api as any).functions.airports.previewOurAirports, {
      url,
      isoCountry: isoCountry ?? undefined,
      typeFilter: typeFilter ?? undefined,
    });
    console.log("Convex preview OK:", { totalRows: preview.totalRows, filteredRows: preview.filteredRows });
  } catch (e: any) {
    console.warn("Preview check failed (continuing anyway):", e?.message ?? e);
  }

  const batches: Record<string, string>[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));
  console.log(`\nImporting ${rows.length} rows → ${batches.length} batches (size=${batchSize}, concurrency=${concurrency}, interBatchDelay=${interBatchDelayMs}ms)`);

  let completed = 0;
  let failed = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  const executing = new Set<Promise<void>>();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchStart = i * batchSize;

    const task: Promise<void> = importBatchWithRetry(client, batch, batchStart)
      .then((result) => {
        completed++;
        totalInserted += result.inserted;
        totalUpdated += result.updated;
        totalSkipped += result.skipped;
        if (completed % 10 === 0 || completed === batches.length) {
          console.log(
            `[${completed}/${batches.length}] @${batchStart} — +${result.inserted} ~${result.updated} skip=${result.skipped} | total: inserted=${totalInserted} updated=${totalUpdated} skipped=${totalSkipped}`
          );
        }
      })
      .catch((e: any) => {
        failed++;
        const snippet = e?.__snippet ?? String(e?.message ?? e).slice(0, 600);
        console.error(`✗ Batch @${batchStart} permanently failed after ${MAX_RETRIES} retries:`, snippet);
      })
      .finally(() => executing.delete(task));

    executing.add(task);
    if (executing.size >= concurrency) await Promise.race(executing);
    // Throttle between dispatches when running sequentially (concurrency===1) or generally
    if (interBatchDelayMs > 0 && i < batches.length - 1) {
      // only delay dispatch, not batch completion, when pipelining; for concurrency 1 this paces requests
      if (executing.size >= concurrency) {
        // already waited via Promise.race; still small pause to let backend breathe
        await sleep(Math.min(interBatchDelayMs, 150));
      } else {
        await sleep(interBatchDelayMs);
      }
    }
  }

  await Promise.all(executing);
  console.log(`\n✓ Import complete`);
  console.log(`  Batches: ${completed} OK, ${failed} failed`);
  console.log(`  Rows:    inserted=${totalInserted} updated=${totalUpdated} skipped=${totalSkipped} (of ${rows.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
