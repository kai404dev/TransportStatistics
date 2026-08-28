import { NextResponse } from 'next/server';
import { Redis } from 'ioredis';
import { withApiKeyAuth } from '@/lib/api-key-auth';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { buildBustimesUrl, getBustimesBaseUrl } from '@/lib/bustimes-source';
const consoleDebug = false; // Set to true to enable debug logging
// Allow disabling Redis via env
const REDIS_DISABLED =
  process.env.DISABLE_REDIS === 'true' || process.env.REDIS_DISABLED === 'true';

let redisClient: Redis | any;
let limiter: any;

if (!REDIS_DISABLED) {
  // 1. Initialize Redis with better error handling
  redisClient = new Redis(process.env.REDIS_URL!, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
    // Add a generic error handler so it doesn't crash the server
    lazyConnect: true,
  });

  redisClient.on('error', (err: unknown) => console.error('Redis Client Error', err));

  // 2. Setup the rate limiter
  limiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'api_limit',
    points: 2, // 2 requests
    duration: 1, // per 1 second
  });
} else {
  redisClient = { get: async (_: string) => null, set: async (_: string, __: string) => null, on: () => null } as unknown as Redis;
  limiter = new RateLimiterMemory({ points: 2, duration: 1 });
}

function log(message: string) {
  if (consoleDebug && consoleDebug === true) {
    console.log(`[API] ${message}`);
  }
}

// --- Types ---
interface Departure {
id: string | null;
  service: string | null;
  service_link: string;
  origin: string | null;
  destination: string | null;
  operator: string | null;
  operator_code: string | null;
  scheduled_departure: string | null;
  expected_departure: string | null;
  platform: string | null;
  displayAs: string | null;
  status: string | null;
  is_cancelled: boolean | null;
  cancellation_reason: string | null;
  delay: string | number | null;
  mode: 'bus' | 'train' | 'flight';
  rar: boolean | null;
  vehicle_info?: {
    type: string | null;
    registration?: string | null;
    aircraft_type?: string | null;
    carrages?: number | null;
  };
  terminal?: string | null;
  gate?: string | null;
  log_link: string;
  debug?: any;
}

function analyzeDepartures(departures: Departure[]) {
  return {
    contains_cancelled_services: departures.some(d => !!d.is_cancelled),
    contains_expected_times: departures.some(d => !!d.expected_departure),
    contains_platform_numbers: departures.some(d => !!d.platform && d.platform.trim() !== ""),
    contains_delays: departures.some(d => d.delay !== null && d.delay !== 0 && d.delay !== "0"),
  };
}

// --- Flight helpers ---
// Simple IATA -> IANA timezone mapping. Falls back to UTC.
// Enough for major airports; avoids server-timezone assumption.
const AIRPORT_TIMEZONES: Record<string, string> = {
  // UK
  LHR: 'Europe/London', LGW: 'Europe/London', STN: 'Europe/London', LTN: 'Europe/London', LCY: 'Europe/London',
  MAN: 'Europe/London', BHX: 'Europe/London', EDI: 'Europe/London', GLA: 'Europe/London', BRS: 'Europe/London',
  NCL: 'Europe/London', LBA: 'Europe/London', LPL: 'Europe/London', SEN: 'Europe/London', EMA: 'Europe/London',
  ABZ: 'Europe/London', SOU: 'Europe/London', BFS: 'Europe/London', BHD: 'Europe/London', CWL: 'Europe/London',
  // Europe
  CDG: 'Europe/Paris', ORY: 'Europe/Paris', AMS: 'Europe/Amsterdam', FRA: 'Europe/Berlin', MUC: 'Europe/Berlin',
  BER: 'Europe/Berlin', DUS: 'Europe/Berlin', MXP: 'Europe/Rome', FCO: 'Europe/Rome', MAD: 'Europe/Madrid',
  BCN: 'Europe/Madrid', ZRH: 'Europe/Zurich', VIE: 'Europe/Vienna', BRU: 'Europe/Brussels', DUB: 'Europe/Dublin',
  LIS: 'Europe/Lisbon', OPO: 'Europe/Lisbon', PRG: 'Europe/Prague', WAW: 'Europe/Warsaw', CPH: 'Europe/Copenhagen',
  OSL: 'Europe/Oslo', ARN: 'Europe/Stockholm', HEL: 'Europe/Helsinki', ATH: 'Europe/Athens', IST: 'Europe/Istanbul',
  // North America
  JFK: 'America/New_York', LGA: 'America/New_York', EWR: 'America/New_York', BOS: 'America/New_York', MIA: 'America/New_York',
  ATL: 'America/New_York', ORD: 'America/Chicago', DFW: 'America/Chicago', IAH: 'America/Chicago', DEN: 'America/Denver',
  PHX: 'America/Phoenix', LAX: 'America/Los_Angeles', SFO: 'America/Los_Angeles', SEA: 'America/Los_Angeles', LAS: 'America/Los_Angeles',
  // Middle East / Asia / Oceania examples
  DXB: 'Asia/Dubai', DOH: 'Asia/Qatar', SIN: 'Asia/Singapore', HKG: 'Asia/Hong_Kong', ICN: 'Asia/Seoul', NRT: 'Asia/Tokyo', HND: 'Asia/Tokyo',
  SYD: 'Australia/Sydney', MEL: 'Australia/Melbourne',
};

