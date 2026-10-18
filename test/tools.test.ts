import assert from "node:assert/strict";
import test from "node:test";
import { createMockClient } from "../src/gocourt/mock.js";
import { GoCourtApiError, type BookingRecord, type GoCourtClient, type PricingRule } from "../src/gocourt/types.js";
import { cancelBooking, checkAvailability, createBooking, findBooking } from "../src/tools/handlers.js";

const NOW = new Date("2026-10-12T09:00:00+03:00");
const ctx = { now: NOW, timeZone: "Europe/Athens", clubId: null as number | null };

test("a free hour confirms the time without naming courts", async () => {
  const client = createMockClient({ now: NOW });
  const result = await checkAvailability(client, { date: "tomorrow", time: "18:00" }, ctx);
  assert.equal(result.available, true);
  assert.equal(result.needs_confirmation, true);
  assert.equal(result.date, "2026-10-13");
  assert.equal(result.start_time, "18:00");
  assert.equal(result.end_time, "19:00");
  const courts = result.courts as Array<{ name: string }>;
  assert.equal(courts.length, 2);
  assert.match(String(result.say), /Shall I book it/);
  assert.doesNotMatch(String(result.say), /Court|phone/i);
});

test("a taken slot suggests the nearest free times and does not name courts or other players", async () => {
  const client = createMockClient({ now: NOW });
  const result = await checkAvailability(client, { date: "2026-10-13", time: "19:00", duration_minutes: 60 }, ctx);
  assert.equal(result.available, false);
  const suggestions = result.suggestions as Array<{ start_time: string; court_name: string }>;
  assert.ok(suggestions.length >= 2);
  assert.equal(suggestions[0]?.start_time, "18:00");
  assert.equal(suggestions[1]?.start_time, "20:00");
  assert.equal(suggestions[1]?.court_name, "Court 1");
  assert.doesNotMatch(String(result.say), /Maria|Nikos|Court/);
});

test("a named court that is taken keeps the time and does not name the other court", async () => {
  const client = createMockClient({ now: NOW });
  const result = await checkAvailability(client, { date: "tomorrow", time: "10:00", court: "Court 1" }, ctx);
  assert.equal(result.available, true);
  const courts = result.courts as Array<{ name: string }>;
  assert.equal(courts[0]?.name, "Court 2");
  assert.match(String(result.say), /Court 1 is taken then/);
  assert.match(String(result.say), /still free/);
  assert.doesNotMatch(String(result.say), /Court 2/);
});

test("ambiguous times and periods ask instead of guessing", async () => {
  const client = createMockClient({ now: NOW });
  const hour = await checkAvailability(client, { date: "tomorrow", time: "7" }, ctx);
  assert.equal(hour.needs_clarification, true);
  assert.match(String(hour.say), /morning or/);
  const evening = await checkAvailability(client, { date: "tomorrow evening" }, ctx);
  assert.equal(evening.needs_clarification, true);
  assert.match(String(evening.say), /Which hour/);
  const resolved = await checkAvailability(client, { date: "tomorrow", time: "7", time_of_day: "evening" }, ctx);
  assert.equal(resolved.start_time, "19:00");
});

test("a time that has already passed is refused", async () => {
  const client = createMockClient({ now: NOW });
  const result = await checkAvailability(client, { date: "today", time: "08:00" }, ctx);
  assert.equal(result.available, false);
  assert.match(String(result.say), /already passed/);
});

test("create_booking does not book until confirmed, then returns a booking number", async () => {
  const client = createMockClient({ now: NOW });
  const preview = await createBooking(
    client,
    { date: "tomorrow", time: "18:00", customer_name: "Eleni Costa", customer_phone: "694 123 4567" },
    ctx,
  );
  assert.equal(preview.needs_confirmation, true);
  assert.equal(preview.booked, undefined);
  assert.match(String(preview.say), /Eleni Costa/);
  assert.match(String(preview.say), /Shall I book it/);
  assert.doesNotMatch(String(preview.say), /694|phone|Court/i);
  assert.equal(client.snapshot().length, 4);

  const booked = await createBooking(
    client,
    {
      date: "tomorrow",
      time: "18:00",
      customer_name: "Eleni Costa",
      customer_phone: "694 123 4567",
      confirmed: true,
    },
    ctx,
  );
  assert.equal(booked.booked, true);
  const booking = booked.booking as { id: number; customer_name: string; start_time: string };
  assert.equal(booking.customer_name, "Eleni Costa");
  assert.equal(booking.start_time, "18:00");
  assert.ok(booking.id >= 2000);
  assert.match(String(booked.say), /booking number/);
  assert.doesNotMatch(String(booked.say), /694|Court|price/i);
  assert.equal(client.snapshot().filter((item) => item.status === "confirmed").length, 5);
});

