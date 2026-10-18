export type AppConfig = {
  port: number;
  mock: boolean;
  toolSharedSecret: string;
  toolSecretHeader: string;
  gocourtApiBaseUrl: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerToken: string;
  clubId: number | null;
  timeZone: string;
  elevenLabsAgentId: string;
  publicBaseUrl: string;
  /** Abort one GoCourt HTTP call after this many milliseconds. */
  requestTimeoutMs: number;
  /** Extra headers sent with the login request only (GOCOURT_LOGIN_HEADERS, a JSON object). */
  loginHeaders: Record<string, string>;
};

/**
 * One GoCourt call. A cold-starting API host may be slow; 25s is long
 * enough for a short wake and still leaves room inside the 60s Vercel function
 * and ElevenLabs' 60s tool budget for the calls that follow a login.
 */
export const DEFAULT_GOCOURT_TIMEOUT_MS = 25_000;
const MIN_GOCOURT_TIMEOUT_MS = 1_000;
const MAX_GOCOURT_TIMEOUT_MS = 50_000;

function flag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export function parseTimeoutMs(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isInteger(n) || n < MIN_GOCOURT_TIMEOUT_MS || n > MAX_GOCOURT_TIMEOUT_MS) {
    return DEFAULT_GOCOURT_TIMEOUT_MS;
  }
  return n;
}

/** Ensure the GoCourt base URL ends in `/api`, matching the website client. */
export function normalizeApiBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

/** Parse GOCOURT_LOGIN_HEADERS: a JSON object of string header values. Anything else is ignored. */
export function parseLoginHeaders(raw: string | undefined): Record<string, string> {
  const text = (raw ?? "").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const clubRaw = (env.GOCOURT_CLUB_ID ?? "").trim();
  const clubId = clubRaw ? Number(clubRaw) : null;
  return {
    port: Number(env.PORT) || 8787,
    mock: flag(env.GOCOURT_MOCK),
    toolSharedSecret: (env.TOOL_SHARED_SECRET ?? "").trim(),
    toolSecretHeader: (env.TOOL_SECRET_HEADER ?? "x-tool-secret").trim().toLowerCase(),
    gocourtApiBaseUrl: normalizeApiBase(env.GOCOURT_API_BASE_URL ?? ""),
    ownerEmail: (env.GOCOURT_OWNER_EMAIL ?? "").trim(),
    ownerPassword: env.GOCOURT_OWNER_PASSWORD ?? "",
    ownerToken: (env.GOCOURT_OWNER_TOKEN ?? "").trim(),
    clubId: clubId !== null && Number.isInteger(clubId) && clubId > 0 ? clubId : null,
    timeZone: (env.GOCOURT_TIMEZONE ?? "Europe/Athens").trim() || "Europe/Athens",
    elevenLabsAgentId: (env.ELEVENLABS_AGENT_ID ?? "").trim(),
    publicBaseUrl: (env.TOOL_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    requestTimeoutMs: parseTimeoutMs(env.GOCOURT_REQUEST_TIMEOUT_MS),
    loginHeaders: parseLoginHeaders(env.GOCOURT_LOGIN_HEADERS),
  };
}