// ICAO -> IATA fallback for timezone lookup (common UK/EU/US)
const ICAO_TO_IATA: Record<string, string> = {
  EGLL: 'LHR', EGKK: 'LGW', EGSS: 'STN', EGGW: 'LTN', EGLC: 'LCY', EGCC: 'MAN', EGBB: 'BHX', EGPH: 'EDI', EGPF: 'GLA',
  KJFK: 'JFK', KLGA: 'LGA', KEWR: 'EWR', KLAX: 'LAX', KSFO: 'SFO', KORD: 'ORD', KDFW: 'DFW',
};

function getAirportTimezone(code: string): string {
  const upper = code.toUpperCase();
  if (AIRPORT_TIMEZONES[upper]) return AIRPORT_TIMEZONES[upper];
  if (ICAO_TO_IATA[upper] && AIRPORT_TIMEZONES[ICAO_TO_IATA[upper]]) return AIRPORT_TIMEZONES[ICAO_TO_IATA[upper]];
  return 'UTC';
}

function convertYYYYMMDDToDDMMYYYY(dateStr: string): string {
  // dateStr: YYYY-MM-DD -> DD-MM-YYYY
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

function isValidYYYYMMDD(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
}
function isValidHHMM(s: string): boolean {
  return /^\d{2}:\d{2}$/.test(s);
}

function parseTimeToMinutes(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10); const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

function datetimeToAirportLocal(datetimeStr: string, timezone: string): { dateDDMMYYYY: string; dateYYYYMMDD: string; timeHHMM: string } {
  const d = new Date(datetimeStr);
  if (isNaN(d.getTime())) throw new Error('Invalid datetime format');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const day = map.day; const month = map.month; const year = map.year;
  let hour = map.hour; const minute = map.minute;
  if (hour === '24') hour = '00';
  return {
    dateDDMMYYYY: `${day}-${month}-${year}`,
    dateYYYYMMDD: `${year}-${month}-${day}`,
    timeHHMM: `${hour}:${minute}`,
  };
}

function getTodayAirportLocal(timezone: string): { dateDDMMYYYY: string; dateYYYYMMDD: string } {
  return datetimeToAirportLocal(new Date().toISOString(), timezone);
}

function isDateOutsideSkylinkRange(requestedYYYYMMDD: string, timezone: string): boolean {
  // SkyLink v3: 5 days back to 1 day forward relative to current date in airport local time.
  try {
    const today = getTodayAirportLocal(timezone);
    const todayDate = new Date(`${today.dateYYYYMMDD}T00:00:00Z`);
    const reqDate = new Date(`${requestedYYYYMMDD}T00:00:00Z`);
    const diffMs = reqDate.getTime() - todayDate.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
    return diffDays < -5 || diffDays > 1;
  } catch { return false; }
}

// Placeholder for short-lived caching (in-memory, 30-60s). Structure allows easy extension.
// Do not cache indefinitely because flight status can change.
const flightCache = new Map<string, { expiry: number; data: any }>();
function getFlightCacheKey(iataOrIcao: string, date?: string, time?: string): string {
  return `${iataOrIcao}|${date || ''}|${time || ''}`;
}

// --- Flight links ---
function splitFlightNumber(flightNumber: string | null | undefined): { airline: string; number: string } {
  const num = (flightNumber || '').trim().toUpperCase();
  const m = num.match(/^([A-Z]+)(.+)$/);
  if (m) return { airline: m[1], number: m[2].trim() };
  return { airline: num, number: num };
}

function datePartsFromScheduled(scheduledDeparture: string | null | undefined): { year: string; month: string; day: string } {
  if (scheduledDeparture && /^\d{4}-\d{2}-\d{2}/.test(scheduledDeparture)) {
    return {
      year: scheduledDeparture.slice(0, 4),
      month: scheduledDeparture.slice(5, 7),
      day: scheduledDeparture.slice(8, 10),
    };
  }
  const now = new Date();
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, '0'),
    day: String(now.getDate()).padStart(2, '0'),
  };
}

