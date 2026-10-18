import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createHttpClient } from "../src/gocourt/httpClient.js";
import { GoCourtApiError } from "../src/gocourt/types.js";
import { createMockClient } from "../src/gocourt/mock.js";
import { createApp } from "../src/http/app.js";
import { addDays, todayIso } from "../src/time.js";

const secret = "test-shared-secret";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    mock: true,
    toolSharedSecret: secret,
    toolSecretHeader: "x-tool-secret",
    gocourtApiBaseUrl: "",
    ownerEmail: "",
    ownerPassword: "",
    ownerToken: "",
    clubId: null,
    timeZone: "Europe/Athens",
    elevenLabsAgentId: "",
    publicBaseUrl: "",
    requestTimeoutMs: 25_000,
    loginHeaders: {},
    ...overrides,
  };
}

function laterCallsSkipLoginHeaders(calls: { path: string; headers: Headers }[]): boolean {
  return calls.filter((call) => call.path !== "/api/auth/login").every((call) => !call.headers.get("x-client"));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

test("loadConfig gives each GoCourt call 25 seconds unless overridden", () => {
  assert.equal(loadConfig({}).requestTimeoutMs, 25_000);
  assert.deepEqual(loadConfig({}).loginHeaders, {});
  assert.deepEqual(loadConfig({ GOCOURT_LOGIN_HEADERS: '{"X-Client":"app","n":1}' }).loginHeaders, { "X-Client": "app" });
  assert.deepEqual(loadConfig({ GOCOURT_LOGIN_HEADERS: "not json" }).loginHeaders, {});
  assert.equal(loadConfig({ GOCOURT_REQUEST_TIMEOUT_MS: "40000" }).requestTimeoutMs, 40_000);
  assert.equal(loadConfig({ GOCOURT_REQUEST_TIMEOUT_MS: "25" }).requestTimeoutMs, 25_000);
});

test("the demo page fills in the agent id", async () => {
  const app = createApp(
    config({ elevenLabsAgentId: "agent_test" }),
    createMockClient({ now: new Date("2026-10-12T09:00:00+03:00") }),
  );
  const server = createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Book a court at ElevenLabs Padel Club/);
    assert.match(html, /id="call"[\s\S]*?\bCall\b/);
    assert.match(html, /id="chat"[\s\S]*?\bChat\b/);
    assert.match(html, /agent-id/);
    assert.match(html, /override-text-only/);
    assert.match(html, /agent_test/);
    assert.doesNotMatch(html, /<elevenlabs-convai/);
    assert.doesNotMatch(html, /__ELEVENLABS_AGENT_ID__/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("tool routes reject a missing or wrong shared secret", async () => {
  const app = createApp(config(), createMockClient({ now: new Date("2026-10-12T09:00:00+03:00") }));
  const server = createServer(app);
  const port = await listen(server);
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/tools/check_availability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/tools/check_availability`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tool-secret": "nope" },
      body: JSON.stringify({ date: "tomorrow", time: "18:00" }),
    });
    assert.equal(wrong.status, 401);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal((await health.json()).mock, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a tool call with the secret reaches the mock and accepts a parameters wrapper", async () => {
  const now = new Date();
  const app = createApp(config(), createMockClient({ now }));
  const server = createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/tools/check_availability`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tool-Secret": secret },
      body: JSON.stringify({ parameters: { date: "tomorrow", time: "18:00" } }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.available, true);
    assert.equal(body.date, addDays(todayIso(now, "Europe/Athens"), 1));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("the live client logs in once, caches the JWT, and posts a manual booking", async () => {
  const calls: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
  let logins = 0;
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://gocourt.test");
    calls.push({
      method: req.method ?? "",
      path: url.pathname,
      headers: new Headers(req.headers as HeadersInit),
      body: raw ? JSON.parse(raw) : null,
    });
    if (url.pathname === "/api/auth/login") {
      logins += 1;
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, id: 7 })).toString("base64url");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`, user: { id: 7, role: "club_owner" } }));
      return;
    }
    if (!String(req.headers.authorization ?? "").startsWith("Bearer eyJ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Access token required" }));
      return;
    }
    if (url.pathname === "/api/clubs/my/clubs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: 4, name: "Club", owner_email: "hidden@example.com" }]));
      return;
    }
    if (url.pathname === "/api/bookings/manual") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          booking: {
            id: 55,
            court_id: 3,
            booking_date: "2026-10-13",
            start_time: "18:00:00",
            end_time: "19:00:00",
            status: "confirmed",
            customer_name: "Eleni Costa",
            customer_phone: "694 123 4567",
            total_price: "20.00",
            court_name: "Court 1",
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no" }));
  });
  const port = await listen(fake);
  try {
    const client = createHttpClient(
      config({
        mock: false,
        gocourtApiBaseUrl: `http://127.0.0.1:${port}/api`,
        ownerEmail: "owner@example.com",
        ownerPassword: "not-a-real-password",
        loginHeaders: { "X-Client": "voice-agent" },
      }),
    );
    const clubs = await client.getMyClubs();
    await client.getMyClubs();
    const created = await client.createManualBooking(4, {
      courtId: 3,
      date: "2026-10-13",
      startTime: "18:00",
      endTime: "19:00",
      customerName: "Eleni Costa",
      customerPhone: "694 123 4567",
    });
    assert.equal(logins, 1);
    assert.deepEqual(clubs, [{ id: 4, name: "Club" }]);
    assert.equal(created.booking.id, 55);
    assert.equal(created.booking.startTime, "18:00");
    const login = calls.find((call) => call.path === "/api/auth/login");
    assert.equal(login?.headers.get("x-client"), "voice-agent");
    assert.ok(laterCallsSkipLoginHeaders(calls));
    const later = calls.filter((call) => call.path !== "/api/auth/login");
    assert.ok(later.every((call) => call.headers.get("authorization")?.startsWith("Bearer ")));
    assert.ok(later.every((call) => !call.headers.get("origin")));
    const manual = calls.find((call) => call.path === "/api/bookings/manual");
    const fresh = createHttpClient(
      config({
        mock: false,
        gocourtApiBaseUrl: `http://127.0.0.1:${port}/api`,
        ownerEmail: "owner@example.com",
        ownerPassword: "not-a-real-password",
      }),
    );
    await fresh.getMyClubs();
    await client.getMyClubs();
    assert.equal(logins, 2);
    assert.deepEqual(manual?.body, {
      court_id: 3,
      booking_date: "2026-10-13",
      start_time: "18:00",
      end_time: "19:00",
      customer_name: "Eleni Costa",
      customer_phone: "694 123 4567",
    });
  } finally {
    await new Promise<void>((resolve, reject) => fake.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a null court price stays null and pricing rules are cached for the request", async () => {
  let ruleCalls = 0;
  const fake = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gocourt.test");
    if (!String(req.headers.authorization ?? "").startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Access token required" }));
      return;
    }
    if (url.pathname === "/api/clubs/11/availability") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            id: 7,
            name: "Court 1",
            court_number: 1,
            court_type: "Doubles",
            coverage_type: "Outdoor",
            sport_name: "Padel",
            sport_id: 3,
            price_per_hour: null,
            bookings: [],
          },
        ]),
      );
      return;
    }
    if (url.pathname === "/api/clubs/11/pricing-rules") {
      ruleCalls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          rules: [
            {
              id: 9,
              name: "Basic Price",
              is_basic: true,
              is_active: true,
              day_type: "all",
              days_of_week: null,
              start_time: "00:00:00",
              end_time: "23:59:00",
              price_per_hour: "40.00",
              price_multiplier: "1.00",
              priority: 9999,
              court_id: null,
              court_type: null,
              sport_id: null,
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no" }));
  });
  const port = await listen(fake);
  try {
    const client = createHttpClient(
      config({
        mock: false,
        gocourtApiBaseUrl: `http://127.0.0.1:${port}/api`,
        ownerToken: "static-owner-token",
      }),
    );
    const courts = await client.getSchedule(11, "2026-10-18");
    assert.equal(courts[0]?.pricePerHour, null);
    assert.equal(courts[0]?.sportId, 3);
    const first = await client.getPricingRules(11);
    const second = await client.getPricingRules(11);
    assert.equal(ruleCalls, 1);
    assert.equal(first[0]?.name, "Basic Price");
    assert.equal(first[0]?.pricePerHour, 40);
    assert.equal(first[0]?.priority, 9999);
    assert.equal(first[0]?.isBasic, true);
    assert.equal(second, first);
  } finally {
    await new Promise<void>((resolve, reject) => fake.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a silent GoCourt API is aborted at the request timeout", async () => {
  const server = createServer(() => {});
  const port = await listen(server);
  try {
    const client = createHttpClient(
      config({
        mock: false,
        gocourtApiBaseUrl: `http://127.0.0.1:${port}/api`,
        ownerEmail: "owner@example.com",
        ownerPassword: "not-a-real-password",
        requestTimeoutMs: 80,
      }),
    );
    await assert.rejects(client.getMyClubs(), (error: unknown) => {
      assert.ok(error instanceof GoCourtApiError);
      assert.equal(error.status, 504);
      assert.match(error.message, /80ms/);
      return true;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
