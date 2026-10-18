import type { AppConfig } from "../config.js";
import { calendarDate, normalizeTime } from "../time.js";
import { gocourtRoutes } from "./routes.js";
import type {
  BookingRecord,
  BookingRules,
  BookingSearch,
  ClubSummary,
  GoCourtClient,
  ManualBookingInput,
  ManualBookingResult,
  OperatingHours,
  PricingRule,
  ScheduleCourt,
} from "./types.js";
import { GoCourtApiError } from "./types.js";

type Json = Record<string, unknown>;

/**
 * Calls the live GoCourt API as the club-owner account.
 *
 * The JWT is cached on this client only, and refreshed shortly before `exp`
 * or once after a 401. On Vercel the client is created once per function
 * instance: a warm instance reuses the token, and a new instance has none, so
 * the next call signs in. Do not assume the cache survives between invocations.
 */
export function createHttpClient(config: AppConfig, fetchImpl: typeof fetch = fetch): GoCourtClient {
  if (!config.gocourtApiBaseUrl) {
    throw new GoCourtApiError("GOCOURT_API_BASE_URL is not set", 500);
  }

  let token: string | null = null;
  let expMs = 0;
  let staticRemaining = Boolean(config.ownerToken);
  let loginInflight: Promise<string> | null = null;
  /** Club pricing rules change rarely. Keep them for one tool turn, not the whole process. */
  const pricingCache = new Map<number, { expiresAt: number; rules: PricingRule[] }>();
  const pricingInflight = new Map<number, Promise<PricingRule[]>>();
  const pricingCacheMs = 15_000;

  async function getToken(forceLogin = false): Promise<string> {
    if (!forceLogin && token && Date.now() < expMs - 60_000) return token;
    if (!forceLogin && staticRemaining && config.ownerToken) {
      staticRemaining = false;
      token = config.ownerToken;
      expMs = jwtExpiryMs(config.ownerToken);
      return token;
    }
    if (!loginInflight) {
      loginInflight = login().finally(() => {
        loginInflight = null;
      });
    }
    return loginInflight;
  }

  async function login(): Promise<string> {
    if (!config.ownerEmail || !config.ownerPassword) {
      throw new GoCourtApiError(
        "GoCourt owner email and password are required (or set GOCOURT_OWNER_TOKEN)",
        401,
      );
    }
    const response = await call(`${config.gocourtApiBaseUrl}${gocourtRoutes.login}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "gocourt-voice-agent",
        ...config.loginHeaders,
      },
      body: JSON.stringify({ email: config.ownerEmail, password: config.ownerPassword }),
    });
    const body = asObject(await readJson(response));
    if (!response.ok) {
      throw new GoCourtApiError(errorMessage(body, "Login failed"), response.status);
    }
    const issued = typeof body.token === "string" ? body.token : "";
    if (!issued) {
      throw new GoCourtApiError(
        "GoCourt login did not return a bearer token. Check the account and GOCOURT_LOGIN_HEADERS.",
        500,
      );
    }
    token = issued;
    expMs = jwtExpiryMs(issued);
    return issued;
  }

  async function request(method: string, path: string, opts: { query?: Record<string, string>; body?: Json; auth?: boolean } = {}): Promise<Json | unknown[]> {
    const url = new URL(`${config.gocourtApiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    const send = async (allowRetry: boolean): Promise<Response> => {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "gocourt-voice-agent",
      };
      if (opts.body) headers["Content-Type"] = "application/json";
      if (opts.auth !== false) headers.Authorization = `Bearer ${await getToken(false)}`;
      const response = await call(url, {
        method,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (response.status === 401 && allowRetry && opts.auth !== false && (config.ownerEmail || config.ownerPassword)) {
        token = null;
        expMs = 0;
        staticRemaining = false;
        await getToken(true);
        return send(false);
      }
      return response;
    };

    const response = await send(true);
    const payload = await readJson(response);
    if (!response.ok) {
      const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Json) : {};
      throw new GoCourtApiError(errorMessage(record, `GoCourt returned ${response.status}`), response.status, stringField(record, "code"));
    }
    return payload;
  }

  async function call(url: string | URL, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(config.requestTimeoutMs) });
    } catch (error) {
      if (!isTimeoutError(error)) throw error;
      throw new GoCourtApiError(`GoCourt did not respond within ${config.requestTimeoutMs}ms`, 504);
    }
  }

  async function loadPricingRules(clubId: number): Promise<PricingRule[]> {
    const payload = await request("GET", gocourtRoutes.pricingRules(clubId));
    const rows = Array.isArray(payload) ? asArray(payload) : asArray(asObject(payload).rules as Json | unknown[]);
    return rows.map(mapPricingRule).filter((rule) => rule.startTime && rule.endTime);
  }

  return {
    async getMyClubs() {
      const rows = asArray(await request("GET", gocourtRoutes.myClubs));
      return rows.map((row) => ({
        id: numberField(row, "id"),
        name: stringField(row, "name") || `Club ${numberField(row, "id")}`,
      }));
    },
    async getOperatingHours(clubId, date) {
      const row = asObject(await request("GET", gocourtRoutes.operatingHours(clubId, date)));
      return {
        isClosed: Boolean(row.is_closed),
        openTime: normalizeTime(row.open_time) ?? "09:00",
        closeTime: normalizeTime(row.close_time) ?? "23:00",
        reason: stringField(row, "reason") || undefined,
      };
    },
    async getBookingRules(clubId) {
      const row = asObject(await request("GET", gocourtRoutes.bookingRules(clubId), { auth: false }));
      const step = row.new_booking_step_minutes;
      return {
        minDurationHours: numberOr(row.min_booking_duration, 0.5),
        maxDurationHours: row.max_booking_duration == null ? null : numberOr(row.max_booking_duration, 0),
        incrementHours: numberOr(row.booking_increment, 0.5),
        ownerStepMinutes: typeof step === "number" && step > 0 ? step : null,
        advanceBookingDays: numberOr(row.advance_booking_days, 0),
      } satisfies BookingRules;
    },
    async getSchedule(clubId, date) {
      const rows = asArray(await request("GET", gocourtRoutes.schedule(clubId), { query: { date } }));
      return rows.map(mapCourt);
    },
    async getPricingRules(clubId) {
      const hit = pricingCache.get(clubId);
      if (hit && hit.expiresAt > Date.now()) return hit.rules;
      const pending = pricingInflight.get(clubId);
      if (pending) return pending;
      const loading = loadPricingRules(clubId)
        .then((rules) => {
          pricingCache.set(clubId, { expiresAt: Date.now() + pricingCacheMs, rules });
          return rules;
        })
        .finally(() => {
          pricingInflight.delete(clubId);
        });
      pricingInflight.set(clubId, loading);
      return loading;
    },
    async listBookings(clubId, query: BookingSearch) {
      const params: Record<string, string> = {};
      if (query.q) params.q = query.q;
      if (query.from) params.from = query.from;
      if (query.to) params.to = query.to;
      if (query.limit) params.limit = String(query.limit);
      const rows = asArray(await request("GET", gocourtRoutes.clubBookings(clubId), { query: params }));
      return rows.map((row) => mapBooking(row, config.timeZone));
    },
    async createManualBooking(_clubId, input: ManualBookingInput): Promise<ManualBookingResult> {
      const row = asObject(
        await request("POST", gocourtRoutes.manualBooking, {
          body: {
            court_id: input.courtId,
            booking_date: input.date,
            start_time: input.startTime,
            end_time: input.endTime,
            customer_name: input.customerName,
            customer_phone: input.customerPhone,
          },
        }),
      );
      const booking = row.booking && typeof row.booking === "object" ? (row.booking as Json) : row;
      return { booking: mapBooking(booking, config.timeZone) };
    },
    async cancelBooking(clubId, bookingId) {
      const row = asObject(await request("DELETE", gocourtRoutes.cancelClubBooking(clubId, bookingId)));
      const booking = row.booking && typeof row.booking === "object" ? (row.booking as Json) : row;
      return mapBooking(booking, config.timeZone);
    },
  };
}