function buildFlightStatsUrl(flightNumber: string | null | undefined, scheduledDeparture: string | null | undefined): string {
  const { airline, number } = splitFlightNumber(flightNumber);
  const { year, month, day } = datePartsFromScheduled(scheduledDeparture);
  return `https://www.flightstats.com/v2/flight-tracker/${airline}/${encodeURIComponent(number)}?year=${year}&month=${month}&date=${day}`;
}

function buildFlightLogUrl(
  flightNumber: string | null | undefined,
  scheduledDeparture: string | null | undefined,
): string {
  const { airline, number } = splitFlightNumber(flightNumber);
  let dateYYYYMMDD = '';
  if (scheduledDeparture && /^\d{4}-\d{2}-\d{2}/.test(scheduledDeparture)) {
    dateYYYYMMDD = scheduledDeparture.slice(0, 10);
  }
  const params = new URLSearchParams({
    flight_number: `${airline} ${number}`,
  });
  if (dateYYYYMMDD) params.set('date', dateYYYYMMDD);
  return `/log?${params.toString()}`;
}

// SkyLink sometimes returns destinations like "BHX • Birmingham". For the user
// we show only the leading code; internal 4-letter codes come from flight_status.
function stripAirportDisplaySuffix(value: string | null | undefined): string | null {
  if (!value) return null;
  const idx = value.indexOf('•');
  const stripped = (idx >= 0 ? value.slice(0, idx) : value).trim();
  return stripped || null;
}

// --- Auth Cache ---
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