test("create_booking will not double-book a taken slot", async () => {
  const client = createMockClient({ now: NOW });
  const result = await createBooking(
    client,
    {
      date: "tomorrow",
      time: "19:00",
      customer_name: "Eleni Costa",
      customer_phone: "694 123 4567",
      confirmed: true,
    },
    ctx,
  );
  assert.equal(result.available, false);
  assert.equal(result.booked, undefined);
  assert.equal(client.snapshot().length, 4);
});

test("find and cancel need a confirmation step and a unique match", async () => {
  const client = createMockClient({ now: NOW });
  const missing = await cancelBooking(client, {}, ctx);
  assert.equal(missing.needs_clarification, true);

  const ambiguous = await findBooking(client, { customer_name: "Nikos Alexiou" }, ctx);
  const matches = ambiguous.matches as Array<{ id: number }>;
  assert.equal(matches.length, 2);

  const many = await cancelBooking(client, { customer_name: "Nikos", customer_phone: "6945551212" }, ctx);
  assert.equal(many.needs_clarification, true);
  assert.doesNotMatch(String(many.say), /Court|694/);
  assert.notEqual(client.snapshot().find((item) => item.id === 1003)?.status, "cancelled");

  const preview = await cancelBooking(client, { booking_id: "GC-1003" }, ctx);
  assert.equal(preview.needs_confirmation, true);
  assert.match(String(preview.say), /Shall I cancel it/);
  assert.doesNotMatch(String(preview.say), /Court|694/);

  const cancelled = await cancelBooking(client, { booking_id: 1003, confirmed: "yes" }, ctx);
  assert.equal(cancelled.cancelled, true);
  assert.doesNotMatch(String(cancelled.say), /694/);
  assert.match(String((cancelled.booking as { customer_phone: string }).customer_phone), /694/);
  assert.equal(client.snapshot().find((item) => item.id === 1003)?.status, "cancelled");

  const found = await findBooking(client, { customer_phone: "694 555 1212" }, ctx);
  assert.match(String(found.say), /Nikos Alexiou/);
  assert.doesNotMatch(String(found.say), /694/);
  const listed = found.matches as Array<{ customer_phone: string }>;
  assert.ok(listed.every((item) => /694/.test(item.customer_phone)));
});

test("two bookings at the same time are told apart by court", async () => {
  const client = createMockClient({ now: NOW });
  const booked = await createBooking(
    client,
    {
      date: "tomorrow",
      time: "10:00",
      customer_name: "Nikos Alexiou",
      customer_phone: "694 555 1212",
      confirmed: true,
    },
    ctx,
  );
  assert.equal(booked.booked, true);
  assert.doesNotMatch(String(booked.say), /Court/);
  const found = await findBooking(client, { customer_name: "Nikos Alexiou", date: "tomorrow" }, ctx);
  const matches = found.matches as Array<{ id: number }>;
  assert.equal(matches.length, 2);
  assert.match(String(found.say), /Court 1/);
  assert.match(String(found.say), /Court 2/);
});