function mapCourt(row: Json): ScheduleCourt {
  const bookings = Array.isArray(row.bookings) ? row.bookings : [];
  return {
    id: numberField(row, "id"),
    name: stringField(row, "name") || `Court ${stringField(row, "court_number") || numberField(row, "id")}`,
    courtNumber: row.court_number == null ? null : numberField(row, "court_number"),
    courtType: stringField(row, "court_type") || null,
    coverage: stringField(row, "coverage_type") || null,
    sportName: stringField(row, "sport_name") || null,
    sportId: row.sport_id == null || row.sport_id === "" ? null : numberField(row, "sport_id"),
    pricePerHour: optionalPrice(row.price_per_hour),
    bookings: bookings
      .filter((item): item is Json => Boolean(item) && typeof item === "object")
      .map((item) => ({
        id: numberField(item, "id"),
        startTime: normalizeTime(item.start_time) ?? "00:00",
        endTime: normalizeTime(item.end_time) ?? "00:00",
        status: stringField(item, "status") || "confirmed",
      })),
  };
}

function mapPricingRule(row: Json): PricingRule {
  return {
    id: numberField(row, "id"),
    name: stringField(row, "name"),
    isBasic: row.is_basic === true,
    isActive: row.is_active !== false,
    dayType: stringField(row, "day_type") || null,
    daysOfWeek: daysOfWeek(row.days_of_week),
    startTime: normalizeTime(row.start_time) ?? "",
    endTime: normalizeTime(row.end_time) ?? "",
    pricePerHour: optionalPrice(row.price_per_hour),
    priceMultiplier: numberOr(row.price_multiplier, 1),
    priority: numberOr(row.priority, 0),
    courtId: row.court_id == null || row.court_id === "" ? null : numberField(row, "court_id"),
    courtType: stringField(row, "court_type") || null,
    sportId: row.sport_id == null || row.sport_id === "" ? null : numberField(row, "sport_id"),
  };
}