async function getValidAccessToken(): Promise<string> {
  log(`Checking token validity. Cached exists: ${!!cachedToken}`);
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    log('Returning cached token.');
    return cachedToken;
  }

  const refreshToken = process.env.RTT_REFRESH_TOKEN;
  if (!refreshToken) {
    log('ERROR: RTT_REFRESH_TOKEN not configured in environment.');
    throw new Error('RTT_REFRESH_TOKEN not configured');
  }

  log('Fetching new access token...');
  const url = 'https://data.rtt.io/api/get_access_token';
  
  const response = await fetch(url, {
    method: 'GET', 
    headers: { 
      'Authorization': `Bearer ${refreshToken}`,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log(`Auth request failed with status: ${response.status}`);
    log(`Response body: ${errorBody}`);
    throw new Error(`Failed to refresh RTT access token: ${response.statusText}`);
  }

  const data = await response.json();
  log('Auth successful. Token received.');
  
  cachedToken = data.token; 
  tokenExpiry = new Date(data.validUntil).getTime(); 

  return cachedToken!;
}

// --- API Handler ---
export const GET = withApiKeyAuth(async (_auth, request: Request) => {
  const bustimesBaseUrl = await getBustimesBaseUrl("departures", _auth?.userId);
  // Identify user by IP
  const ip = request.headers.get("x-forwarded-for") ?? "127.0.0.1";

  try {
    // 3. Consume points. This will throw an error if rate limited
    await limiter.consume(ip);
  } catch (rejRes: any) {
    // This runs if the user is rate limited
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429 }
    );
  }
  
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get("debug") === "false";
  const type = searchParams.get('type');
  const code = searchParams.get('code');
  const date = searchParams.get('date');
  const time = searchParams.get('time');
  const pass = searchParams.get('pass') === 'show';
  const datetime = searchParams.get('datetime');
  const limit = searchParams.get('limit') || '15';

  log(`Incoming request: type=${type}, code=${code}`);

  if (!type || !code) {
    log('Missing parameters in request.');
    return NextResponse.json({ error: 'Missing type or code parameter' }, { status: 400 });
  }

  try {
    // --- Train Logic ---
    if (type === 'train') {
      log('Processing train request.');
      const token = await getValidAccessToken();
      let dateTimeQuery = '';
      if (date && time) {
        dateTimeQuery = date && time ? `&timeFrom=${encodeURIComponent(`${date}T${time}:00`)}` : '';
      } else if (datetime) {
        dateTimeQuery = `&timeFrom=${encodeURIComponent(datetime)}`;
      }
      // Fetch with detailed=true to ensure we get the full metadata
      // const fetchUrl = `https://data.rtt.io/rtt/location?code=gb-nr%3A${encodeURIComponent(code)}&detailed=true`;
      const fetchUrl = `https://data.rtt.io/gb-nr/location?code=${encodeURIComponent(code)}&detailed=true${dateTimeQuery}&allowFullAllocationListing=true&timeTolerance=true`;
      log(`Calling RTT API: ${fetchUrl}`);

      const response = await fetch(fetchUrl, {
        headers: { 
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})); // Parse JSON safely
        
        const emptyTrainResponse = {
          metadata: { contains_cancelled_services: false, contains_expected_times: false, contains_platform_numbers: false, contains_delays: false },
          attributions: ['Train departure data is sourced from <a style="color: var(--color-ts-accent);" href="https://www.realtimetrains.co.uk" target="_blank" rel="noopener noreferrer">realtimetrains.co.uk</a>'],
          departures: [],
          debugRes: null,
        };

        if (errorData.errcode === 400 && errorData.error?.includes("outside your permitted history")) {
          log('RTT API error: Requesting date outside permitted history. Returning empty departures.');
        } else {
          log(`RTT Data fetch failed: ${response.status} ${response.statusText}. Returning empty departures.`);
        }
        return NextResponse.json(emptyTrainResponse);
      }
      
      const data = await response.json();
      log(`RTT Data received. Found ${data.services?.length || 0} services.`);

      // Enhanced Normalization
      const departures: Departure[] = (data.services || [])
        .map((item: any) => {
          const date = item.scheduleMetadata?.departureDate;
          const uid = item.scheduleMetadata?.identity;

          return {
            id: uid || null,
            service: item.scheduleMetadata?.trainReportingIdentity || null,
            service_link: uid && date ? `https://www.realtimetrains.co.uk/service/gb-nr:${uid}/${date}/detailed` : `#`,
            origin: item.origin?.[0]?.location?.description || null,
            destination: item.destination?.[0]?.location?.description || null,
            operator: item.scheduleMetadata?.operator?.name || null,
            operator_code: item.scheduleMetadata?.operator?.code || null,
            scheduled_departure: item.temporalData?.departure?.scheduleInternal || item.temporalData?.arrival?.scheduleInternal  || item.temporalData?.pass?.scheduleInternal || null,
            expected_departure: item.temporalData?.departure?.realtimeForecast || item.temporalData?.arrival?.realtimeForecast  || item.temporalData?.pass?.realtimeForecast || null,
            platform: item.locationMetadata?.platform?.actual || item.locationMetadata?.platform?.planned || null,
            displayAs: item.temporalData?.displayAs || null,
            status: item.temporalData?.status || null,
            is_cancelled: item.temporalData?.departure?.isCancelled ?? null,
            cancellation_reason: item.reasons?.[0]?.longText || null,
            delay: item.temporalData?.departure?.realtimeInternalLateness ?? null,
            mode: 'train',
            rar: item.scheduleMetadata?.runsAsRequired ?? null,
            vehicle_info: { 
              type: item.locationMetadata?.stockBranding || null,
              carrages: item.locationMetadata?.numberOfVehicles || null,
            },
            log_link: `/log?service_uid=${item.scheduleMetadata?.uniqueIdentity}`,
            debug: debug ? item : undefined,
          };
        })
        .filter((d: Departure) => {
          const displayAs = d.displayAs ? d.displayAs : '';

          if (displayAs && !pass) {
            return displayAs !== 'PASS';
          }
          return true;
        })
        .slice(0, limit);

      const attributions = ['Train departure data is sourced from <a style="color: var(--color-ts-accent);" href="https://www.realtimetrains.co.uk" target="_blank" rel="noopener noreferrer">realtimetrains.co.uk</a>'];

      const metadata = analyzeDepartures(departures);
      const debugRes = data;

      return NextResponse.json({ metadata, attributions, departures, debugRes });
    } 

    // --- Bus Logic ---
    else if (type === 'bus') {
      let dateTimeQuery = '';
      if (date && time) {
        dateTimeQuery = date && time ? `&when=${encodeURIComponent(`${date}T${time}:00`)}` : '';
      } else if (datetime) {
        dateTimeQuery = `&when=${encodeURIComponent(datetime)}`;
      }
      
      log('Processing bus request with metadata.');

      // Perform both calls concurrently
      const [timesRes, metaRes] = await Promise.all([
        fetch(buildBustimesUrl(bustimesBaseUrl, `/stops/${code}/times.json?${dateTimeQuery}&limit=${limit}`)),
        fetch(buildBustimesUrl(bustimesBaseUrl, `/api/stops/${code}?format=json`))
      ]);
      
      const timesData = await (async () => {
        if (!timesRes.ok) {
          log(`Bus times fetch failed: ${timesRes.status}. Returning empty departures.`);
          return { times: [] };
        }
        return timesRes.json();
      })();

      const attributions = ['Bus departure data is sourced from <a style="color: var(--color-ts-accent);" href="https://bustimes.org" target="_blank" rel="noopener noreferrer">bustimes.org</a>'];
      
      // Handle metadata safely (if meta call fails, return empty metadata rather than crashing)
      let baseMetadata = { line_names: [], common_name: null, name: null, long_name: null };
      if (metaRes.ok) {
        const metaDataRaw = await metaRes.json();
        baseMetadata = {
            line_names: metaDataRaw.line_names || [],
            common_name: metaDataRaw.common_name || null,
            name: metaDataRaw.name || null,
            long_name: metaDataRaw.long_name || null,
        };
      } else {
        log(`Bus metadata fetch failed: ${metaRes.status}`);
      }

      if (!timesData.times || timesData.times.length === 0) {
        const emptyMeta = { ...baseMetadata, ...analyzeDepartures([]) };
        return NextResponse.json({ metadata: emptyMeta, attributions, departures: [] });
      }

      const departures: Departure[] = (timesData.times || [])
        .map((item: any) => ({
          id: item.trip_id || null,
          service: item.service?.line_name || null,
          service_link: item.trip_id ? `https://bustimes.org/trips/${item.trip_id}` : '#',
          origin: null,
          destination: item.destination?.name || null,
          operator: item.service?.operators?.[0]?.name || null,
          operator_code: item.service?.operators?.[0]?.id || null,
          scheduled_departure: item.aimed_departure_time || null,
          expected_departure: item.expected_departure_time || null,
          platform: null,
          status: null,
          is_cancelled: null,
          cancellation_reason: null,
          delay: item.delay || null,
          mode: 'bus',
          log_link: `/log?service_id=${item.trip_id}&date=${item.aimed_departure_time?.split('T')[0]}&stop_code=${code}`,
          debug: debug ? item : undefined,
        }))
        .slice(0, limit);

      const metadata = { ...baseMetadata, ...analyzeDepartures(departures) };
      const debugRes = timesData;

      // Return object with metadata at the top
      return NextResponse.json({ metadata, attributions, departures, debugRes });
    }

    // --- Flight Logic (SkyLink API v3) ---
    else if (type === 'flight') {
      const skylinkApiKey = process.env.SKYLINK_API_KEY;
      if (!skylinkApiKey) {
        log('ERROR: SKYLINK_API_KEY not configured');
        return NextResponse.json({ error: 'Flight data temporarily unavailable - server configuration error' }, { status: 500 });
      }
      // Validate code
      const rawCode = code.trim();
      if (!rawCode || rawCode.length < 3) {
        return NextResponse.json({ error: 'Missing or invalid airport code' }, { status: 400 });
      }
      // Determine iata vs icao (exactly one should be sent)
      let iataParam: string | null = null;
      let icaoParam: string | null = null;
      if (/^[A-Za-z]{4}$/.test(rawCode)) {
        icaoParam = rawCode.toUpperCase();
      } else if (/^[A-Za-z]{3}$/.test(rawCode)) {
        iataParam = rawCode.toUpperCase();
      } else {
        // fallback: assume IATA, strip non-alnum, upper
        iataParam = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
        if (!iataParam) return NextResponse.json({ error: 'Invalid airport code format' }, { status: 400 });
      }

      const airportCodeForDisplay = (iataParam || icaoParam || rawCode).toUpperCase();
      const timezone = getAirportTimezone(airportCodeForDisplay);

      // Parse limit
      const numericLimit = Math.max(1, Math.min(100, parseInt(String(limit), 10) || 15));

      // Handle date/time/datetime conversion to SkyLink format DD-MM-YYYY & HH:MM
      let skylinkDate: string | undefined;
      let skylinkTime: string | undefined;
      let filterWindow: { startMinutes: number; endMinutes: number; dateYYYYMMDD: string } | null = null;
      let requestedDateYYYYMMDD: string | null = null;

      try {
        if (datetime) {
          const local = datetimeToAirportLocal(datetime, timezone);
          skylinkDate = local.dateDDMMYYYY;
          skylinkTime = local.timeHHMM;
          requestedDateYYYYMMDD = local.dateYYYYMMDD;
          const mins = parseTimeToMinutes(local.timeHHMM);
          if (mins !== null) filterWindow = { startMinutes: mins, endMinutes: mins + 60, dateYYYYMMDD: local.dateYYYYMMDD };
        } else if (date && time) {
          if (!isValidYYYYMMDD(date)) return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
          if (!isValidHHMM(time)) return NextResponse.json({ error: 'Invalid time format. Use HH:MM' }, { status: 400 });
          skylinkDate = convertYYYYMMDDToDDMMYYYY(date);
          skylinkTime = time;
          requestedDateYYYYMMDD = date;
          const mins = parseTimeToMinutes(time);
          if (mins !== null) filterWindow = { startMinutes: mins, endMinutes: mins + 60, dateYYYYMMDD: date };
        } else if (date && !time) {
          if (!isValidYYYYMMDD(date)) return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
          skylinkDate = convertYYYYMMDDToDDMMYYYY(date);
          requestedDateYYYYMMDD = date;
          // no time filter
        } else if (!date && time) {
          // time without date: use today's date in airport timezone
          if (!isValidHHMM(time)) return NextResponse.json({ error: 'Invalid time format. Use HH:MM' }, { status: 400 });
          const today = getTodayAirportLocal(timezone);
          skylinkDate = today.dateDDMMYYYY;
          skylinkTime = time;
          requestedDateYYYYMMDD = today.dateYYYYMMDD;
          const mins = parseTimeToMinutes(time);
          if (mins !== null) filterWindow = { startMinutes: mins, endMinutes: mins + 60, dateYYYYMMDD: today.dateYYYYMMDD };
        } else {
          // no date/time: request current schedule (no date/time params)
          requestedDateYYYYMMDD = null;
        }
      } catch (e: any) {
        return NextResponse.json({ error: e.message || 'Invalid datetime' }, { status: 400 });
      }

      // Date range validation per SkyLink v3: 5 days back to 1 day forward
      if (requestedDateYYYYMMDD && isDateOutsideSkylinkRange(requestedDateYYYYMMDD, timezone)) {
        log(`SkyLink date outside supported range: ${requestedDateYYYYMMDD}`);
        return NextResponse.json({ error: `Date ${requestedDateYYYYMMDD} is outside SkyLink's supported range (5 days past to 1 day future)` }, { status: 400 });
      }

      // Build SkyLink URL - structure allows future short-lived caching wrap
      const identifierKey = iataParam ? `iata=${iataParam}` : `icao=${icaoParam}`;
      const cacheKey = getFlightCacheKey(iataParam || icaoParam || '', skylinkDate, skylinkTime);
      // Check cache (30s TTL) - structure for future enhancement
      const cached = flightCache.get(cacheKey);
      let rawData: any = null;
      let fromCache = false;
      if (cached && Date.now() < cached.expiry) {
        rawData = cached.data;
        fromCache = true;
        log(`Flight cache hit for ${cacheKey}`);
      }

      let responseStatus: number | null = null;
      let rawTextForDebug: string | null = null;

      if (!fromCache) {
        const params = new URLSearchParams();
        if (iataParam) params.set('iata', iataParam);
        if (icaoParam) params.set('icao', icaoParam);
        if (skylinkDate) params.set('date', skylinkDate);
        if (skylinkTime && skylinkDate) params.set('time', skylinkTime);
        // Future: could add ts param alternative, but date/time is primary per spec

        const skylinkUrl = `https://data.skylinkapi.com/v3/schedules/departures?${params.toString()}`;
        log(`Calling SkyLink API: ${skylinkUrl} (without time=${skylinkTime})`);

        let skylinkResponse: Response;
        try {
          skylinkResponse = await fetch(skylinkUrl, {
            headers: { 'x-api-key': skylinkApiKey },
          });
        } catch (fetchErr: any) {
          log(`SkyLink fetch error: ${fetchErr.message}`);
          return NextResponse.json({ error: 'Failed to fetch flight data' }, { status: 502 });
        }

        responseStatus = skylinkResponse.status;

        if (!skylinkResponse.ok) {
          const bodyText = await skylinkResponse.text().catch(() => '');
          log(`SkyLink non-2xx: ${skylinkResponse.status} body: ${bodyText.slice(0, 500)}`);
          let errorMsg = 'Flight data unavailable';
          try {
            const j = JSON.parse(bodyText);
            errorMsg = j.error || j.message || errorMsg;
            // Detect range error from SkyLink body to map to 400
            if (typeof errorMsg === 'string' && /range|outside|supported/i.test(errorMsg)) {
              return NextResponse.json({ error: errorMsg }, { status: 400 });
            }
          } catch {}
          // Do not expose secrets or raw key; return useful error
          if (skylinkResponse.status === 401 || skylinkResponse.status === 403) {
            return NextResponse.json({ error: 'Flight provider authentication failed' }, { status: 502 });
          }
          if (skylinkResponse.status === 400) {
            return NextResponse.json({ error: errorMsg }, { status: 400 });
          }
          return NextResponse.json({ error: errorMsg }, { status: 502 });
        }

        // Handle non-JSON safely
        const text = await skylinkResponse.text();
        rawTextForDebug = text;
        try {
          rawData = JSON.parse(text);
        } catch {
          log('SkyLink returned non-JSON');
          return NextResponse.json({ error: 'Flight provider returned invalid data' }, { status: 502 });
        }

        // Store in short-lived cache (30s)
        flightCache.set(cacheKey, { expiry: Date.now() + 30_000, data: rawData });
        // Simple eviction to prevent memory leak
        if (flightCache.size > 200) {
          const firstKey = flightCache.keys().next().value;
          if (firstKey) flightCache.delete(firstKey);
        }
      } else {
        rawTextForDebug = JSON.stringify(rawData);
      }

      // Normalise SkyLink data into Departure[]
      // Support multiple response shapes: title-cased flights[] OR richer flight_number etc.
      const flightsArray: any[] = Array.isArray(rawData?.flights) ? rawData.flights : Array.isArray(rawData?.data) ? rawData.data : Array.isArray(rawData) ? rawData : [];

      // Helper to parse SkyLink status
      const parseStatus = (status: string | null): { isCancelled: boolean; expected: string | null; delay: number | null; statusLabel: string | null } => {
        if (!status) return { isCancelled: false, expected: null, delay: null, statusLabel: null };
        const lower = status.toLowerCase();
        const isCancelled = lower.includes('cancel');
        // Extract estimated time like "Estimated 16:39" or "Expected 16:39"
        const estMatch = status.match(/(\d{1,2}:\d{2})/);
        let expected: string | null = null;
        if (lower.includes('estimated') || lower.includes('expected') || lower.includes('delayed') || lower.includes('scheduled')) {
          if (estMatch) expected = estMatch[1];
        } else if (estMatch && (lower.includes('departed') || lower.includes('boarding') || lower.includes('en route') || lower.includes('landed'))) {
          // For "Landed 16:15" etc, treat as not expected but status
          expected = null;
        }
        // Delay extraction not directly in schedule shape; leave null unless delay_minutes present
        return { isCancelled, expected, delay: null, statusLabel: status };
      };

      const normalized: Departure[] = flightsArray.map((f: any, idx: number) => {
        // Handle both title-cased and lower-case rich shapes
        const flightNumber: string | null = f.Flight || f.flight_number || f.flight || f.flightNumber || f.number || null;
        const airlineName: string | null = f.Airline || f.airline?.name || f.airline || f.carrier || null;
        const airlineCode: string | null = f.AirlineCode || f.airline?.iata || f.airline_iata || f.airlineCode || null;
        const destination: string | null = stripAirportDisplaySuffix(f.IATA || f.iata || f.Destination || f.destination_city || f.destination || f.Origin || f.origin || f.destination_airport || f.dest);
        const schedTimeRaw: string | null = f.Time || f.scheduled_time || f.scheduledTime || f.scheduled_departure || null;
        const statusRaw: string | null = f.Status || f.status || null;
        const terminal: string | null = f.Terminal || f.terminal || null;
        const gate: string | null = f.Gate || f.gate || null;
        const aircraftType: string | null = f.AircraftType || f.aircraft_type || f.aircraft || f.equipment || null;
        const registration: string | null = f.Registration || f.registration || f.tail || null;
        const delayMinutes: number | string | null = f.delay_minutes ?? f.delay ?? f.Delay ?? null;
        const dateLabel: string | null = f.Date || f.date || null;

        // Scheduled departure ISO construction
        let scheduled_departure: string | null = null;
        let scheduledMinutes: number | null = null;
        if (typeof schedTimeRaw === 'string' && schedTimeRaw.includes('T')) {
          // ISO like 2026-03-29T10:30:00Z
          scheduled_departure = schedTimeRaw;
          // Also parse minutes for filtering
          try { const d = new Date(schedTimeRaw); if (!isNaN(d.getTime())) scheduledMinutes = d.getUTCHours()*60 + d.getUTCMinutes(); } catch {}
          // Try airport local conversion for filtering if needed fallback
          if (scheduledMinutes === null) scheduledMinutes = parseTimeToMinutes(schedTimeRaw.slice(11,16));
        } else if (typeof schedTimeRaw === 'string' && /^\d{1,2}:\d{2}$/.test(schedTimeRaw.trim())) {
          const t = schedTimeRaw.trim();
          scheduledMinutes = parseTimeToMinutes(t);
          // Build ISO using requested date or rawData date fallback
          let isoDate = requestedDateYYYYMMDD;
          if (!isoDate) {
            // try to infer from rawData date or today
            if (dateLabel) {
              // dateLabel like "11 Feb" - not reliable, fallback to today
              const today = getTodayAirportLocal(timezone);
              isoDate = today.dateYYYYMMDD;
            } else {
              const today = getTodayAirportLocal(timezone);
              isoDate = today.dateYYYYMMDD;
            }
          }
          scheduled_departure = `${isoDate}T${t.padStart(5,'0')}:00`;
        }

        const statusInfo = parseStatus(statusRaw);
        // If Status contains time like "Estimated 16:39", populate expected_departure similarly
        let expected_departure: string | null = null;
        if (statusInfo.expected && scheduled_departure) {
          // Build expected ISO using same date as scheduled but with expected time
          const baseDate = scheduled_departure.split('T')[0];
          expected_departure = `${baseDate}T${statusInfo.expected}:00`;
        } else if (f.estimated_time) {
          expected_departure = f.estimated_time;
        } else if (f.expected_time) {
          expected_departure = f.expected_time;
        } else if (f.EstimatedTime) {
          expected_departure = f.EstimatedTime;
        }

        const is_cancelled = statusInfo.isCancelled;
        const cancellation_reason = is_cancelled ? (f.cancellation_reason || f.CancellationReason || statusRaw || null) : null;
        // Don't infer cancellation from missing estimate per spec

        // Delay: prefer explicit field
        let delay: string | number | null = null;
        if (delayMinutes !== null && delayMinutes !== undefined && delayMinutes !== '') {
          const n = Number(delayMinutes);
          delay = isNaN(n) ? delayMinutes : n;
        } else if (expected_departure && scheduled_departure) {
          // Compute delay minutes if both times present
          try {
            const s = parseTimeToMinutes(scheduled_departure.slice(11,16));
            const e = parseTimeToMinutes(expected_departure.slice(11,16));
            if (s !== null && e !== null) {
              let diff = e - s;
              if (diff < -12*60) diff += 24*60; // cross midnight
              if (diff !== 0) delay = diff;
            }
          } catch {}
        }

        // Stable id: flight + date + time or index
        const id = flightNumber && scheduled_departure ? `${flightNumber}-${scheduled_departure}` : (flightNumber || `flight-${idx}`);

        return {
          id,
          service: flightNumber,
          service_link: buildFlightStatsUrl(flightNumber, scheduled_departure),
          origin: airportCodeForDisplay,
          destination: destination || f.IATA || f.iata || null,
          operator: airlineName,
          operator_code: airlineCode,
          scheduled_departure,
          expected_departure,
          platform: null,
          displayAs: 'FLIGHT',
          status: statusRaw,
          is_cancelled,
          cancellation_reason: is_cancelled ? cancellation_reason : null,
          delay,
          mode: 'flight' as const,
          rar: null,
          vehicle_info: {
            type: aircraftType,
            registration: registration,
            aircraft_type: aircraftType,
          },
          terminal: terminal,
          gate: gate,
          log_link: buildFlightLogUrl(flightNumber, scheduled_departure),
          debug: debug ? f : undefined,
          // internal helper for filtering, remove later
          _schedMinutes: scheduledMinutes,
          _schedISO: scheduled_departure,
        } as any;
      });

      // Filter by time window if applicable (selected time <= scheduled < selected+1h)
      let filtered = normalized;
      if (filterWindow) {
        filtered = normalized.filter((d: any) => {
          const mins = d._schedMinutes;
          if (mins === null || mins === undefined) return false;
          // For cross-midnight windows, handle wrap
          const start = filterWindow!.startMinutes;
          const end = filterWindow!.endMinutes;
          if (end <= 24*60) {
            return mins >= start && mins < end;
          } else {
            // window wraps midnight (e.g., 23:30 +1h = 00:30 next day)
            return mins >= start || mins < (end - 24*60);
          }
        });
        // Also filter by date if filterWindow has date but flights may be from different date?
        // For title-cased shape Date label may differ; for ISO shape date is in scheduled_departure.
        // We already built scheduled_departure date as requested date, so date filtering is implicit.
      }

      // Apply limit after filtering/normalisation
      const limited = filtered.slice(0, numericLimit);

      // Clean internal fields
      const departures: Departure[] = limited.map((d: any) => {
        const { _schedMinutes, _schedISO, ...rest } = d;
        // Ensure vehicle_info not empty
        if (rest.vehicle_info && !rest.vehicle_info.type && !rest.vehicle_info.registration && !rest.vehicle_info.aircraft_type) {
          rest.vehicle_info = { type: null };
        }
        return rest;
      });

      const metadata = analyzeDepartures(departures);
      const attributions = ['Flight departure data is sourced from <a style="color: var(--color-ts-accent);" href="https://skylinkapi.com" target="_blank" rel="noopener noreferrer">SkyLink API</a>'];

      // Preserve debug behaviour: expose raw SkyLink response when debug enabled
      const debugRes = debug ? rawData : undefined;

      return NextResponse.json({ metadata, attributions, departures, debugRes });
    }

    log(`Invalid type requested: ${type}`);
    return NextResponse.json({ error: 'Invalid type. Use "bus" or "train" or "flight".' }, { status: 400 });

  } catch (error: any) {
    log(`Caught error: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
});
