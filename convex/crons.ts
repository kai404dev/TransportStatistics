import { cronJobs } from "convex/server";
import { api } from "./_generated/api";

const crons = cronJobs();

const isProd = process.env.ENVIRONMENT === "production";

// How often to poll Signalbox for live train locations. Default 2 minutes:
// frequent enough to stay current, but it cuts the ridIndex existence-check
// volume by 4x compared with the previous 30-second interval.
const syncTrainIntervalMinutes = Math.max(
  1,
  Math.floor(Number(process.env.SYNC_TRAINS_INTERVAL_MINUTES ?? "2")) || 2,
);

if (isProd) {
  crons.interval(
    "sync train details",
    { minutes: syncTrainIntervalMinutes },
    api.functions.trains.syncAllTrains,
    {},
  );

  crons.interval(
    "cleanup old train details (5 days)",
    { minutes: 10 },
    api.functions.trains.cleanupOldtrainDetails,
    {},
  );

  crons.interval(
    "cleanup old train details summary (5 days)",
    { minutes: 10 },
    api.functions.trains.cleanupOldtrainDetailsSummary,
    {},
  );
}

export default crons;