function mapBooking(row: Json, timeZone: string): BookingRecord {
  const name = stringField(row, "customer_name") || stringField(row, "user_name");
  return {
    id: numberField(row, "id"),
    courtId: numberField(row, "court_id"),
    courtName: stringField(row, "court_name") || `Court ${numberField(row, "court_id")}`,
    date: calendarDate(row.booking_date, timeZone),
    startTime: normalizeTime(row.start_time) ?? "00:00",
    endTime: normalizeTime(row.end_time) ?? "00:00",
    status: stringField(row, "status") || "confirmed",
    customerName: name,
    customerPhone: stringField(row, "customer_phone"),
    priceEuros: row.total_price == null ? null : numberOr(row.total_price, 0),
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const name = String(error.name);
  return name === "TimeoutError" || name === "AbortError";
}

function jwtExpiryMs(token: string): number {
  const part = token.split(".")[1];
  if (!part) return Date.now() + 6 * 24 * 60 * 60 * 1000;
  try {
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    if (typeof json.exp === "number") return json.exp * 1000;
  } catch {
    // A non-JWT token is kept for six days, then we log in again.
  }
  return Date.now() + 6 * 24 * 60 * 60 * 1000;
}

async function readJson(response: Response): Promise<Json | unknown[]> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Json | unknown[];
  } catch {
    return { error: text.slice(0, 200) };
  }
}

function asObject(value: Json | unknown[]): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function asArray(value: Json | unknown[]): Json[] {
  if (Array.isArray(value)) return value.filter((item): item is Json => Boolean(item) && typeof item === "object");
  return [];
}

function stringField(row: Json, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function numberField(row: Json, key: string): number {
  return numberOr(row[key], 0);
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** A missing price stays missing. A numeric zero is kept and treated as unknown later. */
function optionalPrice(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = numberOr(value, NaN);
  return Number.isFinite(n) ? n : null;
}

function daysOfWeek(value: unknown): string | null {
  if (Array.isArray(value)) {
    const days = value.map((day) => String(day).trim()).filter(Boolean);
    return days.length ? days.join(",") : null;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function errorMessage(body: Json, fallback: string): string {
  return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
}