test("cancel keeps the display name on the booking and does not speak it", async () => {
  const record: BookingRecord = {
    id: 55,
    courtId: 17,
    courtName: "Court 17",
    date: "2026-10-13",
    startTime: "18:00",
    endTime: "19:00",
    status: "confirmed",
    customerName: "Eleni Costa",
    customerPhone: "694 123 4567",
    priceEuros: 20,
  };
  const client = {
    async getMyClubs() {
      return [{ id: 1, name: "Demo Padel Club" }];
    },
    async listBookings() {
      return [{ ...record }];
    },
    async getSchedule() {
      return [
        {
          id: 17,
          name: "Court 1",
          courtNumber: 1,
          courtType: "Doubles",
          coverage: "Outdoor",
          sportName: "Padel",
          pricePerHour: 20,
          bookings: [],
        },
      ];
    },
    async cancelBooking() {
      return { ...record, status: "cancelled", courtName: "Court 17" };
    },
  } as unknown as GoCourtClient;

  const preview = await cancelBooking(client, { booking_id: 55 }, ctx);
  assert.equal(preview.needs_confirmation, true);
  assert.doesNotMatch(String(preview.say), /Court/);
  assert.equal((preview.booking as { court_name: string }).court_name, "Court 1");

  const done = await cancelBooking(client, { booking_id: 55, confirmed: true }, ctx);
  assert.equal(done.cancelled, true);
  assert.doesNotMatch(String(done.say), /Court/);
  assert.equal((done.booking as { court_name: string }).court_name, "Court 1");
});

test("several clubs ask which club instead of guessing", async () => {
  const client = createMockClient({ now: NOW, extraClub: true });
  const result = await checkAvailability(client, { date: "tomorrow", time: "18:00" }, ctx);
  assert.equal(result.needs_clarification, true);
  assert.match(String(result.say), /Which club/);
});

const basicRule: PricingRule = {
  id: 1,
  name: "Basic Price",
  isBasic: true,
  isActive: true,
  dayType: "all",
  daysOfWeek: null,
  startTime: "00:00",
  endTime: "23:59",
  pricePerHour: 40,
  priceMultiplier: 1,
  priority: 9999,
  courtId: null,
  courtType: null,
  sportId: null,
};

test("a court with no hourly price is quoted from the basic pricing rule", async () => {
  const client = createMockClient({ now: NOW, courtPricePerHour: null, pricingRules: [basicRule] });
  const result = await checkAvailability(client, { date: "2026-10-18", time: "19:00", duration_minutes: 60 }, ctx);
  assert.equal(result.available, true);
  assert.equal(result.price_euros, 40);
  assert.match(String(result.say), /about 40 euros/);
  assert.doesNotMatch(String(result.say), /about 0 euros/);

  const unknown = createMockClient({ now: NOW, courtPricePerHour: null });
  const quiet = await checkAvailability(unknown, { date: "2026-10-18", time: "19:00" }, ctx);
  assert.equal(quiet.price_euros, null);
  assert.match(String(quiet.say), /Shall I book it/);
  assert.doesNotMatch(String(quiet.say), /euro/i);
});

test("create_booking keeps a real total and treats 0 as an unknown price", async () => {
  const priced = createMockClient({
    now: NOW,
    courtPricePerHour: null,
    pricingRules: [basicRule],
    bookingPriceEuros: 80,
  });
  const booked = await createBooking(
    priced,
    {
      date: "2026-10-18",
      time: "19:00",
      customer_name: "Eleni Costa",
      customer_phone: "694 123 4567",
      confirmed: true,
    },
    ctx,
  );
  assert.equal(booked.booked, true);
  assert.equal((booked.booking as { price_euros: number }).price_euros, 80);
  assert.doesNotMatch(String(booked.say), /euro/i);

  const zero = createMockClient({
    now: NOW,
    courtPricePerHour: null,
    pricingRules: [basicRule],
    bookingPriceEuros: 0,
  });
  const fallback = await createBooking(
    zero,
    {
      date: "2026-10-18",
      time: "19:00",
      duration_minutes: 60,
      customer_name: "Eleni Costa",
      customer_phone: "694 123 4567",
      confirmed: true,
    },
    ctx,
  );
  assert.equal((fallback.booking as { price_euros: number }).price_euros, 40);
});

test("a GoCourt timeout is spoken as a retry", async () => {
  const client = {
    getMyClubs: async () => {
      throw new GoCourtApiError("GoCourt did not respond within 25000ms", 504);
    },
  } as unknown as GoCourtClient;
  const result = await checkAvailability(client, { date: "tomorrow", time: "18:00" }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.say), /taking too long/);
});
